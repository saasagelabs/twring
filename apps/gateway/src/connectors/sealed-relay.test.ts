/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  MAX_RELAY_MESSAGE_BYTES,
  MAX_SEALED_AGENT_BODY_CHARS,
  MAX_SEALED_BODY_CHARS,
  MAX_SEALED_REPLY_TOTAL_CHARS,
  messagePageResponseSchema,
  SEALED_CHAT_FEATURE,
  threadListResponseSchema,
  type SealedEnvelopeV1,
  type ThreadMessage,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { messageAad, type CredentialCipher } from '../store/cipher';

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

    const reply = envelope({ sender_device: COMPUTER, chunk: { index: 1, final: true } });
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
    // The streamed reply is one message holding every chunk, not stored twice.
    expect(agentReplies).toHaveLength(1);
    expect(agentReplies[0]).toMatchObject({
      kind: 'sealed',
      author: 'agent',
      sealed: [partial, reply],
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
    expect(replies[0]).toMatchObject({ sealed: [final] });
  });

  describe('chunked replies', () => {
    const chunk = (index: number, final: boolean, body = `Q0hVTks${index}`) =>
      envelope({ sender_device: COMPUTER, sender_seq: 900, body, chunk: { index, final } });
    async function turn() {
      const t = await privateThread();
      const posted = await t.post({ client_id: randomUUID(), sealed: envelope() });
      const id = posted.json.message.id as string;
      const send = (sealed: SealedEnvelopeV1) =>
        t.connector.send({
          type: 'sealed.reply',
          agent: t.localAgent,
          turn_id: id,
          sealed,
          final: sealed.chunk?.final ?? true,
        });
      const reply = async () =>
        (await t.list()).find(
          (m): m is Extract<ThreadMessage, { kind: 'sealed' }> =>
            m.kind === 'sealed' && m.author === 'agent',
        );
      const until = (n: number) => waitFor(async () => (await reply())?.sealed.length === n);
      const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
      return {
        t,
        id,
        send,
        reply,
        until,
        settle,
        rejected: () => t.g.threads!.service.sealedRepliesRejected,
      };
    }

    it('keeps every chunk of a reply, in order, in one message', async () => {
      const r = await turn();
      const chunks = [chunk(0, false), chunk(1, false), chunk(2, true)];
      for (const c of chunks) r.send(c);
      await r.until(3);
      expect((await r.reply())!.sealed).toEqual(chunks);
      await waitFor(async () =>
        (await r.t.list()).some(
          (m) => m.id === r.id && m.kind === 'sealed' && m.status === 'answered',
        ),
      );
      expect((await r.t.list()).filter((m) => m.kind === 'sealed')).toHaveLength(2);
    });

    it('orders chunks by index when they arrive out of order', async () => {
      const r = await turn();
      const chunks = [chunk(0, false), chunk(1, false), chunk(2, true)];
      r.send(chunks[2]!);
      await r.until(1);
      r.send(chunks[0]!);
      await r.until(2);
      r.send(chunks[1]!);
      await r.until(3);
      expect((await r.reply())!.sealed).toEqual(chunks);
      expect(r.rejected()).toBe(0);
    });

    it('stores a chunk sent again after a reconnect once', async () => {
      const r = await turn();
      const chunks = [chunk(0, false), chunk(1, true)];
      r.send(chunks[0]!);
      await r.until(1);
      r.send(chunks[0]!);
      r.send(chunks[1]!);
      await r.until(2);
      r.send(chunks[0]!);
      r.send(chunks[1]!);
      await r.settle();
      expect((await r.reply())!.sealed).toEqual(chunks);
    });

    it('refuses and counts a new chunk after the final one', async () => {
      const r = await turn();
      r.send(chunk(0, false));
      r.send(chunk(1, true));
      await r.until(2);
      const before = r.rejected();
      r.send(chunk(2, false));
      r.send(chunk(3, true));
      await waitFor(() => r.rejected() === before + 2);
      expect((await r.reply())!.sealed).toHaveLength(2);
    });

    it('refuses a chunk whose index disagrees with the frame final flag', async () => {
      const r = await turn();
      r.t.connector.send({
        type: 'sealed.reply',
        agent: r.t.localAgent,
        turn_id: r.id,
        sealed: chunk(0, true),
        final: false,
      });
      await waitFor(() => r.rejected() === 1);
      expect(await r.reply()).toBeUndefined();
    });

    it('bounds the stored size of one reply', async () => {
      const r = await turn();
      const third = 'A'.repeat(Math.ceil(MAX_SEALED_REPLY_TOTAL_CHARS / 3) + 1);
      expect(third.length).toBeLessThan(MAX_RELAY_MESSAGE_BYTES - 1024);
      r.send(chunk(0, false, third));
      await r.until(1);
      r.send(chunk(1, false, third));
      await r.until(2);
      r.send(chunk(2, true, third));
      await waitFor(() => r.rejected() === 1);
      expect((await r.reply())!.sealed).toHaveLength(2);
    });

    it('still reads a reply stored before chunking as a list of one', async () => {
      const r = await turn();
      const whole = envelope({ sender_device: COMPUTER });
      r.send(whole);
      await r.until(1);
      const reply = (await r.reply())!;
      const store = r.t.g.threads!.store as unknown as {
        db: DatabaseSync;
        cipher: CredentialCipher;
      };
      const row = store.db.prepare('SELECT thread_id FROM messages WHERE id=?').get(reply.id) as {
        thread_id: string;
      };
      store.db
        .prepare('UPDATE messages SET body=?, meta=? WHERE id=?')
        .run(
          JSON.stringify(
            store.cipher.seal(JSON.stringify(whole), messageAad('u1', row.thread_id, reply.id)),
          ),
          JSON.stringify({ author: 'agent', final: true }),
          reply.id,
        );
      expect((await r.reply())!.sealed).toEqual([whole]);
      const before = r.rejected();
      r.send(chunk(1, true));
      await waitFor(() => r.rejected() === before + 1);
    });

    it('gives the phone every chunk through the page, the thread list and live updates', async () => {
      const r = await turn();
      const service = r.t.g.threads!.service as unknown as {
        upsert(userId: string, message: ThreadMessage): void;
      };
      const live = vi.spyOn(service, 'upsert');
      const chunks = [chunk(0, false), chunk(1, true)];
      for (const c of chunks) r.send(c);
      await r.until(2);
      const lastLive = live.mock.calls
        .map(([, m]) => m)
        .filter((m) => m.kind === 'sealed' && m.author === 'agent')
        .at(-1);
      expect(lastLive).toMatchObject({ sealed: chunks });
      const summary = threadListResponseSchema
        .parse((await r.t.g.send('GET', '/v1/threads', { user: 'u1' })).json())
        .threads.find((entry) => entry.agent_id === r.t.agentId)!;
      expect(summary.last_message).toMatchObject({ kind: 'sealed', sealed: chunks });
    });
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
      sealed: envelope({
        sender_device: COMPUTER,
        body: 'U0VDUkVU',
        chunk: { index: 0, final: false },
      }),
      final: false,
    });
    await waitFor(async () => (await t.list()).length === 2);
    expect(push).not.toHaveBeenCalled();
    t.connector.send({
      type: 'sealed.reply',
      agent: t.localAgent,
      turn_id: posted.json.message.id,
      sealed: envelope({
        sender_device: COMPUTER,
        body: 'U0VDUkVU',
        chunk: { index: 1, final: true },
      }),
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
