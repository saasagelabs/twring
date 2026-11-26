/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import {
  messagePageResponseSchema,
  SEALED_CANCEL_FEATURE,
  SEALED_CHAT_FEATURE,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { startFakeConnector, type FakeConnector } from './testing';

/** Stop in a private chat (C3 #11): the server marks it stopped and tells the computer. */

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const PHONE = `dev_${'p'.repeat(20)}`;
const COMPUTER = `dev_${'c'.repeat(20)}`;
let seq = 0;

function envelope(overrides: Partial<SealedEnvelopeV1> = {}): SealedEnvelopeV1 {
  return {
    v: 1,
    sender_device: PHONE,
    sender_seq: ++seq,
    nonce: 'bm9uY2Vub25jZQ',
    body: 'Y2lwaGVydGV4dA',
    keys: [
      { device: PHONE, wrapped: 'd3JhcHBlZA' },
      { device: COMPUTER, wrapped: 'd3JhcHBlZA' },
    ],
    ...overrides,
  };
}

const gateways: ConnectorGateway[] = [];
const extra: FakeConnector[] = [];
afterEach(async () => {
  for (const connector of extra.splice(0)) connector.terminate();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const BOTH = [SEALED_CHAT_FEATURE, SEALED_CANCEL_FEATURE];

async function privateThread(
  features: string[] = BOTH,
  threads: { sweepIntervalMs?: number } = {},
) {
  const g = await startConnectorGateway({ threads, ring: {}, env: FLAG_ON });
  gateways.push(g);
  const { connectorId, token, connector } = await g.connect('u1', { features });
  const agentId = await g.createAgent('u1', connectorId);
  const set = await g.send('PUT', `/v1/agents/${agentId}/private`, {
    user: 'u1',
    body: { on: true },
    headers: { 'x-twring-features': SEALED_CHAT_FEATURE },
  });
  if (set.statusCode !== 200) throw new Error(`private ${set.statusCode}`);
  const post = async () => {
    const res = await g.send('POST', `/v1/agents/${agentId}/messages`, {
      user: 'u1',
      body: { client_id: randomUUID(), sealed: envelope() },
    });
    return res.json().message as { id: string; status: string };
  };
  const stop = async (id: string, user = 'u1') =>
    g.send('POST', `/v1/agents/${agentId}/messages/${id}/stop`, { user });
  const list = async () =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    ).messages;
  const statusOf = async (id: string) => {
    const found = (await list()).find((m) => m.id === id);
    return found?.kind === 'sealed' ? found.status : undefined;
  };
  const reply = (on: FakeConnector, turnId: string, index: number, final: boolean) =>
    on.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: turnId,
      sealed: envelope({ sender_device: COMPUTER, chunk: { index, final } }),
      final,
    });
  const reconnect = async () => {
    const again = startFakeConnector({ url: g.socketUrl, token, features });
    extra.push(again);
    await again.ready;
    return again;
  };
  return { g, connectorId, connector, post, stop, list, statusOf, reply, reconnect };
}

