/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Fastify inject JSON is untyped. */
import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  messagePageResponseSchema,
  SEALED_CHAT_FEATURE,
  SEALED_FILES_FEATURE,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { startFakeConnector } from './testing';

/** Sealed photos and files ride sealed messages, only to a computer that can open them (ADR-045). */

const PHONE = `dev_${'p'.repeat(20)}`;
const COMPUTER = `dev_${'c'.repeat(20)}`;
let seq = 0;
const envelope = (overrides: Partial<SealedEnvelopeV1> = {}): SealedEnvelopeV1 => ({
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
});

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

const OCTET = { 'content-type': 'application/octet-stream' };
const WITH_FILES = [SEALED_CHAT_FEATURE, SEALED_FILES_FEATURE];
const WITHOUT_FILES = [SEALED_CHAT_FEATURE];

async function setup(features: string[] = WITH_FILES) {
  const g = await startConnectorGateway({
    threads: { files: true, sweepIntervalMs: 20 },
    ring: {},
    env: { PRIVATE_CHATS_ENABLED: 'true', THREADS_ENABLED: 'true', FILES_ENABLED: 'true' },
  });
  gateways.push(g);
  const { connectorId, token, connector } = await g.connect('u1', { features });
  const agentId = await g.createAgent('u1', connectorId);
  const store = g.threads!.store;
  await store.setPrivate('u1', agentId);
  const idOf = (res: { json(): unknown }) => (res.json() as any).file.id as string;
  const phoneUpload = async (agent = agentId, user = 'u1') =>
    idOf(
      await g.send('POST', `/v1/agents/${agent}/files?client_id=${randomUUID()}&sealed=1`, {
        user,
        body: randomBytes(64),
        headers: OCTET,
      }),
    );
  const computerUpload = async () =>
    idOf(
      await g.send(
        'POST',
        `/v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&sealed=1`,
        { body: randomBytes(64), headers: { ...OCTET, authorization: `Bearer ${token}` } },
      ),
    );
  const post = (attachmentIds?: string[], agent = agentId) =>
    g.send('POST', `/v1/agents/${agent}/messages`, {
      user: 'u1',
      body: {
        client_id: randomUUID(),
        sealed: envelope(),
        ...(attachmentIds && { attachment_ids: attachmentIds }),
      },
    });
  const list = async () =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user: 'u1' })).json(),
    ).messages;
  const statusOf = async (id: string) => {
    const found = (await list()).find((m) => m.id === id);
    return found?.kind === 'sealed' ? found : undefined;
  };
  return {
    g,
    store,
    agentId,
    connectorId,
    token,
    connector,
    phoneUpload,
    computerUpload,
    post,
    list,
    statusOf,
  };
}

const rawDb = (store: unknown) => (store as { db: DatabaseSync }).db;

