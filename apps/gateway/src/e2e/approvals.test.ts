/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { approvalCommitment, deviceIdFor } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const keyBytes = (n: number) => new Uint8Array(32).fill(n);
const key = (n: number) => Buffer.from(keyBytes(n)).toString('base64url');
const idOf = (n: number) => deviceIdFor(keyBytes(n));
type Devices = { devices: { id: string; trust_note?: unknown }[] };

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  vi.useRealTimers();
});

async function start(env: Record<string, string> = FLAG_ON) {
  gateway = await startConnectorGateway({ env });
  return gateway;
}

/** Device `n` as an active phone of `user`. */
function addPhone(g: ConnectorGateway, user: string, n: number) {
  g.e2e.add(user, { id: idOf(n), kind: 'phone', name: `Phone ${n}`, public_key: key(n) });
}

const note = (approvalId: string, sender: number) => ({
  approval_id: approvalId,
  sender_device: idOf(sender),
  nonce: 'bm9uY2U',
  body: 'Ym9keQ',
  keys: [{ device: idOf(9), wrapped: 'd3JhcA' }],
});

async function request(g: ConnectorGateway, user = 'u1', n = 9) {
  const res = await g.send('POST', '/v1/e2e/approvals', {
    user,
    body: { device_id: idOf(n), public_key: key(n), name: 'New phone' },
  });
  return res;
}

const claim = (g: ConnectorGateway, id: string, by: number, user = 'u1') =>
  g.send('POST', `/v1/e2e/approvals/${id}/claim`, { user, body: { device_id: idOf(by) } });
const accept = (g: ConnectorGateway, id: string, by: number, user = 'u1') =>
  g.send('POST', `/v1/e2e/approvals/${id}/accept`, {
    user,
    body: { device_id: idOf(by), note: note(id, by) },
  });