describe('stop in a private chat', () => {
  it('stops a queued message, and it is never delivered', async () => {
    const t = await privateThread();
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    const m = await t.post();
    expect(m.status).toBe('queued');
    const res = await t.stop(m.id);
    expect(res.statusCode).toBe(200);
    expect(await t.statusOf(m.id)).toBe('stopped');
    const again = await t.reconnect();
    await t.g.threads!.service.sweep();
    await new Promise((r) => setTimeout(r, 50));
    expect(again.sealed).toHaveLength(0);
    expect(again.cancels).toHaveLength(0);
    expect(await t.statusOf(m.id)).toBe('stopped');
  });

  it('stops a working turn: tells the computer, keeps late chunks, stays stopped', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.reply(t.connector, m.id, 0, false);
    await waitFor(async () => (await t.statusOf(m.id)) === 'working');
    expect((await t.stop(m.id)).statusCode).toBe(200);
    expect(await t.statusOf(m.id)).toBe('stopped');
    await waitFor(() => t.connector.cancels.length === 1);
    expect(t.connector.cancels[0]).toEqual({
      type: 'sealed.cancel',
      agent: 'claude-code',
      turn_id: m.id,
    });
    t.reply(t.connector, m.id, 1, true);
    await waitFor(async () =>
      (await t.list()).some(
        (x) => x.kind === 'sealed' && x.author === 'agent' && x.sealed.length === 2,
      ),
    );
    expect(await t.statusOf(m.id)).toBe('stopped');
  });

  it('leaves an answered message unchanged and sends nothing', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.reply(t.connector, m.id, 0, true);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
    expect((await t.stop(m.id)).json()).toMatchObject({ message: { status: 'answered' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.connector.cancels).toHaveLength(0);
    expect(await t.statusOf(m.id)).toBe('answered');
  });

  it('sends no cancel to a computer that did not say it can stop, but still stops', async () => {
    const t = await privateThread([SEALED_CHAT_FEATURE]);
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    await t.stop(m.id);
    expect(await t.statusOf(m.id)).toBe('stopped');
    await new Promise((r) => setTimeout(r, 50));
    expect(t.connector.cancels).toHaveLength(0);
  });

  it('a computer offline at Stop finishes the turn; the message stays stopped', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    await t.stop(m.id);
    const again = await t.reconnect();
    t.reply(again, m.id, 0, true);
    await waitFor(async () =>
      (await t.list()).some((x) => x.kind === 'sealed' && x.author === 'agent'),
    );
    expect(again.cancels).toHaveLength(0);
    expect(await t.statusOf(m.id)).toBe('stopped');
  });

  it('another account cannot stop the message', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    expect((await t.stop(m.id, 'u2')).statusCode).toBe(404);
    expect(await t.statusOf(m.id)).toBe('sent');
    expect(t.connector.cancels).toHaveLength(0);
  });

  it('a Stop that lands while the sweep is delivering is never overwritten or delivered', async () => {
    // Only this test's own sweep may run: the harness sweeps every 20 ms, and a sweep already
    // running when the test calls sweep() reads the queue before the hook below is in place.
    const t = await privateThread(BOTH, { sweepIntervalMs: 60_000 });
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    const m = await t.post();
    const again = await t.reconnect();
    // The sweep reads the queue, then looks up the agent: the phone's Stop lands in that gap.
    const options = (
      t.g.threads!.service as unknown as {
        options: { agents: { get: (...args: unknown[]) => Promise<unknown> } };
      }
    ).options;
    const get = options.agents.get.bind(options.agents);
    let fired = false;
    options.agents.get = async (...args: unknown[]) => {
      if (!fired) {
        fired = true;
        expect((await t.stop(m.id)).statusCode).toBe(200);
      }
      return get(...args);
    };
    await t.g.threads!.service.sweep();
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(true);
    expect(await t.statusOf(m.id)).toBe('stopped');
    expect(again.sealed).toHaveLength(0);
  });

  it('a final reply that lands after Stop read the message keeps it answered, no cancel', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.reply(t.connector, m.id, 0, true);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
    // Stop read the message while it was still working (the reply landed right after).
    const store = t.g.threads!.store as unknown as {
      findMessageForUser: (...args: unknown[]) => Promise<{ message: { status?: string } }>;
    };
    const find = store.findMessageForUser.bind(store);
    store.findMessageForUser = async (...args: unknown[]) => {
      store.findMessageForUser = find;
      const found = await find(...args);
      return { ...found, message: { ...found.message, status: 'working' } };
    };
    expect((await t.stop(m.id)).json()).toMatchObject({ message: { status: 'answered' } });
    await new Promise((r) => setTimeout(r, 50));
    expect(await t.statusOf(m.id)).toBe('answered');
    expect(t.connector.cancels).toHaveLength(0);
  });

  it('a double Stop is harmless: still stopped, the computer told', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    const [a, b] = await Promise.all([t.stop(m.id), t.stop(m.id)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    await new Promise((r) => setTimeout(r, 50));
    expect(await t.statusOf(m.id)).toBe('stopped');
    expect(t.connector.cancels.length).toBeGreaterThanOrEqual(1);
  });

  it('Stop with an unknown message id changes nothing', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    expect((await t.stop(`msg_${'a'.repeat(20)}`)).statusCode).toBe(404);
    expect(await t.statusOf(m.id)).toBe('sent');
    expect(t.connector.cancels).toHaveLength(0);
  });
});
