/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
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
    const { token, connectorId } = await g.pair('u1');
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
      connector_id: connectorId,
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

  it('refuses to add devices from an offer that expired after the phone claimed it', async () => {
    const g = await start();
    const { connectorId, token } = await g.pair('u1');
    const offerId = g.e2e.createOffer('u1', {
      connectorId,
      connectorDeviceId: devId('c'),
      connectorPublicKey: key(1),
      expiresAt: new Date(Date.now() - 1),
    }).id;
    const { phone_device_id, phone_public_key, phone_name, mac } = claimBody(offerId);
    const claim = { phone_device_id, phone_public_key, phone_name, mac };
    expect(g.e2e.claimOffer('u1', offerId, claim)).toBe('claimed');
    const res = await g.send('POST', '/v1/e2e/computer/devices', {
      headers: bearer(token),
      body: { offer_id: offerId },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('offer_expired');
    expect(g.e2e.list('u1')).toHaveLength(0);
  });

  it('tells the computer about revoked devices, and the phone only about active ones', async () => {
    const g = await start();
    const { token } = await g.pair('u1');
    const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
    await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
      user: 'u1',
      body: claimBody(offerId),
    });
    await g.send('POST', '/v1/e2e/computer/devices', {
      headers: bearer(token),
      body: { offer_id: offerId },
    });
    const revoked = await g.send('DELETE', `/v1/e2e/devices/${devId('p')}`, { user: 'u1' });
    expect(revoked.statusCode).toBe(204);
    const computer = await g.send('GET', '/v1/e2e/computer/devices', { headers: bearer(token) });
    const devices = computer.json<{ devices: { id: string; revoked_at?: string }[] }>().devices;
    expect(devices.find((d) => d.id === devId('p'))?.revoked_at).toEqual(expect.any(String));
    expect(devices.find((d) => d.id === devId('c'))?.revoked_at).toBeUndefined();
    // The phone hears of the removal too (P4 ruling 3), marked revoked like the computer.
    const phone = await g.send('GET', '/v1/e2e/devices', { user: 'u1' });
    const listed = phone.json<{ devices: { id: string; revoked_at?: string }[] }>().devices;
    expect(listed.filter((d) => d.revoked_at === undefined).map((d) => d.id)).toEqual([
      devId('c'),
    ]);
    expect(listed.find((d) => d.id === devId('p'))?.revoked_at).toEqual(expect.any(String));
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

  describe('typed code', () => {
    const typedOffer = (g: ConnectorGateway, token: string, extra: Record<string, unknown>) =>
      g.send('POST', '/v1/e2e/pairings', {
        headers: bearer(token),
        body: { connector_public_key: key(1), connector_device_id: devId('c'), ...extra },
      });
    const lookup = (g: ConnectorGateway, user: string, handle: unknown) =>
      g.send('POST', '/v1/e2e/pairings/lookup', { user, body: { handle } });

    it('looks up a live offer by handle and lets the phone claim it with the typed key', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      const created = await typedOffer(g, token, { handle: '7KQ2', key_mac: 'KM' });
      expect(created.statusCode).toBe(200);
      const offerId = created.json<{ offer_id: string }>().offer_id;
      const found = await lookup(g, 'u1', '7KQ2');
      expect(found.statusCode).toBe(200);
      expect(found.json()).toEqual({
        offer_id: offerId,
        connector_public_key: key(1),
        connector_device_id: devId('c'),
        key_mac: 'KM',
      });
      const claimed = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
        user: 'u1',
        body: { ...claimBody(offerId), key: 'typed' },
      });
      expect(claimed.statusCode).toBe(200);
      const polled = await g.send('GET', `/v1/e2e/pairings/${offerId}?wait=0`, {
        headers: bearer(token),
      });
      expect(polled.json()).toMatchObject({ key: 'typed' });
      // Claimed: the handle no longer finds it.
      expect((await lookup(g, 'u1', '7KQ2')).statusCode).toBe(404);
    });

    it('answers 404 alike for an unknown handle and another account handle', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      await typedOffer(g, token, { handle: '7KQ2', key_mac: 'KM' });
      const stranger = await lookup(g, 'u2', '7KQ2');
      const unknown = await lookup(g, 'u1', 'ZZZZ');
      expect(stranger.statusCode).toBe(404);
      expect(unknown.statusCode).toBe(404);
      expect(stranger.json().error.code).toBe(unknown.json().error.code);
      expect(stranger.json().error.message).toBe(unknown.json().error.message);
    });

    it('never returns an expired offer', async () => {
      const g = await start();
      const { connectorId } = await g.pair('u1');
      g.e2e.createOffer('u1', {
        connectorId,
        connectorDeviceId: devId('c'),
        connectorPublicKey: key(1),
        expiresAt: new Date(Date.now() - 1),
        handle: '7KQ2',
        keyMac: 'KM',
      });
      expect((await lookup(g, 'u1', '7KQ2')).statusCode).toBe(404);
    });

    it('still takes an offer from an older computer, which no handle finds', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      expect((await offer(g, token)).statusCode).toBe(200);
      expect((await lookup(g, 'u1', '7KQ2')).statusCode).toBe(404);
    });

    it('answers handle_taken when the account already has a live offer with that handle', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      expect((await typedOffer(g, token, { handle: '7KQ2', key_mac: 'KM' })).statusCode).toBe(200);
      const again = await typedOffer(g, token, { handle: '7KQ2', key_mac: 'KM2' });
      expect(again.statusCode).toBe(409);
      expect(again.json().error.code).toBe('handle_taken');
      expect((await typedOffer(g, token, { handle: '7KQ3', key_mac: 'KM2' })).statusCode).toBe(200);
    });

    it('refuses a malformed handle or a handle without key_mac', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      for (const extra of [
        { handle: '7kq2', key_mac: 'KM' },
        { handle: 'UUUU', key_mac: 'KM' },
        { handle: '7KQ2' },
        { key_mac: 'KM' },
        { handle: '7KQ2', key_mac: 'not base64!' },
      ])
        expect((await typedOffer(g, token, extra)).statusCode).toBe(400);
      for (const handle of ['7kq2', '7KQ', 'IIII', 42, undefined])
        expect((await lookup(g, 'u1', handle)).statusCode).toBe(400);
      expect(
        (
          await g.send('POST', `/v1/e2e/pairings/off_${'a'.repeat(20)}/claim`, {
            user: 'u1',
            body: { ...claimBody(`off_${'a'.repeat(20)}`), key: 'both' },
          })
        ).statusCode,
      ).toBe(400);
    });

    it('refuses a typed claim on an offer that registered no typed code, and keeps it open', async () => {
      const g = await start();
      const { token } = await g.pair('u1');
      const offerId = (await offer(g, token)).json<{ offer_id: string }>().offer_id;
      const typedClaim = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
        user: 'u1',
        body: { ...claimBody(offerId), key: 'typed' },
      });
      expect(typedClaim.statusCode).toBe(404);
      // The QR claim still works afterwards: the bad claim did not use the offer up.
      const qrClaim = await g.send('POST', `/v1/e2e/pairings/${offerId}/claim`, {
        user: 'u1',
        body: claimBody(offerId),
      });
      expect(qrClaim.statusCode).toBe(200);
    });

    it('rate limits lookups per account', async () => {
      const g = await start(FLAG_ON, { e2eLookupRatePerMinute: 2 });
      const codes: number[] = [];
      for (let i = 0; i < 3; i++) codes.push((await lookup(g, 'u1', 'ZZZZ')).statusCode);
      expect(codes).toEqual([404, 404, 429]);
      // Another account has its own budget.
      expect((await lookup(g, 'u2', 'ZZZZ')).statusCode).toBe(404);
    });

    it('answers private_chats_off when the account may not use private chats', async () => {
      const g = await start({ ...FLAG_ON, PRIVATE_CHATS_USERS: 'owner' });
      const res = await lookup(g, 'u1', '7KQ2');
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('private_chats_off');
    });
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

