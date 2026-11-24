/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import {
  MAX_RELAY_MESSAGE_BYTES,
  MAX_SEALED_AGENT_BODY_CHARS,
  MAX_SEALED_BODY_CHARS,
  messagePageResponseSchema,
  SEALED_CHAT_FEATURE,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { startFakeConnector, type FakeConnector } from './testing';

/** Private chats (ADR-044): sealed messages pass through the relay as opaque blobs. */

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

async function privateThread() {
  const g = await startConnectorGateway({ threads: {}, ring: {}, env: FLAG_ON });
  gateways.push(g);
  const { connectorId, token, connector } = await g.connect('u1', {
    features: [SEALED_CHAT_FEATURE],
  });
  const agentId = await g.createAgent('u1', connectorId);
  const set = await g.send('PUT', `/v1/agents/${agentId}/private`, {
    user: 'u1',
    body: { on: true },
    headers: { 'x-twring-features': SEALED_CHAT_FEATURE },
  });
  if (set.statusCode !== 200) throw new Error(`private ${set.statusCode}`);
  const post = async (body: Record<string, unknown>) => {
    const res = await g.send('POST', `/v1/agents/${agentId}/messages`, { user: 'u1', body });
    return { status: res.statusCode, json: res.json() };
  };
  const list = async () =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    ).messages;
  return { g, agentId, connectorId, token, connector, post, list, localAgent: 'claude-code' };
}

