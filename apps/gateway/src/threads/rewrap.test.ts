/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import {
  deviceIdFor,
  MAX_REWRAP_ITEMS,
  SEALED_CHAT_FEATURE,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const keyBytes = (n: number) => new Uint8Array(32).fill(n);
const key = (n: number) => Buffer.from(keyBytes(n)).toString('base64url');
const idOf = (n: number) => deviceIdFor(keyBytes(n));
const T = idOf(1);
const N = idOf(2);
const COMPUTER = `dev_${'c'.repeat(20)}`;
let seq = 0;
const envelope = (): SealedEnvelopeV1 => ({
  v: 1,
  sender_device: COMPUTER,
  sender_seq: ++seq,
  nonce: 'bm9uY2Vub25jZW5vbmNlbm9uY2U',
  body: 'Y2lwaGVydGV4dA',
  keys: [{ device: T, wrapped: 'd3JhcHBlZA' }],
});

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

async function setup(env: Record<string, string> = FLAG_ON) {
  const g = await startConnectorGateway({ threads: {}, ring: {}, env });
  gateway = g;
  const { connectorId } = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
  const agentId = await g.createAgent('u1', connectorId);
  for (const n of [1, 2])
    g.e2e.add('u1', { id: idOf(n), kind: 'phone', name: `Phone ${n}`, public_key: key(n) });
  const store = g.threads!.store;
  const sealed = async (user = 'u1', agent = agentId) =>
    (await store.appendSealedMessage(user, agent, { author: 'agent', sealed: envelope() })).message;
  const post = (items: { message_id: string; wrapped: string }[], extra = {}, user = 'u1') =>
    g.send('POST', `/v1/agents/${agentId}/sealed-keys`, {
      user,
      body: { device_id: T, for: N, items, ...extra },
    });
  const read = (device = N, after?: string) =>
    g.send(
      'GET',
      `/v1/agents/${agentId}/sealed-keys?device_id=${device}${after ? `&after=${after}` : ''}`,
      { user: 'u1' },
    );
  return { g, agentId, store, sealed, post, read };
}

describe('re-wrapped keys for an approved phone (C3 #11, Task 28)', () => {
  it('adds a wrapped key without touching the message body or sealed.keys', async () => {
    const { g, agentId, sealed, post, read } = await setup();
    const m = await sealed();
    const list = async () =>
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json<{
        messages: unknown[];
      }>().messages[0];
    const before = await list();
    expect((await post([{ message_id: m.id, wrapped: 'd3JhcA' }])).statusCode).toBe(204);
    expect(await list()).toEqual(before);
    expect((await read()).json()).toEqual({
      items: [{ message_id: m.id, by: T, wrapped: 'd3JhcA' }],
    });
    // A repeat replaces.
    await post([{ message_id: m.id, wrapped: 'bmV3' }]);
    expect((await read()).json().items).toEqual([{ message_id: m.id, by: T, wrapped: 'bmV3' }]);
  });

  it('refuses a for device not on the account', async () => {
    const { sealed, post, read } = await setup();
    const m = await sealed();
    const res = await post([{ message_id: m.id, wrapped: 'd3JhcA' }], { for: idOf(7) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('unknown_device');
    expect((await read(idOf(7))).statusCode).toBe(409);
  });

  it('refuses a caller that is not an active phone', async () => {
    const { sealed, post } = await setup();
    const m = await sealed();
    const res = await post([{ message_id: m.id, wrapped: 'd3JhcA' }], { device_id: idOf(8) });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a message of another agent or another user', async () => {
    const { sealed, post, read } = await setup();
    // The store keys threads by (user, agent) only, so any other agent id makes another thread.
    const other = `agt_${'o'.repeat(20)}`;
    const otherAgent = await sealed('u1', other);
    const otherUser = await sealed('u2', other);
    for (const m of [otherAgent, otherUser]) {
      const res = await post([{ message_id: m.id, wrapped: 'd3JhcA' }]);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('unknown_message');
    }
    expect((await read()).json().items).toEqual([]);
  });

  it('removing either device deletes its rows', async () => {
    for (const removed of [T, N]) {
      const { g, sealed, post, store, agentId } = await setup();
      const m = await sealed();
      await post([{ message_id: m.id, wrapped: 'd3JhcA' }]);
      expect(store.listRewraps('u1', agentId, N, { after: 0, limit: 10 }).items).toHaveLength(1);
      const res = await g.send('DELETE', `/v1/e2e/devices/${removed}`, { user: 'u1' });
      expect(res.statusCode).toBe(204);
      expect(store.listRewraps('u1', agentId, N, { after: 0, limit: 10 }).items).toEqual([]);
      await gateway?.close();
      gateway = undefined;
    }
  });

  it('rows go with the message, the thread and delete my data', async () => {
    const { sealed, post, store, agentId } = await setup();
    const rows = () => store.listRewraps('u1', agentId, N, { after: 0, limit: 10 }).items.length;
    const a = await sealed();
    const b = await sealed();
    await post([
      { message_id: a.id, wrapped: 'YQ' },
      { message_id: b.id, wrapped: 'Yg' },
    ]);
    expect(rows()).toBe(2);
    await store.deleteMessage('u1', agentId, a.id);
    expect(rows()).toBe(1);
    await store.deleteAllForUser('u1');
    expect(store.deleteRewrapsForDevice('u1', N)).toBe(0);
  });

  it('caps an upload at 2,000 items', async () => {
    const { sealed, post } = await setup();
    const m = await sealed();
    const items = Array.from({ length: MAX_REWRAP_ITEMS + 1 }, () => ({
      message_id: m.id,
      wrapped: 'd3JhcA',
    }));
    expect((await post(items)).statusCode).toBe(400);
    expect((await post(items.slice(1))).statusCode).toBe(204);
  });

  it('pages in message order', async () => {
    const { store, agentId } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (await store.appendSealedMessage('u1', agentId, { author: 'agent', sealed: envelope() }))
          .message.id,
      );
    store.addRewraps('u1', agentId, {
      by: T,
      forDevice: N,
      items: ids.map((message_id) => ({ message_id, wrapped: 'dw' })),
    });
    const first = store.listRewraps('u1', agentId, N, { after: 0, limit: 2 });
    expect(first.items.map((i) => i.message_id)).toEqual(ids.slice(0, 2));
    const second = store.listRewraps('u1', agentId, N, { after: first.next!, limit: 2 });
    expect(second.items.map((i) => i.message_id)).toEqual(ids.slice(2));
    expect(second.next).toBeUndefined();
  });

  it('is not mounted with the flag off', async () => {
    const { sealed, post } = await setup({ THREADS_ENABLED: 'true' });
    const m = await sealed();
    expect((await post([{ message_id: m.id, wrapped: 'd3JhcA' }])).statusCode).toBe(404);
  });
});