describe('approving a second phone (C3 #11, Task 27)', () => {
  it('requests, claims, shows the approver, accepts and lists the note only when asked', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const created = await request(g);
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect(id).toMatch(/^pap_[a-z2-7]{20}$/);
    const listed = await g.send('GET', `/v1/e2e/approvals?device_id=${idOf(1)}`, { user: 'u1' });
    expect(listed.json<{ approvals: { id: string }[] }>().approvals.map((a) => a.id)).toEqual([id]);

    expect((await claim(g, id, 1)).json()).toMatchObject({
      state: 'claimed',
      public_key: key(9),
    });
    const polled = await g.send('GET', `/v1/e2e/approvals/${id}?device_id=${idOf(9)}`, {
      user: 'u1',
    });
    expect(polled.json().approver).toEqual({ id: idOf(1), name: 'Phone 1', public_key: key(1) });

    const done = await accept(g, id, 1);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ state: 'accepted', trust_note: note(id, 1) });

    const plain = (await g.send('GET', '/v1/e2e/devices', { user: 'u1' })).json<Devices>();
    const added = plain.devices.find((d) => d.id === idOf(9))!;
    expect(Object.keys(added).sort()).toEqual(['added_at', 'id', 'kind', 'name', 'public_key']);
    const withNotes = (
      await g.send('GET', '/v1/e2e/devices?notes=1', { user: 'u1' })
    ).json<Devices>();
    expect(withNotes.devices.find((d) => d.id === idOf(9))?.trust_note).toEqual(note(id, 1));
    expect(withNotes.devices.find((d) => d.id === idOf(1))?.trust_note).toBe(undefined);
  });

  it('gives the computer the note only with ?notes=1', async () => {
    const g = await start();
    const { token } = await g.pair('u1');
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    await claim(g, id, 1);
    await accept(g, id, 1);
    const headers = { authorization: `Bearer ${token}` };
    const plain = (await g.send('GET', '/v1/e2e/computer/devices', { headers })).json<Devices>();
    expect(JSON.stringify(plain)).not.toContain('trust_note');
    const notes = (
      await g.send('GET', '/v1/e2e/computer/devices?notes=1', { headers })
    ).json<Devices>();
    expect(JSON.stringify(notes)).toContain('trust_note');
  });

  it('an approval expires after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    expect((await claim(g, id, 1)).statusCode).toBe(200);
    vi.setSystemTime(new Date('2026-11-25T10:10:00.001Z'));
    const late = await accept(g, id, 1);
    expect(late.statusCode).toBe(410);
    expect(late.json().error.code).toBe('expired');
    expect(g.e2e.get('u1', idOf(9))).toBeUndefined();
  });

  it('refuses accept at the device cap', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    await claim(g, id, 1);
    for (const n of [2, 3, 4, 5]) addPhone(g, 'u1', n);
    const res = await accept(g, id, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('device_cap');
    // And a request at the cap is refused at once.
    expect((await request(g, 'u1', 8)).json().error.code).toBe('device_cap');
  });

  it('a phone of another account cannot list, claim or accept', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u2', 2);
    const id = (await request(g)).json().id as string;
    expect(
      (await g.send('GET', `/v1/e2e/approvals?device_id=${idOf(2)}`, { user: 'u2' })).json()
        .approvals,
    ).toEqual([]);
    expect((await claim(g, id, 2, 'u2')).statusCode).toBe(404);
    // Naming u1's phone from u2's account does not help either.
    expect((await claim(g, id, 1, 'u2')).statusCode).toBe(404);
    await claim(g, id, 1);
    expect((await accept(g, id, 2, 'u2')).statusCode).toBe(404);
    expect(g.e2e.get('u1', idOf(9))).toBeUndefined();
  });

  it('refuses a claim by a removed device and by the requesting phone itself', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    g.e2e.revoke('u1', idOf(2));
    const id = (await request(g)).json().id as string;
    expect((await claim(g, id, 2)).statusCode).toBe(404);
    expect((await claim(g, id, 9)).statusCode).toBe(404);
  });

  it('refuses a mismatched device id, an added phone, a 4th open request and a second claimer', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    const bad = await g.send('POST', '/v1/e2e/approvals', {
      user: 'u1',
      body: { device_id: idOf(8), public_key: key(9), name: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    const first = (await request(g, 'u1', 9)).json().id as string;
    // A new request from the same phone replaces its open one.
    const again = (await request(g, 'u1', 9)).json().id as string;
    expect(g.e2e.approval('u1', first)).toBeUndefined();
    await request(g, 'u1', 10);
    await request(g, 'u1', 11);
    expect((await request(g, 'u1', 12)).json().error.code).toBe('approval_cap');
    await claim(g, again, 1);
    expect((await claim(g, again, 2)).json().error.code).toBe('approval_closed');
    expect((await accept(g, again, 2)).json().error.code).toBe('approval_closed');
  });

  it('an active phone with another active phone can ask to be approved', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    const res = await request(g, 'u1', 1);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toMatch(/^pap_[a-z2-7]{20}$/);
  });

  it('the only active phone still gets already_added', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    g.e2e.add('u1', { id: idOf(3), kind: 'computer', name: 'PC', public_key: key(3) });
    const res = await request(g, 'u1', 1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_added');
  });

  it('an active id with another key gets already_added', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    const res = await g.send('POST', '/v1/e2e/approvals', {
      user: 'u1',
      body: { device_id: idOf(1), public_key: key(7), name: 'x' },
    });
    expect(res.statusCode).toBe(400);
    // The id must match the key, so a swapped key is refused before the store; the store too:
    expect(() =>
      g.e2e.requestApproval(
        'u1',
        { device_id: idOf(1), public_key: key(7), name: 'x' },
        new Date(Date.now() + 60_000),
      ),
    ).toThrow(expect.objectContaining({ code: 'already_added' }));
  });

  it('an active requester does not count against the device cap', async () => {
    const g = await start();
    for (const n of [1, 2, 3, 4, 5]) addPhone(g, 'u1', n);
    const res = await request(g, 'u1', 1);
    expect(res.statusCode).toBe(200);
  });

  it('accept writes the note on the existing row', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    const id = (await request(g, 'u1', 2)).json().id as string;
    expect((await claim(g, id, 1)).statusCode).toBe(200);
    expect((await accept(g, id, 1)).statusCode).toBe(200);
    const withNotes = (
      await g.send('GET', '/v1/e2e/devices?notes=1', { user: 'u1' })
    ).json<Devices>();
    expect(withNotes.devices.find((d) => d.id === idOf(2))?.trust_note).toEqual(note(id, 1));
    const plain = (await g.send('GET', '/v1/e2e/devices', { user: 'u1' })).json<Devices>();
    expect(JSON.stringify(plain)).not.toContain('trust_note');
  });

  it('a phone cannot claim its own request', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    const id = (await request(g, 'u1', 2)).json().id as string;
    expect((await claim(g, id, 2)).statusCode).toBe(404);
    expect((await claim(g, id, 1)).statusCode).toBe(200);
  });

  it('denies, and the new phone sees it; another phone cannot read its status', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    expect(
      (
        await g.send('POST', `/v1/e2e/approvals/${id}/deny`, {
          user: 'u1',
          body: { device_id: idOf(1) },
        })
      ).statusCode,
    ).toBe(204);
    const status = await g.send('GET', `/v1/e2e/approvals/${id}?device_id=${idOf(9)}`, {
      user: 'u1',
    });
    expect(status.json().state).toBe('denied');
    expect(
      (await g.send('GET', `/v1/e2e/approvals/${id}?device_id=${idOf(1)}`, { user: 'u1' }))
        .statusCode,
    ).toBe(404);
    expect((await claim(g, id, 1)).statusCode).toBe(409);
  });

  it('refuses a note sent by another device than the approver', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    await claim(g, id, 1);
    const res = await g.send('POST', `/v1/e2e/approvals/${id}/accept`, {
      user: 'u1',
      body: { device_id: idOf(1), note: note(id, 2) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is not mounted with the flag off, and delete my data removes approvals', async () => {
    const off = await start({ THREADS_ENABLED: 'true' });
    expect((await request(off)).statusCode).toBe(404);
    await off.close();
    gateway = undefined;
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = (await request(g)).json().id as string;
    g.e2e.deleteAllForUser('u1');
    expect(g.e2e.approval('u1', id)).toBeUndefined();
  });
});