describe('sealed relay', () => {
  it('relays a sealed message byte for byte and stores the sealed reply', async () => {
    const t = await privateThread();
    const sent = envelope();
    const posted = await t.post({ client_id: randomUUID(), sealed: sent });
    expect(posted.json.message).toMatchObject({ kind: 'sealed', status: 'sent' });
    await waitFor(() => t.connector.sealed.length === 1);
    const frame = t.connector.sealed[0]!;
    expect(frame).toEqual({
      type: 'sealed.message',
      agent: t.localAgent,
      message_id: posted.json.message.id,
      sealed: sent,
    });

    const partial = envelope({ sender_device: COMPUTER, chunk: { index: 0, final: false } });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: frame.message_id,
      sealed: partial,
      final: false,
    });
    await waitFor(async () =>
      (await t.list()).some((m) => m.kind === 'sealed' && m.author === 'agent'),
    );
    expect((await t.list()).find((m) => m.id === frame.message_id)).toMatchObject({
      status: 'working',
    });

    const reply = envelope({ sender_device: COMPUTER });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: frame.message_id,
      sealed: reply,
      final: true,
    });
    await waitFor(async () =>
      (await t.list()).some(
        (m) => m.id === frame.message_id && m.kind === 'sealed' && m.status === 'answered',
      ),
    );
    const messages = await t.list();
    const agentReplies = messages.filter((m) => m.kind === 'sealed' && m.author === 'agent');
    // The streamed reply was updated in place, not stored twice.
    expect(agentReplies).toHaveLength(1);
    expect(agentReplies[0]).toMatchObject({
      kind: 'sealed',
      author: 'agent',
      sealed: reply,
      turn_id: frame.message_id,
    });
    expect(JSON.stringify(messages)).not.toContain('"text"');
  });

  it('closes the socket on a sealed reply over the relay frame cap and stores nothing', async () => {
    const t = await privateThread();
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER, body: 'A'.repeat(MAX_RELAY_MESSAGE_BYTES) }),
      final: true,
    });
    expect(await t.connector.closed).toBe(1009);
    expect(await t.list()).toHaveLength(1);
  });

  it('ignores a reply after the final one', async () => {
    const t = await privateThread();
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    const turn = posted.json.message.id;
    const final = envelope({ sender_device: COMPUTER });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: turn,
      sealed: final,
      final: true,
    });
    await waitFor(async () => (await t.list()).length === 2);
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: turn,
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const replies = (await t.list()).filter((m) => m.kind === 'sealed' && m.author === 'agent');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ sealed: final });
  });

  it('drops a sealed reply from another account computer', async () => {
    const t = await privateThread();
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    const stranger = await t.g.connect('u2', { features: [SEALED_CHAT_FEATURE] });
    stranger.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    await waitFor(() => t.g.threads!.service.sealedRepliesRejected === 1);
    expect(await t.list()).toHaveLength(1);
    // The stranger's socket stays up: a refused reply is dropped, not a protocol error.
    expect(t.g.hub.isOnline('u2', stranger.connectorId)).toBe(true);
  });

  it('drops a sealed reply naming another local agent or an unknown turn', async () => {
    const t = await privateThread();
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    t.connector.send({
      type: 'sealed.reply',
      agent: 'gemini',
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: `msg_${'x'.repeat(20)}`,
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: 'not-a-message',
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    await waitFor(() => t.g.threads!.service.sealedRepliesRejected === 3);
    expect(await t.list()).toHaveLength(1);
  });

  it('drops a sealed reply for a thread that is not private', async () => {
    const g = await startConnectorGateway({ threads: {}, env: FLAG_ON });
    gateways.push(g);
    const { connectorId, connector } = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
    const agentId = await g.createAgent('u1', connectorId);
    const typed = await g.send('POST', `/v1/agents/${agentId}/messages`, {
      user: 'u1',
      body: { client_id: randomUUID(), text: 'hello' },
    });
    const id = typed.json().message.id;
    connector.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: id,
      sealed: envelope({ sender_device: COMPUTER }),
      final: true,
    });
    await waitFor(() => g.threads!.service.sealedRepliesRejected === 1);
    const listed = messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    );
    expect(listed.messages.some((m) => m.kind === 'sealed')).toBe(false);
  });

  it('queues while the computer is offline and delivers on reconnect', async () => {
    const t = await privateThread();
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    const sent = envelope();
    const posted = await t.post({ client_id: randomUUID(), sealed: sent });
    expect(posted.json.message).toMatchObject({ status: 'queued' });
    const back = startFakeConnector({
      url: t.g.socketUrl,
      token: t.token,
      features: [SEALED_CHAT_FEATURE],
    });
    extra.push(back);
    await back.ready;
    await waitFor(() => back.sealed.length === 1);
    expect(back.sealed[0]).toMatchObject({ message_id: posted.json.message.id, sealed: sent });
    await waitFor(async () =>
      (await t.list()).some(
        (m) => m.id === posted.json.message.id && m.kind === 'sealed' && m.status === 'sent',
      ),
    );
  });

  it('does not deliver to a reconnected computer that dropped private chat support', async () => {
    const t = await privateThread();
    t.connector.terminate();
    await waitFor(() => !t.g.hub.isOnline('u1', t.connectorId));
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    const old = startFakeConnector({ url: t.g.socketUrl, token: t.token, features: [] });
    extra.push(old);
    await old.ready;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(old.sealed).toHaveLength(0);
    expect((await t.list()).find((m) => m.id === posted.json.message.id)).toMatchObject({
      status: 'queued',
    });
  });

  it('accepts an agent reply up to the agent cap and refuses the user cap above it', async () => {
    const t = await privateThread();
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    // A large agent body still has to fit one relay frame.
    const body = 'A'.repeat(40_000);
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER, body }),
      final: true,
    });
    await waitFor(async () => (await t.list()).length === 2);
    expect(MAX_SEALED_AGENT_BODY_CHARS).toBeGreaterThan(40_000);
    const tooBig = await t.post({
      client_id: randomUUID(),
      sealed: envelope({ body: 'A'.repeat(MAX_SEALED_BODY_CHARS + 1) }),
    });
    expect(tooBig.status).toBe(400);
  });

  it('pushes a sealed reply with the fixed text only', async () => {
    const t = await privateThread();
    const push = vi.spyOn(t.g.ring!.service, 'pushMessage');
    const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER, body: 'U0VDUkVU' }),
      final: false,
    });
    await waitFor(async () => (await t.list()).length === 2);
    expect(push).not.toHaveBeenCalled();
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({ sender_device: COMPUTER, body: 'U0VDUkVU' }),
      final: true,
    });
    await waitFor(() => push.mock.calls.length === 1);
    const payload = push.mock.calls[0]![1];
    expect(payload.preview).toBe('New message');
    expect(payload).not.toHaveProperty('text');
    expect(JSON.stringify(payload)).not.toContain('U0VDUkVU');
  });

  it('logs ids and counts only', async () => {
    const lines: string[] = [];
    const g = await startConnectorGateway({ threads: {}, env: FLAG_ON });
    gateways.push(g);
    const log = vi.fn((fields: Record<string, unknown>) => lines.push(JSON.stringify(fields)));
    (g.threads!.service as unknown as { options: { log: unknown } }).options.log = {
      info: log,
      warn: log,
    };
    const { connectorId, connector } = await g.connect('u1', { features: [SEALED_CHAT_FEATURE] });
    const agentId = await g.createAgent('u1', connectorId);
    await g.send('PUT', `/v1/agents/${agentId}/private`, {
      user: 'u1',
      body: { on: true },
      headers: { 'x-twring-features': SEALED_CHAT_FEATURE },
    });
    const posted = await g.send('POST', `/v1/agents/${agentId}/messages`, {
      user: 'u1',
      body: { client_id: randomUUID(), sealed: envelope({ body: 'Qk9EWU1BUktFUg' }) },
    });
    const id = posted.json().message.id;
    connector.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: id,
      sealed: envelope({ sender_device: COMPUTER, body: 'UkVQTFlNQVJLRVI' }),
      final: true,
    });
    await waitFor(() => lines.some((line) => line.includes('thread_sealed_reply')));
    const all = lines.join('\n');
    expect(all).not.toContain('Qk9EWU1BUktFUg');
    expect(all).not.toContain('UkVQTFlNQVJLRVI');
    expect(all).not.toContain('d3JhcHBlZA');
  });
});
