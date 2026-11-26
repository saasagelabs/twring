/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  base64urlEncode,
  CAN_SEAL_HEADER,
  deviceIdFor,
  generateSealKeyPair,
  MAX_SEALED_REPLY_CHUNKS,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { PRIVATE_PUSH_TEXT, PRIVATE_RING_REASON } from '../e2e/guard';
import type { SqliteThreadStore } from '../threads/store';

import { startConnectorGateway, type ConnectorGateway } from './harness';

/** The computer's own messages into a private chat arrive sealed (ADR-045, rulings 17 and 18). */

const PHONE = `dev_${'p'.repeat(20)}`;
const SECRET = 'plaintext-that-must-not-leak';

let gateway: ConnectorGateway | undefined;
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

/** The columns the tests read from a stored message. */
interface SealedRow {
  turn_id: string | null;
  meta: string;
}
interface Page {
  messages: { kind: string; author: string; text?: string; sealed?: unknown[] }[];
}
const pageOf = (res: { json(): unknown }) => res.json() as Page;

const rawDb = (store: SqliteThreadStore) => (store as unknown as { db: DatabaseSync }).db;

async function setup(privateChat = true) {
  const g = await startConnectorGateway({
    threads: { files: true },
    ring: {},
    env: { THREADS_ENABLED: 'true', FILES_ENABLED: 'true' },
  });
  gateway = g;
  const { connectorId, token } = await g.connect('u1');
  const agentId = await g.createAgent('u1', connectorId);
  if (privateChat) await g.threads!.store.setPrivate('u1', agentId);
  const keys = generateSealKeyPair();
  const computer = deviceIdFor(keys.publicKey);
  g.e2e.add('u1', {
    id: computer,
    kind: 'computer',
    name: 'Laptop',
    public_key: base64urlEncode(keys.publicKey),
    connector_id: connectorId,
  });
  await g.ring!.stores.devices.upsert({
    user_id: 'u1',
    device_id: 'phone-u1',
    fcm_token: 'fcm-u1-aaaaaaaaaaaaaaaaaaaaaa',
    platform: 'android',
    app_variant: 'beta',
    updated_at: new Date().toISOString(),
  });
  let seq = 0;
  const envelope = (over: Partial<SealedEnvelopeV1> = {}, sender = computer): SealedEnvelopeV1 => ({
    v: 1,
    sender_device: sender,
    sender_seq: 1000 + seq,
    nonce: 'bm9uY2Vub25jZW5vbmNlbm9uY2U',
    body: 'Y2lwaGVydGV4dA',
    keys: [
      { device: PHONE, wrapped: 'd3JhcHBlZA' },
      { device: computer, wrapped: 'd3JhcHBlZA' },
    ],
    ...over,
  });
  const nextSeq = () => ++seq;
  const post = (
    body: Record<string, unknown>,
    key = 'key-1',
    headers: Record<string, string> = {},
  ) =>
    g.send('POST', '/v1/connectors/messages', {
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, ...headers },
      body: { local_agent: 'claude-code', origin: 'agent', ...body },
    });
  const rows = () =>
    rawDb(g.threads!.store)
      .prepare("SELECT * FROM messages WHERE kind='sealed'")
      .all() as unknown as SealedRow[];
  const total = () =>
    (rawDb(g.threads!.store).prepare('SELECT count(*) AS n FROM messages').get() as { n: number })
      .n;
  return { g, token, agentId, computer, envelope, nextSeq, post, rows, total };
}