describe('second-phone approval: commit, then reveal (ADR-046)', () => {
  const secret = (n: number) => Buffer.from(new Uint8Array(32).fill(n)).toString('base64url');
  const commitmentOf = (n: number, s: number) =>
    Buffer.from(approvalCommitment(keyBytes(n), new Uint8Array(32).fill(s))).toString('base64url');

  async function committed(g: ConnectorGateway, user = 'u1', n = 9) {
    const res = await g.send('POST', '/v1/e2e/approvals', {
      user,
      body: {
        device_id: idOf(n),
        public_key: key(n),
        name: 'New phone',
        commitment: commitmentOf(n, 50),
      },
    });
    return res.json().id as string;
  }
  const nonce = (g: ConnectorGateway, id: string, by: number, user = 'u1', value = secret(60)) =>
    g.send('POST', `/v1/e2e/approvals/${id}/nonce`, {
      user,
      body: { device_id: idOf(by), nonce: value },
    });
  const reveal = (g: ConnectorGateway, id: string, by: number, user = 'u1', value = secret(50)) =>
    g.send('POST', `/v1/e2e/approvals/${id}/reveal`, {
      user,
      body: { device_id: idOf(by), reveal: value },
    });
  const status = (g: ConnectorGateway, id: string, by: number, user = 'u1') =>
    g.send('GET', `/v1/e2e/approvals/${id}?device_id=${idOf(by)}`, { user });

  it('carries the commitment, the nonce and the reveal in order', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = await committed(g);
    expect((await claim(g, id, 1)).json().commitment).toBe(commitmentOf(9, 50));
    // No reveal before the approver's nonce.
    expect((await reveal(g, id, 9)).json().error.code).toBe('approval_closed');
    const withNonce = await nonce(g, id, 1);
    expect(withNonce.statusCode).toBe(200);
    expect(withNonce.json().approver_nonce).toBe(secret(60));
    // The approver reads the approval too, the new phone sees the nonce.
    expect((await status(g, id, 1)).json().reveal).toBeUndefined();
    expect((await status(g, id, 9)).json().approver_nonce).toBe(secret(60));
    expect((await reveal(g, id, 9)).statusCode).toBe(200);
    expect((await status(g, id, 1)).json().reveal).toBe(secret(50));
  });

  it('sets the nonce and the reveal once only', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = await committed(g);
    await claim(g, id, 1);
    await nonce(g, id, 1);
    expect((await nonce(g, id, 1, 'u1', secret(61))).statusCode).toBe(409);
    await reveal(g, id, 9);
    expect((await reveal(g, id, 9)).statusCode).toBe(409);
    expect((await status(g, id, 9)).json().approver_nonce).toBe(secret(60));
  });

  it('allows only the claiming phone and the new phone of the same account', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    addPhone(g, 'u1', 2);
    addPhone(g, 'u2', 3);
    const id = await committed(g);
    await claim(g, id, 1);
    expect((await nonce(g, id, 2)).statusCode).toBe(404);
    expect((await nonce(g, id, 9)).statusCode).toBe(404);
    expect((await nonce(g, id, 3, 'u2')).statusCode).toBe(404);
    expect((await nonce(g, id, 1, 'u2')).statusCode).toBe(404);
    await nonce(g, id, 1);
    expect((await reveal(g, id, 1)).statusCode).toBe(404);
    expect((await reveal(g, id, 9, 'u2')).statusCode).toBe(404);
    expect((await status(g, id, 2)).statusCode).toBe(404);
    expect((await status(g, id, 1, 'u2')).statusCode).toBe(404);
  });

  it('refuses a reveal that does not open the commitment', async () => {
    const g = await start();
    addPhone(g, 'u1', 1);
    const id = await committed(g);
    await claim(g, id, 1);
    await nonce(g, id, 1);
    expect((await reveal(g, id, 9, 'u1', secret(51))).statusCode).toBe(400);
    expect((await reveal(g, id, 9)).statusCode).toBe(200);
  });

  it('refuses a nonce for a request without a commitment, and after expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
    const g = await start();
    addPhone(g, 'u1', 1);
    const old = (await request(g)).json().id as string;
    await claim(g, old, 1);
    expect((await nonce(g, old, 1)).statusCode).toBe(409);
    const id = await committed(g, 'u1', 8);
    await claim(g, id, 1);
    vi.setSystemTime(new Date('2026-11-25T10:10:00.001Z'));
    expect((await nonce(g, id, 1)).statusCode).toBe(410);
    expect((await reveal(g, id, 8)).statusCode).toBe(410);
  });
});
