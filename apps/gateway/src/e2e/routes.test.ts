import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const key = (n: number) => Buffer.alloc(32, n).toString('base64url');
const devId = (c: string) => `dev_${c.repeat(20)}`;
const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function start(env: Record<string, string> = FLAG_ON, extra = {}) {
  gateway = await startConnectorGateway({ env, ...extra });
  return gateway;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function offer(g: ConnectorGateway, token: string, connectorKey = key(1)) {
  return g.send('POST', '/v1/e2e/pairings', {
    headers: bearer(token),
    body: { connector_public_key: connectorKey, connector_device_id: devId('c') },
  });
}

const claimBody = (offerId: string, n = 2, id = devId('p')) => ({
  offer_id: offerId,
  phone_device_id: id,
  phone_public_key: key(n),
  phone_name: 'Pixel',
  mac: 'm',
});

describe('private chat pairing routes', () => {
  it('pairs a phone and a computer once', async () => {
    const g = await start();
    const { token } = await g.pair('u1');
    const created = await offer(g, token);
    expect(created.statusCode).toBe(200);
    const offerId = created.json<{ offer_id: string }>().offer_id;
    const claim = claimBody(offerId);
    const first = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claim,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      connector_public_key: key(1),
      connector_device_id: devId('c'),
    });
    const again = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claim,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('offer_claimed');

    const polled = await g.send('GET', `/v1/e2e/pairings/${offerId}?wait=0`, {
      headers: bearer(token),
    });
    expect(polled.json()).toMatchObject({ phone_device_id: devId('p'), mac: 'm' });

    const added = await g.send('POST', '/v1/e2e/computer/devices', {
      headers: bearer(token),
      body: { offer_id: offerId },
    });
    expect(added.statusCode).toBe(200);
    const list = await g.send('GET', '/v1/e2e/devices', { user: 'u1' });
    expect(list.json<{ devices: { kind: string }[] }>().devices.map((d) => d.kind)).toEqual(
      expect.arrayContaining(['computer', 'phone']),
    );
    const computerList = await g.send('GET', '/v1/e2e/computer/devices', {
      headers: bearer(token),
    });
    expect(computerList.json<{ devices: unknown[] }>().devices).toHaveLength(2);
  });

  it('answers 404 when the flag is off', async () => {
    const g = await start({});
    const { token } = await g.pair('u1');
    expect(
      (await g.send('POST', '/v1/e2e/pairings', { headers: bearer(token), body: {} })).statusCode,
    ).toBe(404);
    expect((await g.send('GET', '/v1/e2e/devices', { user: 'u1' })).statusCode).toBe(404);
  });

  it('answers private_chats_off to an account outside the allowlist', async () => {
    const g = await start({ ...FLAG_ON, PRIVATE_CHATS_USERS: 'owner' });
    const { token } = await g.pair('u1');
    const refused = await offer(g, token);
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('private_chats_off');
    const phone = await g.send('GET', '/v1/e2e/devices', { user: 'u1' });
    expect(phone.json().error.code).toBe('private_chats_off');
    expect((await g.send('GET', '/v1/e2e/devices', { user: 'owner' })).statusCode).toBe(200);
  });

  it('never lets one account claim another account offer', async () => {
    const g = await start();
    const { token } = await g.pair('u1');
    const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
    const stranger = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u2',
      body: claimBody(offerId),
    });
    expect(stranger.statusCode).toBe(404);
    // The real owner can still claim it.
    const owner = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claimBody(offerId),
    });
    expect(owner.statusCode).toBe(200);
    // Another account's computer cannot read the claim or add the devices.
    const other = await g.pair('u2');
    expect(
      (await g.send('GET', `/v1/e2e/pairings/${offerId}`, { headers: bearer(other.token) }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await g.send('POST', '/v1/e2e/computer/devices', {
          headers: bearer(other.token),
          body: { offer_id: offerId },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses a connector without a valid token', async () => {
    const g = await start();
    const res = await g.send('POST', '/v1/e2e/pairings', {
      headers: bearer(`cct_${'A'.repeat(43)}`),
      body: { connector_public_key: key(1), connector_device_id: devId('c') },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('connector_invalid');
  });

  it('refuses an expired offer with offer_expired', async () => {
    const g = await start();
    const { connectorId } = await g.pair('u1');
    const offerId = g.e2e.createOffer('u1', {
      connectorId,
      connectorDeviceId: devId('c'),
      connectorPublicKey: key(1),
      expiresAt: new Date(Date.now() - 1),
    }).id;
    const res = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claimBody(offerId),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('offer_expired');
  });

  it('enforces the device cap of 5 on the server, adding neither device', async () => {
    const g = await start();
    for (let i = 0; i < 4; i++) {
      g.e2e.add('u1', {
        id: devId('efgh'[i]!),
        kind: 'phone',
        name: `Phone ${i}`,
        public_key: key(10 + i),
      });
    }
    const { token } = await g.pair('u1');
    const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
    await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claimBody(offerId),
    });
    const res = await g.send('POST', '/v1/e2e/computer/devices', {
      headers: bearer(token),
      body: { offer_id: offerId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('device_cap');
    expect(g.e2e.list('u1')).toHaveLength(4);
  });

  it('rate limits claims per account', async () => {
    const g = await start(FLAG_ON, { e2eClaimRatePerMinute: 2 });
    const { token } = await g.pair('u1');
    const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
    const wrong = claimBody(offerId);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push(
        (
          await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
            user: 'u1',
            body: { ...wrong, offer_id: 'off_' + 'z'.repeat(20) },
          })
        ).statusCode,
      );
    expect(codes).toEqual([400, 400, 429]);
  });

  it('refuses an oversized body', async () => {
    const g = await start();
    const res = await g.send('POST', `/v1/e2e/pairings/off_${'a'.repeat(20)}/claim`, {
      user: 'u1',
      body: { ...claimBody(`off_${'a'.repeat(20)}`), phone_name: 'x'.repeat(5000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('revokes a device from the phone', async () => {
    const g = await start();
    g.e2e.add('u1', { id: devId('a'), kind: 'phone', name: 'Old', public_key: key(5) });
    expect(
      (await g.send('DELETE', `/v1/e2e/devices/${devId('a')}`, { user: 'u1' })).statusCode,
    ).toBe(204);
    expect(
      (await g.send('DELETE', `/v1/e2e/devices/${devId('a')}`, { user: 'u1' })).statusCode,
    ).toBe(404);
  });

  it('logs ids and counts, never keys or the mac', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    const g = await start(FLAG_ON, { logger: { level: 'info', stream } });
    const { token } = await g.pair('u1');
    const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
    await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: { ...claimBody(offerId), mac: 'SECRETMAC' },
    });
    await g.send('POST', '/v1/e2e/computer/devices', {
      headers: bearer(token),
      body: { offer_id: offerId },
    });
    const all = lines.join('\n');
    expect(all).toContain('e2e_pair_claimed');
    expect(all).not.toContain('SECRETMAC');
    expect(all).not.toContain(key(1));
    expect(all).not.toContain(key(2));
  });
});