describe('a computer set up again (private reset, C3 #11 P4a)', () => {
  it('removes only its own computer device, never a phone or another computer', async () => {
    const g = await start();
    const mine = await g.pair('u1');
    g.e2e.add('u1', {
      id: devId('c'),
      kind: 'computer',
      name: 'Laptop',
      public_key: key(1),
      connector_id: mine.connectorId,
    });
    g.e2e.add('u1', {
      id: devId('d'),
      kind: 'computer',
      name: 'Desktop',
      public_key: key(3),
      connector_id: `con_${'z'.repeat(20)}`,
    });
    g.e2e.add('u1', { id: devId('p'), kind: 'phone', name: 'Pixel', public_key: key(2) });
    const del = (token: string, id: string) =>
      g.send('DELETE', `/v1/e2e/computer/devices/${id}`, { headers: bearer(token) });
    expect((await del(mine.token, devId('p'))).statusCode).toBe(404);
    expect((await del(mine.token, devId('d'))).statusCode).toBe(404);
    expect((await del(mine.token, devId('c'))).statusCode).toBe(204);
    expect((await del(mine.token, devId('c'))).statusCode).toBe(404);
    expect(g.e2e.list('u1').map((d) => d.id)).toEqual([devId('d'), devId('p')]);
  });
});