describe('sealed files and the computer that opens them (ADR-045)', () => {
  it('a sealed message links its sealed files and delivers to a computer with sealed_files', async () => {
    const t = await setup();
    const fileId = await t.phoneUpload();
    const res = await t.post([fileId]);
    expect(res.statusCode).toBe(201);
    const message = res.json().message;
    expect(message.status).toBe('sent');
    await waitFor(() => t.connector.sealed.length === 1);
    expect(t.store.findFile('u1', fileId)?.messageId).toBe(message.id);
    // Older apps parse attachments: a sealed message never lists them.
    expect(message.attachments).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain('attachment_ids');
    expect(JSON.stringify((await t.statusOf(message.id)) ?? {})).not.toContain(fileId);
  });

  it('a sealed message with no files still reaches a computer without sealed_files', async () => {
    const t = await setup(WITHOUT_FILES);
    const res = await t.post();
    expect(res.json().message.status).toBe('sent');
    await waitFor(() => t.connector.sealed.length === 1);
  });

  describe('fails files for a computer without sealed_files', () => {
    it('online: the message fails with computer_update and nothing is delivered', async () => {
      const t = await setup(WITHOUT_FILES);
      const fileId = await t.phoneUpload();
      const res = await t.post([fileId]);
      expect(res.statusCode).toBe(201);
      const message = res.json().message;
      expect(message.status).toBe('failed');
      expect(message.error_code).toBe('computer_update');
      await sleep(150);
      expect(t.connector.sealed).toHaveLength(0);
      expect(await t.statusOf(message.id)).toMatchObject({
        status: 'failed',
        error_code: 'computer_update',
      });
    });

    it('offline: queued, then failed when the computer returns without the word', async () => {
      const t = await setup(WITH_FILES);
      t.connector.terminate();
      await t.connector.closed;
      await waitFor(
        async () => (await t.g.send('GET', '/v1/agents', { user: 'u1' })).statusCode === 200,
      );
      const fileId = await t.phoneUpload();
      const res = await t.post([fileId]);
      const message = res.json().message;
      expect(message.status).toBe('queued');
      const back = startFakeConnector({
        url: t.g.socketUrl,
        token: t.token,
        features: WITHOUT_FILES,
      });
      await back.ready;
      await waitFor(async () => (await t.statusOf(message.id))?.status === 'failed');
      expect(await t.statusOf(message.id)).toMatchObject({ error_code: 'computer_update' });
      expect(back.sealed).toHaveLength(0);
      back.terminate();
    });

    it('offline: delivered when the computer returns with the word', async () => {
      const t = await setup(WITH_FILES);
      t.connector.terminate();
      await t.connector.closed;
      const fileId = await t.phoneUpload();
      const message = (await t.post([fileId])).json().message;
      expect(message.status).toBe('queued');
      const back = startFakeConnector({ url: t.g.socketUrl, token: t.token, features: WITH_FILES });
      await back.ready;
      await waitFor(() => back.sealed.length === 1);
      back.terminate();
    });
  });

  it('refuses a plain file id in a sealed message', async () => {
    const t = await setup();
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const plain = (
      await t.g.send('POST', `/v1/agents/${t.agentId}/files?client_id=${randomUUID()}&name=a.png`, {
        user: 'u1',
        body: png,
        headers: OCTET,
      })
    ).json().file.id as string;
    const res = await t.post([plain]);
    expect(res.statusCode).toBe(400);
    expect(t.store.findFile('u1', plain)?.messageId).toBeNull();
  });

  it("refuses another account's or another agent's file", async () => {
    const t = await setup();
    const other = await t.g.createAgent('u1', t.connectorId, 'gemini');
    await t.store.setPrivate('u1', other);
    const elsewhere = await t.phoneUpload(other);
    const own = await t.phoneUpload();
    expect((await t.post([elsewhere])).statusCode).toBe(400);
    // Another account's agent and file.
    const second = await t.g.connect('u2', { features: WITH_FILES });
    const agent2 = await t.g.createAgent('u2', second.connectorId);
    await t.store.setPrivate('u2', agent2);
    const theirs = await t.phoneUpload(agent2, 'u2');
    expect((await t.post([theirs])).statusCode).toBe(400);
    expect(t.store.findFile('u2', theirs)?.messageId).toBeNull();
    expect((await t.post([own])).statusCode).toBe(201);
  });

  it('a sealed reply with file_ids links them with direction agent', async () => {
    const t = await setup();
    const turn = (await t.post()).json().message;
    await waitFor(() => t.connector.sealed.length === 1);
    const fileId = await t.computerUpload();
    t.connector.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: turn.id,
      sealed: envelope({ sender_device: COMPUTER, chunk: { index: 0, final: true } }),
      final: true,
      file_ids: [fileId],
    });
    await waitFor(async () => (await t.statusOf(turn.id))?.status === 'answered');
    const row = t.store.findFile('u1', fileId)!;
    expect(row.direction).toBe('agent');
    expect(row.messageId).not.toBeNull();
    expect(row.messageId).not.toBe(turn.id);
    const reply = (await t.list()).find((m) => m.id === row.messageId);
    expect(reply).toMatchObject({ kind: 'sealed', author: 'agent' });
    expect(JSON.stringify(reply)).not.toContain('attachment_ids');
  });

  it('a sealed reply naming a file that is not the computer sealed file is dropped whole', async () => {
    const t = await setup();
    const turn = (await t.post()).json().message;
    await waitFor(() => t.connector.sealed.length === 1);
    const phoneFile = await t.phoneUpload();
    t.connector.send({
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: turn.id,
      sealed: envelope({ sender_device: COMPUTER, chunk: { index: 0, final: true } }),
      final: true,
      file_ids: [phoneFile],
    });
    await sleep(150);
    expect((await t.statusOf(turn.id))?.status).toBe('sent');
    expect((await t.list()).some((m) => m.kind === 'sealed' && m.author === 'agent')).toBe(false);
    expect(t.store.findFile('u1', phoneFile)?.messageId).toBeNull();
  });

  it('deleting the sealed message removes its blobs, and the dangling cleanup leaves linked ones alone', async () => {
    const t = await setup();
    const fileId = await t.phoneUpload();
    const message = (await t.post([fileId])).json().message;
    expect(t.store.danglingFiles()).not.toContain(fileId);
    const res = await t.g.send('DELETE', `/v1/agents/${t.agentId}/messages/${message.id}`, {
      user: 'u1',
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(t.store.findFile('u1', fileId)).toBeUndefined();
    // A message pruned from a full thread leaves its file dangling for the sweep.
    const second = await t.phoneUpload();
    const kept = (await t.post([second])).json().message;
    rawDb(t.store).prepare('DELETE FROM messages WHERE id=?').run(kept.id);
    expect(t.store.danglingFiles()).toContain(second);
  });

  it('delete my data removes sealed blobs', async () => {
    const t = await setup();
    const fileId = await t.phoneUpload();
    await t.post([fileId]);
    await t.g.threads!.service.deleteAllForUser('u1');
    expect(t.store.findFile('u1', fileId)).toBeUndefined();
    expect(rawDb(t.store).prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
  });
});
