/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import {
  messagePageResponseSchema,
  SEALED_CANCEL_FEATURE,
  SEALED_CHAT_FEATURE,
  SEALED_WORKING_FEATURE,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { type FakeConnector } from './testing';

/** A private turn whose computer goes silent is interrupted after the idle limit (ADR-045). */

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
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Wide margins: frames come far faster than the limit, and silence is waited out well past it.
const IDLE_MS = 600;
const ALL = [SEALED_CHAT_FEATURE, SEALED_CANCEL_FEATURE, SEALED_WORKING_FEATURE];
const UNKNOWN_TURN = `msg_${'z'.repeat(20)}`;

async function privateThread(features: string[] = ALL) {
  const g = await startConnectorGateway({
    threads: { privateIdleMs: IDLE_MS, sweepIntervalMs: 20 },
    ring: {},
    env: FLAG_ON,
  });
  gateways.push(g);
  const { connectorId, connector } = await g.connect('u1', { features });
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
  const stop = async (id: string) =>
    g.send('POST', `/v1/agents/${agentId}/messages/${id}/stop`, { user: 'u1' });
  const statusOf = async (id: string) => {
    const page = messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    );
    const found = page.messages.find((m) => m.id === id);
    return found?.kind === 'sealed' ? found.status : undefined;
  };
  const reply = (on: FakeConnector, turnId: string, final: boolean, index = 0) =>
    on.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: turnId,
      sealed: envelope({ sender_device: COMPUTER, chunk: { index, final } }),
      final,
    });
  const working = (on: FakeConnector, turnId: string, agent = 'claude-code') =>
    on.send({ type: 'sealed.working', agent, turn_id: turnId });
  return { g, connectorId, connector, post, stop, statusOf, reply, working };
}

describe('private turn silence', () => {
  it('marks a silent private turn interrupted', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    await waitFor(async () => (await t.statusOf(m.id)) === 'interrupted', 1_000);
    expect(
      t.g.threadFrames.some(
        (f) =>
          f.userId === 'u1' &&
          f.frame.type === 'message.upserted' &&
          f.frame.message.kind === 'sealed' &&
          f.frame.message.id === m.id &&
          f.frame.message.status === 'interrupted',
      ),
    ).toBe(true);
  });

  it('working frames keep the turn alive', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    for (let i = 0; i < 15; i++) {
      t.working(t.connector, m.id);
      await sleep(60);
    }
    expect(await t.statusOf(m.id)).toBe('sent');
    t.reply(t.connector, m.id, true);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
  });

  it('never times out a computer without sealed_working', async () => {
    const t = await privateThread([SEALED_CHAT_FEATURE, SEALED_CANCEL_FEATURE]);
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    await sleep(IDLE_MS + 400);
    expect(await t.statusOf(m.id)).toBe('sent');
  });

  it('a late final chunk revives an interrupted turn to answered', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(async () => (await t.statusOf(m.id)) === 'interrupted');
    t.reply(t.connector, m.id, true);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
  });

  it('a working frame revives an interrupted turn to working', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(async () => (await t.statusOf(m.id)) === 'interrupted');
    t.working(t.connector, m.id);
    // Seen on the phone socket: a poll of the live status could land after the turn idled again.
    await waitFor(() =>
      t.g.threadFrames.some(
        (f) =>
          f.frame.type === 'message.upserted' &&
          f.frame.message.kind === 'sealed' &&
          f.frame.message.id === m.id &&
          f.frame.message.status === 'working',
      ),
    );
  });

  it("a working frame for another agent's or account's turn changes nothing and keeps the socket", async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    const before = t.g.threads!.service.sealedRepliesRejected;
    t.working(t.connector, m.id, 'other-agent');
    t.working(t.connector, UNKNOWN_TURN);
    await waitFor(() => t.g.threads!.service.sealedRepliesRejected === before + 2);
    expect(t.g.hub.isOnline('u1', t.connectorId)).toBe(true);
    expect(await t.statusOf(m.id)).toBe('sent');
  });

  it('a stopped turn is never marked interrupted', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    expect((await t.stop(m.id)).statusCode).toBe(200);
    await sleep(IDLE_MS + 400);
    expect(await t.statusOf(m.id)).toBe('stopped');
  });

  it('a final chunk that arrives before a missing one keeps the clock running', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.reply(t.connector, m.id, false, 0);
    t.reply(t.connector, m.id, true, 2);
    await waitFor(async () => (await t.statusOf(m.id)) === 'working');
    await waitFor(async () => (await t.statusOf(m.id)) === 'interrupted', 2_000);
    // The missing chunk still completes the reply.
    t.reply(t.connector, m.id, false, 1);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
  });

  it('a complete reply in order is answered and never interrupted', async () => {
    const t = await privateThread();
    const m = await t.post();
    await waitFor(() => t.connector.sealed.length === 1);
    t.reply(t.connector, m.id, false, 0);
    t.reply(t.connector, m.id, false, 1);
    t.reply(t.connector, m.id, true, 2);
    await waitFor(async () => (await t.statusOf(m.id)) === 'answered');
    await sleep(IDLE_MS + 400);
    expect(await t.statusOf(m.id)).toBe('answered');
  });
});
