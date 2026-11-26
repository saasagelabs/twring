/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Fastify inject JSON is untyped. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CAN_SEAL_HEADER,
  MAX_FILE_BYTES,
  SEALED_FILE_OVERHEAD,
  type SealedEnvelopeV1,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, TEST_KEYS, type ConnectorGateway } from '../connectors/harness';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { SqliteThreadStore } from '../threads/store';
import { FileBlobStore } from './blobs';
import { FileService } from './service';

const PHONE = `dev_${'p'.repeat(20)}`;
const COMPUTER = `dev_${'c'.repeat(20)}`;
let seq = 0;
const envelope = (): SealedEnvelopeV1 => ({
  v: 1,
  sender_device: PHONE,
  sender_seq: ++seq,
  nonce: 'bm9uY2Vub25jZW5vbmNlbm9uY2U',
  body: 'Y2lwaGVydGV4dA',
  keys: [
    { device: PHONE, wrapped: 'd3JhcHBlZA' },
    { device: COMPUTER, wrapped: 'd3JhcHBlZA' },
  ],
});

let gateway: ConnectorGateway | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OCTET = { 'content-type': 'application/octet-stream' };

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
  const store = g.threads!.store;
  const auth = { authorization: `Bearer ${token}` };
  const phoneUpload = (bytes: Buffer, query = 'sealed=1', clientId = randomUUID()) =>
    g.send('POST', `/v1/agents/${agentId}/files?client_id=${clientId}&${query}`, {
      user: 'u1',
      body: bytes,
      headers: OCTET,
    });
  const computerUpload = (
    bytes: Buffer,
    query = 'sealed=1',
    headers: Record<string, string> = {},
    localAgent = 'claude-code',
  ) =>
    g.send(
      'POST',
      `/v1/connectors/files?local_agent=${localAgent}&client_id=${randomUUID()}&${query}`,
      { body: bytes, headers: { ...OCTET, ...auth, ...headers } },
    );
  const sealedMessage = async (author: 'user' | 'agent') =>
    (await store.appendSealedMessage('u1', agentId, { author, sealed: envelope() })).message;
  const idOf = (res: { json(): unknown }) => (res.json() as any).file.id as string;
  return {
    g,
    store,
    agentId,
    connectorId,
    token,
    auth,
    phoneUpload,
    computerUpload,
    sealedMessage,
    idOf,
  };
}

const rawDb = (store: SqliteThreadStore) => (store as unknown as { db: DatabaseSync }).db;
const blob = (size = 64) => randomBytes(size);