describe('a sealed post from the computer (ADR-045)', () => {
  it('stores a sealed post as a sealed agent message with no turn and pushes New message', async () => {
    const t = await setup();
    const res = await t.post({ sealed: [t.envelope()] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ delivery: 'push' });
    const rows = t.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turn_id).toBeNull();
    expect(JSON.parse(rows[0]!.meta)).toMatchObject({ author: 'agent' });
    const page = pageOf(await t.g.send('GET', `/v1/agents/${t.agentId}/messages`, { user: 'u1' }));
    expect(page.messages[0]).toMatchObject({ kind: 'sealed', author: 'agent' });
    expect(t.g.ring!.pushes).toHaveLength(1);
    expect(JSON.stringify(t.g.ring!.pushes)).toContain(PRIVATE_PUSH_TEXT);
  });

  it('stores every chunk of a multi-envelope post', async () => {
    const t = await setup();
    const seq = 1000 + t.nextSeq();
    const sealed = [0, 1, 2].map((index) =>
      t.envelope({ sender_seq: seq, chunk: { index, final: index === 2 } }),
    );
    const res = await t.post({ sealed });
    expect(res.statusCode).toBe(201);
    const page = pageOf(await t.g.send('GET', `/v1/agents/${t.agentId}/messages`, { user: 'u1' }));
    expect(page.messages[0]!.sealed).toHaveLength(3);
  });

  it('rings with the private reason when a background result rings', async () => {
    const t = await setup();
    const res = await t.post({ sealed: [t.envelope()], origin: 'call_turn' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ delivery: 'ring' });
    const pushed = JSON.stringify(t.g.ring!.pushes);
    expect(pushed).toContain(PRIVATE_RING_REASON);
    expect(pushed).not.toContain(SECRET);
  });

  it('refuses a sealed post from another device than this computer', async () => {
    const t = await setup();
    const other = `dev_${'z'.repeat(20)}`;
    const res = await t.post({ sealed: [t.envelope({}, other)] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('wrong_device');
    // A phone device of the same account is not this computer either.
    expect((await t.post({ sealed: [t.envelope({}, PHONE)] }, 'key-2')).statusCode).toBe(403);
    expect(t.total()).toBe(0);
  });

  it('refuses a sealed post into a chat that is not private', async () => {
    const t = await setup(false);
    const res = await t.post({ sealed: [t.envelope()] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_private');
    expect(t.total()).toBe(0);
  });

  it('a plain post marked twring-can-seal into a private chat gets seal_required and stores nothing', async () => {
    const t = await setup();
    const res = await t.post({ text: SECRET }, 'key-1', { [CAN_SEAL_HEADER]: '1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('seal_required');
    expect(t.total()).toBe(0);
    // The same mark into a chat that is not private goes in as before.
    const open = await setup(false);
    expect((await open.post({ text: 'hi' }, 'key-1', { [CAN_SEAL_HEADER]: '1' })).statusCode).toBe(
      201,
    );
  });

  it('a plain post without the mark still goes in readable and marked', async () => {
    const t = await setup();
    const res = await t.post({ text: 'Build passed.' });
    expect(res.statusCode).toBe(201);
    const page = pageOf(await t.g.send('GET', `/v1/agents/${t.agentId}/messages`, { user: 'u1' }));
    expect(page.messages[0]).toMatchObject({ kind: 'agent_text', text: 'Build passed.' });
  });

  it('the same Idempotency-Key twice stores one message', async () => {
    const t = await setup();
    const first = await t.post({ sealed: [t.envelope()] }, 'key-1:sealed');
    const again = await t.post({ sealed: [t.envelope()] }, 'key-1:sealed');
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json().message_id).toBe(first.json().message_id);
    expect(t.rows()).toHaveLength(1);
    expect(t.g.ring!.pushes).toHaveLength(1);
  });

  it('refuses more chunks than MAX_SEALED_REPLY_CHUNKS and mixed seqs', async () => {
    const t = await setup();
    const seq = 1000 + t.nextSeq();
    const many = Array.from({ length: MAX_SEALED_REPLY_CHUNKS + 1 }, (_, index) =>
      t.envelope({ sender_seq: seq, chunk: { index, final: index === MAX_SEALED_REPLY_CHUNKS } }),
    );
    expect((await t.post({ sealed: many })).statusCode).toBe(400);
    const mixed = [
      t.envelope({ sender_seq: seq, chunk: { index: 0, final: false } }),
      t.envelope({ sender_seq: seq + 1, chunk: { index: 1, final: true } }),
    ];
    expect((await t.post({ sealed: mixed }, 'key-2')).statusCode).toBe(400);
    const gap = [
      t.envelope({ sender_seq: seq, chunk: { index: 0, final: false } }),
      t.envelope({ sender_seq: seq, chunk: { index: 2, final: true } }),
    ];
    expect((await t.post({ sealed: gap }, 'key-3')).statusCode).toBe(400);
    expect(t.total()).toBe(0);
  });

  it('refuses a sealed post that names a plain file', async () => {
    const t = await setup();
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(10, 20);
    const plain = await t.g.send(
      'POST',
      `/v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&name=pic.png`,
      {
        body: png,
        headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${t.token}` },
      },
    );
    expect(plain.statusCode).toBe(201);
    const res = await t.post({ sealed: [t.envelope()], file_ids: [plain.json().file.id] });
    expect(res.statusCode).toBe(400);
    expect(t.total()).toBe(0);
  });
});
