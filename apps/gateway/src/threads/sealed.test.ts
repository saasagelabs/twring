/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import {
  MAX_SEALED_BODY_CHARS,
  SEALED_CHAT_FEATURE,
  type SealedEnvelopeV1,
  type ThreadMessage,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

const FLAG_ON = { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true' };
const PHONE = `dev_${'p'.repeat(20)}`;
const COMPUTER = `dev_${'c'.repeat(20)}`;
let seq = 0;

export function envelope(overrides: Partial<SealedEnvelopeV1> = {}): SealedEnvelopeV1 {
  return {
    v: 1,
    sender_device: PHONE,
    sender_seq: ++seq,
    nonce: 'bm9uY2Vub25jZW5vbmNlbm9uY2U',
    body: 'Y2lwaGVydGV4dA',
    keys: [
      { device: PHONE, wrapped: 'd3JhcHBlZA' },
      { device: COMPUTER, wrapped: 'd3JhcHBlZA' },
    ],
    ...overrides,
  };
}

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

interface Thread {
  g: ConnectorGateway;
  agentId: string;
  postMessage(body: Record<string, unknown>): Promise<{ status: number; json: any }>;
  setPrivate(on: boolean, features?: string): Promise<{ status: number; json: any }>;
  list(): Promise<{ messages: ThreadMessage[] }>;
}

async function thread(
  options: { connectorFeatures?: string[]; env?: Record<string, string> } = {},
): Promise<Thread> {
  const g = await startConnectorGateway({ threads: {}, ring: {}, env: options.env ?? FLAG_ON });
  gateway = g;
  const { connectorId } = await g.connect('u1', {
    features: options.connectorFeatures ?? [SEALED_CHAT_FEATURE],
  });
  const agentId = await g.createAgent('u1', connectorId);
  const wrap = (res: { statusCode: number; json(): unknown }) => ({
    status: res.statusCode,
    json: res.json() as any,
  });
  return {
    g,
    agentId,
    postMessage: async (body) =>
      wrap(await g.send('POST', `/v1/agents/${agentId}/messages`, { user: 'u1', body })),
    setPrivate: async (on, features = SEALED_CHAT_FEATURE) =>
      wrap(
        await g.send('PUT', `/v1/agents/${agentId}/private`, {
          user: 'u1',
          body: { on },
          headers: { 'x-twring-features': features },
        }),
      ),
    list: async () =>
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
  };
}

async function privateThread(options: { env?: Record<string, string> } = {}): Promise<Thread> {
  const t = await thread(options);
  const res = await t.setPrivate(true);
  if (res.status !== 200) throw new Error(`setPrivate ${res.status} ${JSON.stringify(res.json)}`);
  return t;
}

describe('private threads', () => {
  it('refuses plaintext into a private thread', async () => {
    const t = await privateThread();
    const res = await t.postMessage({ client_id: randomUUID(), text: 'hi' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('private_thread');
  });

  it('stores and lists a sealed message without text', async () => {
    const t = await privateThread();
    const sealed = envelope();
    const res = await t.postMessage({ client_id: randomUUID(), sealed });
    expect(res.status).toBe(201);
    const [m] = (await t.list()).messages;
    expect(m).toMatchObject({ kind: 'sealed', author: 'user', sealed });
    expect(JSON.stringify(m)).not.toContain('"text"');
  });

  it('refuses a sealed message into a thread that is not private', async () => {
    const t = await thread();
    const res = await t.postMessage({ client_id: randomUUID(), sealed: envelope() });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('not_private');
  });

  it('refuses to make a thread private when the connector is old', async () => {
    const t = await thread({ connectorFeatures: [] });
    const res = await t.setPrivate(true);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('private_unsupported');
  });

  it('refuses to make a thread private when the app is old', async () => {
    const t = await thread();
    expect((await t.setPrivate(true, '')).json.error.code).toBe('private_unsupported');
  });

  it('refuses for an account outside the allowlist, and when the flag is off', async () => {
    const listed = await thread({ env: { ...FLAG_ON, PRIVATE_CHATS_USERS: 'owner' } });
    expect((await listed.setPrivate(true)).json.error.code).toBe('private_chats_off');
    await gateway?.close();
    const off = await thread({ env: {} });
    expect((await off.setPrivate(true)).json.error.code).toBe('private_chats_off');
    expect((await off.postMessage({ client_id: randomUUID(), sealed: envelope() })).status).toBe(
      409,
    );
  });

  it('keeps a private thread private', async () => {
    const t = await privateThread();
    const res = await t.setPrivate(false);
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('private_is_one_way');
    expect((await t.setPrivate(true)).status).toBe(200);
  });

  it('marks the thread private in the thread list', async () => {
    const t = await privateThread();
    await t.postMessage({ client_id: randomUUID(), sealed: envelope() });
    const list = (await t.g.send('GET', '/v1/threads', { user: 'u1' })).json();
    const summary = list.threads.find((entry) => entry.agent_id === t.agentId)!;
    expect(summary.private).toBe(true);
    expect(summary.last_message.kind).toBe('sealed');
  });

  it('refuses a sealed body over the ciphertext cap', async () => {
    const t = await privateThread();
    const big = envelope({ body: 'A'.repeat(MAX_SEALED_BODY_CHARS + 1) });
    expect((await t.postMessage({ client_id: randomUUID(), sealed: big })).status).toBe(400);
  });

  it('refuses a malformed wrapped key list', async () => {
    const t = await privateThread();
    const res = await t.postMessage({
      client_id: randomUUID(),
      sealed: envelope({ keys: [{ device: PHONE, wrapped: 'x'.repeat(129) }] }),
    });
    expect(res.status).toBe(400);
  });

  it('dedupes a retried post by client id', async () => {
    const t = await privateThread();
    const clientId = randomUUID();
    const first = await t.postMessage({ client_id: clientId, sealed: envelope() });
    const again = await t.postMessage({ client_id: clientId, sealed: envelope() });
    expect(again.status).toBe(200);
    expect(again.json.message.id).toBe(first.json.message.id);
    expect((await t.list()).messages).toHaveLength(1);
  });

  it('keeps the sealed body encrypted at rest', async () => {
    const t = await privateThread();
    await t.postMessage({ client_id: randomUUID(), sealed: envelope({ body: 'UExBSU5NQVJLRVI' }) });
    const store = t.g.threads!.store as unknown as {
      db: { prepare(sql: string): { all(): { body: string | null; meta: string }[] } };
    };
    const rows = store.db.prepare('SELECT body, meta FROM messages').all();
    expect(JSON.stringify(rows)).not.toContain('UExBSU5NQVJLRVI');
  });
});

describe('server features that read text skip private chats', () => {
  it('a reply to a sealed message gets no server quote', async () => {
    const t = await privateThread();
    const m = await t.postMessage({ client_id: randomUUID(), sealed: envelope() });
    const r = await t.postMessage({
      client_id: randomUUID(),
      sealed: envelope(),
      reply_to: m.json.message.id,
    });
    expect(r.status).toBe(201);
    expect(r.json.message.reply_to).toBe(m.json.message.id);
    expect(r.json.message.quote).toBeUndefined();
  });

  it('a reply to a message outside the thread is refused', async () => {
    const t = await privateThread();
    const r = await t.postMessage({
      client_id: randomUUID(),
      sealed: envelope(),
      reply_to: `msg_${'q'.repeat(20)}`,
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('reply_to_not_found');
  });

  it('a message push from a private chat carries only the fixed text', async () => {
    const t = await privateThread();
    const push = vi.spyOn(t.g.ring!.service, 'pushMessage');
    await t.g.threads!.service.deliverResult('u1', t.agentId, {
      text: 'The secret plan is ready',
      origin: 'agent',
      idempotencyKey: 'k1',
      target: { agentName: 'Laptop Claude' },
    });
    expect(push).toHaveBeenCalledTimes(1);
    const payload = push.mock.calls[0]![1];
    expect(payload.preview).toBe('New message');
    expect(JSON.stringify(payload)).not.toContain('secret');
  });

  it('a ring from a private chat says only that the agent wants to talk', async () => {
    const t = await privateThread();
    const ring = vi
      .spyOn(t.g.ring!.service, 'ring')
      .mockResolvedValue({ refused: 'no_ring_phone' } as never);
    await t.g.threads!.service.deliverResult('u1', t.agentId, {
      text: 'The secret plan is ready. More below.',
      origin: 'call_turn',
      idempotencyKey: 'k2',
      target: { agentName: 'Laptop Claude' },
    });
    expect(ring).toHaveBeenCalledTimes(1);
    expect(ring.mock.calls[0]![0].reason).toBe('Wants to talk');
  });

  it('a ring recorded in a private chat keeps no reason text', async () => {
    const t = await privateThread();
    await t.g.threads!.service.recordRing({
      user_id: 'u1',
      agent_id: t.agentId,
      id: `inv_${'a'.repeat(26)}`,
      reason: 'The secret plan is ready',
      status: 'missed',
    });
    const ring = (await t.list()).messages.find((m) => m.kind === 'ring');
    expect(ring).toMatchObject({ reason: 'Wants to talk' });
  });

  it('a settled ring pushes the fixed text for a private chat', async () => {
    const t = await privateThread();
    const saved = await t.g.threads!.service.deliverResult('u1', t.agentId, {
      text: 'The secret plan is ready',
      origin: 'text_turn',
      idempotencyKey: 'k3',
      target: { agentName: 'Laptop Claude' },
    });
    const push = vi.spyOn(t.g.ring!.service, 'pushMessage');
    await t.g.threads!.service.pushSettledResult({
      user_id: 'u1',
      agent_id: t.agentId,
      agent_name: 'Laptop Claude',
      status: 'missed',
      message_id: saved.messageId,
    });
    expect(push.mock.calls.at(-1)![1].preview).toBe('New message');
  });

  it('a chat that is not private keeps its preview', async () => {
    const t = await thread();
    const push = vi.spyOn(t.g.ring!.service, 'pushMessage');
    await t.g.threads!.service.deliverResult('u1', t.agentId, {
      text: 'Plain result',
      origin: 'agent',
      idempotencyKey: 'k4',
      target: { agentName: 'Laptop Claude' },
    });
    expect(push.mock.calls[0]![1].preview).toBe('Plain result');
  });
});