describe('sealed files on the gateway (ADR-045)', () => {
  it('stores a sealed upload without sniffing, as sealed.bin', async () => {
    const t = await setup();
    const res = await t.phoneUpload(blob(200), 'sealed=1&name=secret.png');
    expect(res.statusCode).toBe(201);
    const row = t.store.findFile('u1', t.idOf(res))!;
    expect(row.sealed).toBe(true);
    expect(row.mime_type).toBe('application/octet-stream');
    expect(row.name).toBe('sealed.bin');
    expect(row.direction).toBe('owner');
    expect(row.size_bytes).toBe(200);
    // The same client id answers with the same file.
    const clientId = randomUUID();
    const first = await t.phoneUpload(blob(80), 'sealed=1', clientId);
    const again = await t.phoneUpload(blob(80), 'sealed=1', clientId);
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(t.idOf(again)).toBe(t.idOf(first));
  });

  it('refuses a sealed upload into a chat that is not private', async () => {
    const t = await setup(false);
    const phone = await t.phoneUpload(blob());
    expect(phone.statusCode).toBe(409);
    expect(phone.json().error.code).toBe('not_private');
    const computer = await t.computerUpload(blob());
    expect(computer.statusCode).toBe(409);
    expect(computer.json().error.code).toBe('not_private');
  });

  it('refuses a sealed blob over MAX_FILE_BYTES plus overhead, and one of overhead size or less', async () => {
    const t = await setup();
    const limit = MAX_FILE_BYTES + SEALED_FILE_OVERHEAD;
    expect((await t.phoneUpload(blob(limit + 1))).statusCode).toBe(413);
    expect((await t.computerUpload(blob(limit + 1))).statusCode).toBe(413);
    expect((await t.phoneUpload(blob(SEALED_FILE_OVERHEAD))).statusCode).toBe(400);
    expect((await t.computerUpload(blob(SEALED_FILE_OVERHEAD))).statusCode).toBe(400);
    expect((await t.phoneUpload(blob(1))).statusCode).toBe(400);
    // The largest and the smallest allowed sizes go through.
    expect((await t.phoneUpload(blob(limit))).statusCode).toBe(201);
    expect((await t.phoneUpload(blob(SEALED_FILE_OVERHEAD + 1))).statusCode).toBe(201);
  });

  it('a plain connector upload marked twring-can-seal into a private chat gets seal_required and stores nothing', async () => {
    const t = await setup();
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(10, 20);
    const res = await t.computerUpload(png, 'name=pic.png', { [CAN_SEAL_HEADER]: '1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('seal_required');
    const rows = rawDb(t.store).prepare('SELECT count(*) AS n FROM files').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
    // The same mark into a chat that is not private stores as before.
    const open = await setup(false);
    expect(
      (await open.computerUpload(png, 'name=pic.png', { [CAN_SEAL_HEADER]: '1' })).statusCode,
    ).toBe(201);
  });

  it('a plain connector upload without the mark still works into a private chat', async () => {
    const t = await setup();
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(10, 20);
    const res = await t.computerUpload(png, 'name=pic.png');
    expect(res.statusCode).toBe(201);
    expect(t.store.findFile('u1', t.idOf(res))!.sealed).toBe(false);
  });

  it('sealed files never appear as attachments', async () => {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob()));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    expect(t.store.findFile('u1', fileId)!.messageId).toBe(message.id);

    // Thread messages: the sealed message has no attachments, and neither does the list.
    const list = await t.g.send('GET', `/v1/agents/${t.agentId}/messages`, { user: 'u1' });
    expect(list.statusCode).toBe(200);
    const listed = list.json().messages as Record<string, unknown>[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('attachments');
    expect(JSON.stringify(list.json())).not.toContain(fileId);

    // Even a forged attachment list on a plain message never yields a sealed row.
    const plain = await t.store.appendUserMessage('u1', `agt_${'z'.repeat(20)}`, {
      text: 'hello',
      clientId: randomUUID(),
      status: 'sent',
    });
    rawDb(t.store)
      .prepare('UPDATE messages SET meta=? WHERE id=?')
      .run(JSON.stringify({ attachment_ids: [fileId] }), plain.message.id);
    rawDb(t.store)
      .prepare('UPDATE files SET message_id=? WHERE id=?')
      .run(plain.message.id, fileId);
    const [decoded] = await t.store.ownerReplies('u1', `agt_${'z'.repeat(20)}`);
    expect(decoded?.attachments).toBeUndefined();

    // Media.
    const media = await t.store.listMedia('u1', t.agentId, { limit: 10 });
    expect(media.items).toEqual([]);
    const route = await t.g.send('GET', `/v1/agents/${t.agentId}/media`, { user: 'u1' });
    expect(JSON.stringify(route.json())).not.toContain(fileId);

    // No mapper turns a sealed row into an Attachment.
    expect(() => t.store.attachment(t.store.findFile('u1', fileId)!)).toThrow();
  });

  it('the signed link answers 404 for a sealed file', async () => {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob()));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const { files } = (t.g.threads!.service as unknown as { options: { files: FileService } })
      .options;
    const link = files.signedLink(fileId);
    const res = await t.g.send('GET', link.replace('http://localhost:8080', ''));
    expect(res.statusCode).toBe(404);
  });

  it('the phone reads a sealed blob only once it is attached to a sealed message in that chat', async () => {
    const t = await setup();
    const bytes = blob(300);
    const fileId = t.idOf(await t.phoneUpload(bytes));
    const read = () => t.g.send('GET', `/v1/agents/${t.agentId}/files/${fileId}`, { user: 'u1' });
    expect((await read()).statusCode).toBe(404);
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
    // Another person does not see it.
    expect(
      (await t.g.send('GET', `/v1/agents/${t.agentId}/files/${fileId}`, { user: 'u2' })).statusCode,
    ).toBe(404);
  });

  it("the computer reads a phone's sealed blob for its own agent only", async () => {
    const t = await setup();
    const bytes = blob(300);
    const fileId = t.idOf(await t.phoneUpload(bytes));
    const read = (
      id = fileId,
      localAgent = 'claude-code',
      headers: Record<string, string> = t.auth,
    ) => t.g.send('GET', `/v1/connectors/files/${id}?local_agent=${localAgent}`, { headers });
    // Unattached.
    expect((await read()).statusCode).toBe(404);
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const res = await read();
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // No token, another connector, another local agent.
    expect((await read(fileId, 'claude-code', {})).statusCode).toBe(401);
    const other = await t.g.connect('u1');
    expect(
      (await read(fileId, 'claude-code', { authorization: `Bearer ${other.token}` })).statusCode,
    ).toBe(404);
    expect((await read(fileId, 'codex')).statusCode).toBe(404);
    expect((await read(fileId, 'not a name!')).statusCode).toBe(400);
    // A file the computer sent itself (agent direction) is not served back to it.
    const own = t.idOf(await t.computerUpload(blob(100)));
    const reply = await t.sealedMessage('agent');
    t.store.attachFiles('u1', t.agentId, reply.id, [own], 'agent');
    expect((await read(own)).statusCode).toBe(404);
    // An unknown id.
    expect((await read(`fil_${'a'.repeat(20)}`)).statusCode).toBe(404);
  });

  it('a computer can read more sealed files in a minute than it can upload', async () => {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob(50)));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await t.g.send('GET', `/v1/connectors/files/${fileId}?local_agent=claude-code`, {
        headers: t.auth,
      });
      codes.push(res.statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it('uploads still hit the upload limit', async () => {
    const t = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await t.computerUpload(blob(100))).statusCode);
    expect(codes[29]).toBe(201);
    expect(codes[30]).toBe(429);
  });

  it('the phone can read more sealed files in a minute than it can upload', async () => {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob(50)));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await t.g.send('GET', `/v1/agents/${t.agentId}/files/${fileId}`, {
        user: 'u1',
      });
      codes.push(res.statusCode);
    }
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  it('only sealed rows link to sealed messages, and only plain rows to plain ones', async () => {
    const t = await setup();
    const sealedId = t.idOf(await t.phoneUpload(blob()));
    const message = await t.sealedMessage('user');
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const plain = await t.g.send(
      'POST',
      `/v1/agents/${t.agentId}/files?client_id=${randomUUID()}&name=a.png`,
      { user: 'u1', body: png, headers: OCTET },
    );
    const plainId = t.idOf(plain);
    expect(() => t.store.attachFiles('u1', t.agentId, message.id, [plainId], 'owner')).toThrow();
    const text = await t.store.appendUserMessage('u1', t.agentId, {
      text: 'x',
      clientId: randomUUID(),
      status: 'sent',
    });
    expect(() =>
      t.store.attachFiles('u1', t.agentId, text.message.id, [sealedId], 'owner'),
    ).toThrow();
  });

  it('removing a sealed message removes its file rows', async () => {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob()));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const removed = await t.store.deleteMessage('u1', t.agentId, message.id);
    expect(removed).toEqual({ result: 'deleted', fileIds: [fileId] });
    expect(t.store.findFile('u1', fileId)).toBeUndefined();
  });
});

describe("a sealed file's blob is removed from disk", () => {
  async function stored() {
    const t = await setup();
    const fileId = t.idOf(await t.phoneUpload(blob()));
    const message = await t.sealedMessage('user');
    t.store.attachFiles('u1', t.agentId, message.id, [fileId], 'owner');
    const blobs = (t.g.threads!.service as any).options.files.blobs as FileBlobStore;
    // The blob is on disk now; it is gone after the action under test.
    await expect(blobs.read(fileId)).resolves.toBeInstanceOf(Buffer);
    const gone = () => expect(blobs.read(fileId)).rejects.toMatchObject({ code: 'ENOENT' });
    return { t, message, gone };
  }

  it("a sealed file's blob is removed from disk on message delete", async () => {
    const { t, message, gone } = await stored();
    await t.g.threads!.service.deleteMessage('u1', t.agentId, message.id);
    await gone();
  });

  it("a sealed file's blob is removed from disk on clear chat", async () => {
    const { t, gone } = await stored();
    await t.g.threads!.service.clear('u1', t.agentId);
    await gone();
  });

  it("a sealed file's blob is removed from disk on delete chat", async () => {
    const { t, gone } = await stored();
    await t.g.threads!.service.deleteAgent('u1', t.agentId);
    await gone();
  });

  it("a sealed file's blob is removed from disk on delete my data", async () => {
    const { t, gone } = await stored();
    await t.g.threads!.service.deleteAllForUser('u1');
    await gone();
  });
});

describe('sealed blobs count against the limits', () => {
  it('quota and daily limits count sealed blobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'twring-sealed-quota-'));
    dirs.push(dir);
    const store = new SqliteThreadStore(
      ':memory:',
      new CredentialCipher(messageKeys(TEST_KEYS)),
      () => new Date('2026-11-26T10:00:00Z'),
      { quotaBytes: 100, perDay: 2 },
    );
    const files = new FileService(store, new FileBlobStore(dir), TEST_KEYS, 'http://localhost');
    const upload = (size: number) =>
      files.upload({
        userId: 'u1',
        agentId: `agt_${'a'.repeat(20)}`,
        clientId: randomUUID(),
        name: 'ignored.png',
        bytes: blob(size),
        sealed: true,
      });
    await upload(60);
    await expect(upload(60)).rejects.toMatchObject({ code: 'storage_full' });
    await upload(30);
    await expect(upload(1)).rejects.toMatchObject({ code: 'files_daily_limit' });
    await store.close();
  });
});
