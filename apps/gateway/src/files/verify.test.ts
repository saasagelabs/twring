/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { createLoggerOptions } from '../logger';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { ThreadService } from '../threads/service';
import { SqliteThreadStore } from '../threads/store';
import { FileBlobStore } from './blobs';
import { cleanFileName, FileService } from './service';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const agent = `agt_${'a'.repeat(20)}`;
const other = `agt_${'b'.repeat(20)}`;
const open: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const app of open.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const png = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(20, 16);
png.writeUInt32BE(10, 20);
const octet = { 'content-type': 'application/octet-stream' };

async function setup(
  options: {
    limits?: { quotaBytes: number; perDay: number };
    withAuth?: boolean;
    membersFile?: string;
    holdFirstTurn?: boolean;
    logSink?: Writable;
  } = {},
) {
  const limits = options.limits ?? { quotaBytes: 100_000, perDay: 100 };
  const dir = mkdtempSync(join(tmpdir(), 'cord-verify-'));
  dirs.push(dir);
  const stores = createMemoryStores(keys);
  const db = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(messageKeys(keys)),
    () => new Date(),
    limits,
  );
  const blobs = new FileBlobStore(join(dir, 'files'));
  const files = new FileService(db, blobs, keys, 'http://localhost:8080');
  for (const id of [agent, other])
    await stores.agents.create({
      id,
      user_id: 'alice',
      name: 'Agent',
      protocol: 'cord-rest',
      endpoint_url: 'https://example.com/agent',
      voice_id: 'flux-aura-en',
      status: 'ready',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  const turns: { text: string; attachments?: { url: string; id: string; expires_at: string }[] }[] =
    [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const service = new ThreadService({
    store: db,
    files,
    agents: stores.agents,
    agentFactory: () => () =>
      Promise.resolve({
        name: 'fake',
        capabilities: {
          streamingText: true,
          cancellation: true,
          resumableStream: false,
          activityEvents: false,
          toolEvents: false,
          approvals: false,
          conversationResume: false,
          serverInitiatedCalls: false,
        },
        connect: () => Promise.resolve(),
        async *sendTurn(turn) {
          const first = turns.length === 0;
          turns.push(turn);
          if (first && options.holdFirstTurn) await gate;
          else await Promise.resolve();
          yield {
            type: 'done' as const,
            event_id: randomUUID(),
            turn_id: turn.turnId,
            status: 'completed' as const,
          };
        },
        close: () => Promise.resolve(),
      }),
    agentStatus: () => 'online',
    hasLiveCallToAgent: () => false,
    notify: () => undefined,
  });
  await service.start();
  const env = loadGatewayEnv(
    gatewayEnvFixture({
      THREADS_ENABLED: 'true',
      FILES_ENABLED: 'true',
      LOG_LEVEL: 'info',
      ...(options.membersFile && { BETA_MEMBERS_FILE: options.membersFile }),
    }),
  );
  const auth = options.withAuth
    ? createRequestAuth((request) => {
        const user = request.headers['x-user'];
        if (typeof user !== 'string')
          return Promise.reject(new AuthError(401, 'auth_required', 'Sign in.'));
        const email = request.headers['x-email'];
        return Promise.resolve({ id: user, ...(typeof email === 'string' && { email }) });
      })
    : undefined;
  const app = buildApp({
    env,
    ...(auth ? { auth } : { userFor: (request) => String(request.headers['x-user'] ?? 'alice') }),
    ...(options.logSink && { logger: { ...createLoggerOptions(env), stream: options.logSink } }),
    agents: { stores, policy: { env: 'development' }, writeRatePerMinute: 100 },
    threads: {
      service,
      store: db,
      writeRatePerMinute: 100,
      readRatePerMinute: 100,
      messagesPerDay: 100,
    },
    files: {
      service: files,
      agents: stores.agents,
      readRatePerMinute: 100,
      uploadRatePerMinute: 1000,
    },
  });
  open.push({
    close: async () => {
      release();
      service.stop();
      await app.close();
      await db.close();
    },
  });
  const upload = (
    body: Buffer,
    name = 'photo.png',
    clientId: string = randomUUID(),
    headers: Record<string, string> = octet,
    agentId = agent,
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${agentId}/files?client_id=${clientId}&name=${encodeURIComponent(name)}`,
      headers,
      payload: body,
    });
  const send = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/v1/agents/${agent}/messages`, headers, payload });
  const settle = async (count: number) => {
    const until = Date.now() + 3000;
    while (turns.length < count && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return {
    app,
    db,
    blobs,
    files,
    service,
    turns,
    upload,
    send,
    settle,
    dir,
    release: () => release(),
  };
}
type T = Awaited<ReturnType<typeof setup>>;

const attach = async (t: T, id: string, text = '') => {
  const response = await t.send({ client_id: randomUUID(), text, attachment_ids: [id] });
  expect(response.statusCode).toBe(201);
  return response;
};

describe('verifier: upload content types', () => {
  it.each([
    ['text/plain', 'notes.txt', Buffer.from('hello'), 'text/plain'],
    ['text/plain; charset=utf-8', 'notes.txt', Buffer.from('hello'), 'text/plain'],
    ['application/json', 'data.json', Buffer.from('{"a":1}'), 'application/json'],
    ['application/json', 'broken.json', Buffer.from('{not json'), 'text/plain'],
    ['text/csv', 'data.csv', Buffer.from('a,b\n1,2\n'), 'text/csv'],
    ['text/markdown', 'readme.md', Buffer.from('# hi'), 'text/markdown'],
    ['image/png', 'photo.png', png, 'image/png'],
    ['multipart/form-data; boundary=x', 'photo.png', png, 'image/png'],
    ['application/x-www-form-urlencoded', 'a.txt', Buffer.from('a=b'), 'text/plain'],
  ])('accepts a %s upload of %s', async (contentType, name, bytes, expected) => {
    const t = await setup();
    const response = await t.upload(bytes, name, randomUUID(), { 'content-type': contentType });
    expect(response.statusCode).toBe(201);
    expect(response.json().file.mime_type).toBe(expected);
  });

  it('answers 400 (not 500) for an empty JSON-typed body', async () => {
    const t = await setup();
    const response = await t.upload(Buffer.alloc(0), 'data.json', randomUUID(), {
      'content-type': 'application/json',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('verifier: names', () => {
  it('survives an emoji cut at the name limit on download', async () => {
    const t = await setup();
    const name = `${'a'.repeat(117)}😀😀😀.txt`;
    const created = await t.upload(Buffer.from('hi'), name);
    expect(created.statusCode).toBe(201);
    const id = created.json().file.id;
    expect(created.json().file.name.length).toBeLessThanOrEqual(120);
    const download = await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/files/${id}` });
    expect(download.statusCode).toBe(200);
  });
  it('never lets a name break the content-disposition header', async () => {
    const t = await setup();
    const created = await t.upload(Buffer.from('hi'), 'a"b\\c;\'d(e)*%fé‮.txt');
    const id = created.json().file.id;
    const download = await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/files/${id}` });
    expect(download.statusCode).toBe(200);
    const header = String(download.headers['content-disposition']);
    expect(header).toMatch(/^attachment; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('verifier: signed links', () => {
  async function linked() {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    await attach(t, id);
    return { t, id };
  }
  it('rejects non-canonical (malleable) base64url signatures', async () => {
    const { t, id } = await linked();
    const link = new URL(t.files.signedLink(id));
    const sig = link.searchParams.get('sig')!;
    expect((await t.app.inject({ method: 'GET', url: link.toString() })).statusCode).toBe(200);
    // The 43rd base64url char carries only 4 significant bits: other chars decode to the same bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variants = [...alphabet].map((c) => sig.slice(0, 42) + c).filter((v) => v !== sig);
    for (const variant of variants) {
      link.searchParams.set('sig', variant);
      expect(
        (await t.app.inject({ method: 'GET', url: link.toString() })).statusCode,
        `variant ${variant.slice(-1)}`,
      ).toBe(404);
    }
  });
  it.each(['-1', '1e9', '0x10', '', ' 1', '1.5', '99999999999999999999999', '+5', 'NaN'])(
    'rejects exp %j',
    async (exp) => {
      const { t, id } = await linked();
      const link = new URL(t.files.signedLink(id));
      link.searchParams.set('exp', exp);
      expect((await t.app.inject({ method: 'GET', url: link.toString() })).statusCode).toBe(404);
    },
  );
  it('rejects a leading-zero exp and repeated or missing params', async () => {
    const { t, id } = await linked();
    const link = new URL(t.files.signedLink(id));
    const exp = link.searchParams.get('exp')!;
    const sig = link.searchParams.get('sig')!;
    const base = `/v1/files/${id}`;
    for (const query of [
      `?exp=0${exp}&sig=${sig}`,
      `?exp=${exp}&exp=${exp}&sig=${sig}`,
      `?exp=${exp}&sig=${sig}&sig=${sig}`,
      `?sig=${sig}`,
      `?exp=${exp}`,
      '',
      `?exp[]=${exp}&sig=${sig}`,
    ])
      expect((await t.app.inject({ method: 'GET', url: base + query })).statusCode, query).toBe(
        404,
      );
  });
  it('is bound to the file id and 404s for path tricks and unknown ids', async () => {
    const { t, id } = await linked();
    const query = new URL(t.files.signedLink(id)).search;
    for (const path of [
      `/v1/files/${id.toUpperCase()}`,
      `/v1/files/${id}/`,
      `/v1/files/..%2F${id}`,
      `/v1/files/${id}%00`,
      `/v1/files/fil_${'z'.repeat(20)}`,
    ])
      expect((await t.app.inject({ method: 'GET', url: path + query })).statusCode, path).toBe(404);
  });
  it('gives one answer for every failure', async () => {
    const { t, id } = await linked();
    const bad = new URL(t.files.signedLink(id));
    bad.searchParams.set('sig', 'A'.repeat(43));
    const unattached = (await t.upload(png)).json().file.id as string;
    const bodies = new Set<string>();
    for (const url of [bad.toString(), t.files.signedLink(unattached), `/v1/files/${id}`]) {
      const response = await t.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      bodies.add(JSON.stringify({ ...response.json().error, request_id: '' }));
    }
    expect(bodies.size).toBe(1);
  });
  it('stops working after the file is deleted', async () => {
    const { t, id } = await linked();
    await t.service.clear('alice', agent);
    expect((await t.app.inject({ method: 'GET', url: t.files.signedLink(id) })).statusCode).toBe(
      404,
    );
  });
  it('returns the bytes with the safe headers', async () => {
    const { t, id } = await linked();
    const response = await t.app.inject({ method: 'GET', url: t.files.signedLink(id) });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, max-age=300');
    expect(response.headers['content-type']).toBe('image/png');
  });
  // Writes 2,001 messages one by one to trigger pruning: several seconds on a busy machine.
  it(
    'stops working once the message that held the file is pruned',
    { timeout: 30_000 },
    async () => {
      const t = await setup();
      const id = (await t.upload(png)).json().file.id as string;
      await attach(t, id);
      for (let i = 0; i < 2_001; i += 1)
        await t.db.appendUserMessage('alice', agent, {
          clientId: randomUUID(),
          text: `m${i}`,
          status: 'sent',
        });
      expect((await t.app.inject({ method: 'GET', url: t.files.signedLink(id) })).statusCode).toBe(
        404,
      );
    },
  );
});

describe('verifier: auth exemption', () => {
  it('exempts only the signed link route from sign-in and beta membership', async () => {
    const dirName = mkdtempSync(join(tmpdir(), 'cord-members-'));
    dirs.push(dirName);
    const members = join(dirName, 'members.json');
    writeFileSync(members, '{"emails":["member@example.com"]}');
    const t = await setup({ withAuth: true, membersFile: members });
    const member = { 'x-user': 'alice', 'x-email': 'member@example.com' };
    const created = await t.upload(png, 'p.png', randomUUID(), { ...octet, ...member });
    expect(created.statusCode).toBe(201);
    const id = created.json().file.id as string;
    expect(
      (await t.send({ client_id: randomUUID(), text: '', attachment_ids: [id] }, member))
        .statusCode,
    ).toBe(201);
    // No sign-in at all: the link works.
    expect((await t.app.inject({ method: 'GET', url: t.files.signedLink(id) })).statusCode).toBe(
      200,
    );
    // Everything else needs sign-in...
    const mine = `/v1/agents/${agent}/files/${id}`;
    expect((await t.app.inject({ method: 'GET', url: mine })).statusCode).toBe(401);
    expect((await t.upload(png, 'p.png')).statusCode).toBe(401);
    // ...and membership.
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: mine,
          headers: { 'x-user': 'alice', 'x-email': 'outsider@example.com' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: mine, headers: member })).statusCode).toBe(
      200,
    );
    // A tampered or unknown link is still a plain 404, never a 401.
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/files/${id}?exp=1&sig=${'A'.repeat(43)}` }))
        .statusCode,
    ).toBe(404);
  });
});

describe('verifier: quotas and concurrency', () => {
  it('never crosses the byte quota with parallel uploads and leaves no temp blobs', async () => {
    const t = await setup({ limits: { quotaBytes: 100, perDay: 100 } });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => t.upload(Buffer.alloc(30, 65 + i), `f${i}.txt`)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 507)).toHaveLength(9);
    expect(readdirSync(join(t.dir, 'files'))).toHaveLength(3);
  });
  it('never crosses the daily count with parallel uploads', async () => {
    const t = await setup({ limits: { quotaBytes: 100_000, perDay: 4 } });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => t.upload(Buffer.from(`x${i}`), `f${i}.txt`)),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(4);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(6);
    expect(readdirSync(join(t.dir, 'files'))).toHaveLength(4);
  });
  it('treats parallel uploads with one client_id as one file and one blob', async () => {
    const t = await setup({ limits: { quotaBytes: 100_000, perDay: 2 } });
    const clientId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => t.upload(Buffer.from('same'), 'a.txt', clientId)),
    );
    expect(new Set(results.map((r) => r.json().file.id as string)).size).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(readdirSync(join(t.dir, 'files'))).toHaveLength(1);
    // The daily counter was charged once.
    expect((await t.upload(Buffer.from('b'), 'b.txt')).statusCode).toBe(201);
    expect((await t.upload(Buffer.from('c'), 'c.txt')).statusCode).toBe(429);
  });
  it('lets two agents reuse a client_id without collision', async () => {
    const t = await setup();
    const clientId = randomUUID();
    const first = await t.upload(Buffer.from('one'), 'a.txt', clientId);
    const second = await t.upload(Buffer.from('two'), 'a.txt', clientId, octet, other);
    expect(second.statusCode).toBe(201);
    expect(second.json().file.id).not.toBe(first.json().file.id);
  });
  it('refuses a stranger the agent and writes no blob', async () => {
    const t = await setup();
    const response = await t.upload(png, 'p.png', randomUUID(), { ...octet, 'x-user': 'mallory' });
    expect(response.statusCode).toBe(404);
    expect(existsSync(join(t.dir, 'files'))).toBe(false);
  });
  it('removes the staged blob when the upload is refused for type or quota', async () => {
    const t = await setup({ limits: { quotaBytes: 10, perDay: 100 } });
    expect((await t.upload(Buffer.from([0, 1, 2, 3]), 'x.bin')).statusCode).toBe(415);
    expect((await t.upload(Buffer.alloc(11, 65), 'x.txt')).statusCode).toBe(507);
    expect(existsSync(join(t.dir, 'files')) ? readdirSync(join(t.dir, 'files')) : []).toEqual([]);
  });
});

describe('verifier: type checks', () => {
  it('trusts bytes over declared type and name', async () => {
    const t = await setup();
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30)]);
    const r = await t.upload(jpeg, 'evil.txt', randomUUID(), { 'content-type': 'text/plain' });
    expect(r.json().file.mime_type).toBe('image/jpeg');
    expect(r.json().file.name).toBe('evil.txt.jpg');
    const pdf = Buffer.from('%PDF-1.7\nhello\x00');
    const second = await t.upload(pdf, 'a.json', randomUUID(), {
      'content-type': 'application/json',
    });
    expect(second.json().file.mime_type).toBe('application/pdf');
  });
  it('refuses NUL, invalid UTF-8, overlong, surrogate and control-heavy text', async () => {
    const t = await setup();
    for (const bytes of [
      Buffer.from('a\0b'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from([0xff, 0xfe, 0x41, 0x00]),
      Buffer.from('MZ\x90\x03\x04'),
      Buffer.from('\x1b[31mred'),
    ])
      expect((await t.upload(bytes, 'x.txt')).statusCode, bytes.toString('hex')).toBe(415);
  });
  it('stores an SVG as text/plain, served as an attachment with nosniff', async () => {
    const t = await setup();
    const r = await t.upload(Buffer.from('<svg onload=alert(1)>'), 'x.svg', randomUUID(), {
      'content-type': 'image/svg+xml',
    });
    expect(r.json().file.mime_type).toBe('text/plain');
    const download = await t.app.inject({
      method: 'GET',
      url: `/v1/agents/${agent}/files/${r.json().file.id}`,
    });
    expect(download.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(download.headers['content-disposition']).toMatch(/^attachment/);
  });
  it('takes a 5 MB JSON body', async () => {
    const t = await setup({ limits: { quotaBytes: 50_000_000, perDay: 100 } });
    const big = Buffer.from(`[${'1,'.repeat(2_500_000 - 1)}1]`);
    const r = await t.upload(big, 'big.json', randomUUID(), { 'content-type': 'application/json' });
    expect(r.statusCode).toBe(201);
    expect(r.json().file.mime_type).toBe('application/json');
  });
  it('survives truncated image headers without dimensions', async () => {
    const t = await setup();
    for (const bytes of [
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]),
      Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('xx')]),
      Buffer.from('RIFF\0\0\0\0WEBPVP8X'),
    ]) {
      const r = await t.upload(bytes, 'x.bin');
      expect(r.statusCode, bytes.toString('hex')).toBe(201);
      expect(r.json().file.width).toBeUndefined();
    }
  });
});

describe('verifier: sending', () => {
  it('refuses a file already attached to another message', async () => {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    const first = await attach(t, id);
    const again = await t.send({ client_id: randomUUID(), text: 'again', attachment_ids: [id] });
    expect(again.statusCode).toBe(400);
    expect(t.db.findFile('alice', id)?.messageId).toBe(first.json().message.id);
  });
  it("refuses another user attaching someone else's file", async () => {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    const stolen = await t.app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/messages`,
      headers: { 'x-user': 'bob' },
      payload: { client_id: randomUUID(), text: '', attachment_ids: [id] },
    });
    expect([400, 404]).toContain(stolen.statusCode);
    expect(t.db.findFile('alice', id)?.messageId).toBeNull();
  });
  it('refuses an agent-direction file and leaves it unattached', async () => {
    const t = await setup();
    const row = t.db.insertFile({
      id: `fil_${'q'.repeat(20)}`,
      userId: 'alice',
      agentId: agent,
      clientId: randomUUID(),
      direction: 'agent',
      name: 'from-agent.png',
      mime_type: 'image/png',
      size_bytes: 24,
      sha256: 'a'.repeat(64),
    }).file;
    const r = await t.send({ client_id: randomUUID(), text: 'x', attachment_ids: [row.id] });
    expect(r.statusCode).toBe(400);
    expect(t.db.findFile('alice', row.id)?.messageId).toBeNull();
  });
  it('refuses a repeated id, leaving the file unattached', async () => {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    const r = await t.send({ client_id: randomUUID(), text: 'dup', attachment_ids: [id, id] });
    expect(r.statusCode).toBe(400);
    expect(t.db.findFile('alice', id)?.messageId).toBeNull();
  });
  it('rolls the whole message back when the attach fails mid-transaction', async () => {
    const t = await setup();
    const good = (await t.upload(png)).json().file.id as string;
    await expect(
      t.db.appendUserMessage('alice', agent, {
        clientId: randomUUID(),
        text: 'x',
        status: 'sent',
        attachmentIds: [good, `fil_${'m'.repeat(20)}`],
      }),
    ).rejects.toMatchObject({ code: 'bad_attachment' });
    expect(t.db.findFile('alice', good)?.messageId).toBeNull();
    const page = await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/messages` });
    expect(page.json().messages).toHaveLength(0);
  });
  it('keeps the first attachment when a retry reuses the client_id with different ids', async () => {
    const t = await setup();
    const a = (await t.upload(png)).json().file.id as string;
    const b = (await t.upload(png)).json().file.id as string;
    const clientId = randomUUID();
    expect((await t.send({ client_id: clientId, text: '', attachment_ids: [a] })).statusCode).toBe(
      201,
    );
    const retry = await t.send({ client_id: clientId, text: '', attachment_ids: [b] });
    expect([200, 400]).toContain(retry.statusCode);
    expect(t.db.findFile('alice', a)?.messageId).not.toBeNull();
    expect(t.db.findFile('alice', b)?.messageId).toBeNull();
  });
  it('formats the turn lines for every label and size', async () => {
    const t = await setup();
    const picks: [Buffer, string, string][] = [
      [Buffer.from('hello'), 'a.txt', '[Attached: a.txt (text, 5 B)]'],
      [Buffer.from('# x'), 'a.md', '[Attached: a.md (Markdown, 3 B)]'],
      [Buffer.from('a,b'), 'a.csv', '[Attached: a.csv (CSV, 3 B)]'],
      [Buffer.from('{}'), 'a.json', '[Attached: a.json (JSON, 2 B)]'],
      [Buffer.from('%PDF-1'), 'a.pdf', '[Attached: a.pdf (PDF, 6 B)]'],
    ];
    const ids: string[] = [];
    for (const [bytes, name] of picks)
      ids.push((await t.upload(bytes, name)).json().file.id as string);
    await t.send({ client_id: randomUUID(), text: 'look', attachment_ids: ids });
    await t.settle(1);
    expect(t.turns[0]?.text.split('\n')).toEqual(['look', ...picks.map((pick) => pick[2])]);
    expect(t.turns[0]?.attachments?.map((a) => a.id)).toEqual(ids);
  });
  it('formats KB and MB sizes', async () => {
    const t = await setup({ limits: { quotaBytes: 50_000_000, perDay: 100 } });
    const kb = (await t.upload(Buffer.alloc(2048, 65), 'kb.txt')).json().file.id;
    const edge = (await t.upload(Buffer.alloc(1023, 65), 'edge.txt')).json().file.id;
    const mb = (await t.upload(Buffer.alloc(1_572_864, 65), 'mb.txt')).json().file.id;
    await t.send({ client_id: randomUUID(), text: '', attachment_ids: [kb, edge, mb] });
    await t.settle(1);
    expect(t.turns[0]?.text).toBe(
      [
        '[Attached: kb.txt (text, 2 KB)]',
        '[Attached: edge.txt (text, 1023 B)]',
        '[Attached: mb.txt (text, 1.5 MB)]',
      ].join('\n'),
    );
  });
  it('gives a queued message fresh links when it is dispatched', async () => {
    const t = await setup({ holdFirstTurn: true });
    const id = (await t.upload(png)).json().file.id as string;
    expect((await t.send({ client_id: randomUUID(), text: 'first' })).statusCode).toBe(201);
    await t.settle(1);
    const queued = await t.send({ client_id: randomUUID(), text: 'later', attachment_ids: [id] });
    expect(queued.statusCode).toBe(201);
    expect(queued.json().message.status).toBe('queued');
    const queuedAt = Math.floor(Date.now() / 1000);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    t.release();
    await t.settle(2);
    const exp = Number(new URL(t.turns[1]!.attachments![0]!.url).searchParams.get('exp'));
    expect(exp).toBeGreaterThanOrEqual(queuedAt + 15 * 60 + 1);
    expect(Date.parse(t.turns[1]!.attachments![0]!.expires_at)).toBe(exp * 1000);
  });
});

describe('verifier: deletion and sweep', () => {
  // Writes 2,001 messages one by one to trigger pruning: several seconds on a busy machine.
  it('removes files of pruned messages instead of leaking quota', { timeout: 30_000 }, async () => {
    const t = await setup({ limits: { quotaBytes: 30, perDay: 100 } });
    const id = (await t.upload(png)).json().file.id as string;
    await attach(t, id);
    for (let i = 0; i < 2_001; i += 1)
      await t.db.appendUserMessage('alice', agent, {
        clientId: randomUUID(),
        text: `m${i}`,
        status: 'sent',
      });
    await t.files.sweep();
    expect(t.db.findFile('alice', id)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', id))).toBe(false);
    // The quota is free again.
    expect((await t.upload(png)).statusCode).toBe(201);
  });
  it('sweeps a staged temp blob abandoned by a crash', async () => {
    const t = await setup();
    await t.upload(png);
    const stray = join(t.dir, 'files', `fil_${'k'.repeat(20)}.0123456789abcdef.tmp`);
    writeFileSync(stray, 'partial');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(stray, old, old);
    await t.files.sweep();
    expect(existsSync(stray)).toBe(false);
  });
  it('does not delete a young temp blob that an upload is still writing', async () => {
    const t = await setup();
    await t.upload(png);
    const stray = join(t.dir, 'files', `fil_${'k'.repeat(20)}.0123456789abcdef.tmp`);
    writeFileSync(stray, 'partial');
    await t.files.sweep();
    expect(existsSync(stray)).toBe(true);
  });
  it('keeps blobs that have a row and young orphans, removes old orphans', async () => {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    const orphan = `fil_${'o'.repeat(20)}`;
    await t.blobs.write(orphan, Buffer.from('x'));
    await t.files.sweep();
    expect(existsSync(join(t.dir, 'files', id))).toBe(true);
    expect(existsSync(join(t.dir, 'files', orphan))).toBe(true);
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(join(t.dir, 'files', id), old, old);
    utimesSync(join(t.dir, 'files', orphan), old, old);
    await t.files.sweep();
    expect(existsSync(join(t.dir, 'files', id))).toBe(true);
    expect(existsSync(join(t.dir, 'files', orphan))).toBe(false);
  });
  it('never sweeps an attached file, however old, and does sweep stale unattached', async () => {
    const t = await setup();
    const attached = (await t.upload(png)).json().file.id as string;
    await attach(t, attached);
    const loose = (await t.upload(png)).json().file.id as string;
    await t.files.sweep(new Date(Date.now() + 48 * 60 * 60_000));
    expect(t.db.findFile('alice', attached)).toBeDefined();
    expect(existsSync(join(t.dir, 'files', attached))).toBe(true);
    expect(t.db.findFile('alice', loose)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', loose))).toBe(false);
  });
  it('clear removes unattached uploads for that agent only', async () => {
    const t = await setup();
    const mine = (await t.upload(png)).json().file.id as string;
    const elsewhere = (await t.upload(png, 'o.png', randomUUID(), octet, other)).json().file
      .id as string;
    await t.service.clear('alice', agent);
    expect(t.db.findFile('alice', mine)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', mine))).toBe(false);
    expect(t.db.findFile('alice', elsewhere)).toBeDefined();
    expect(existsSync(join(t.dir, 'files', elsewhere))).toBe(true);
  });
  it('delete my data removes every blob of that user and none of another', async () => {
    const t = await setup();
    const a = (await t.upload(png)).json().file.id as string;
    await attach(t, a);
    const b = (await t.upload(png)).json().file.id as string;
    const bob = t.db.insertFile({
      id: `fil_${'w'.repeat(20)}`,
      userId: 'bob',
      agentId: `agt_${'z'.repeat(20)}`,
      clientId: randomUUID(),
      direction: 'owner',
      name: 'bob.png',
      mime_type: 'image/png',
      size_bytes: 24,
      sha256: 'b'.repeat(64),
    }).file;
    await t.blobs.write(bob.id, Buffer.from('bob'));
    await t.service.deleteAllForUser('alice');
    for (const id of [a, b]) {
      expect(t.db.findFile('alice', id)).toBeUndefined();
      expect(existsSync(join(t.dir, 'files', id))).toBe(false);
    }
    expect(t.db.findFile('bob', bob.id)).toBeDefined();
    expect(existsSync(join(t.dir, 'files', bob.id))).toBe(true);
  });
});

describe('verifier: message decode', () => {
  it('lists a thread whose file rows are gone', async () => {
    const t = await setup();
    const id = (await t.upload(png)).json().file.id as string;
    await attach(t, id, 'look');
    t.db.deleteFiles([id]);
    const page = await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/messages` });
    expect(page.statusCode).toBe(200);
    const message = (page.json().messages as { text?: string; attachments?: unknown }[]).find(
      (m) => m.text === 'look',
    );
    expect(message).toBeDefined();
    expect(message?.attachments).toBeUndefined();
    expect((await t.app.inject({ method: 'GET', url: '/v1/threads' })).statusCode).toBe(200);
  });
  it('never exposes attachment_ids on the wire', async () => {
    const t = await setup();
    const id = (await t.upload(png, 'secret-name.png')).json().file.id as string;
    const sent = await attach(t, id, 'hi');
    expect(JSON.stringify(sent.json())).not.toContain('attachment_ids');
    expect(sent.json().message.attachments[0].name).toBe('secret-name.png');
  });
});

describe('verifier: logging', () => {
  it('never logs file names, links or contents', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const t = await setup({ logSink: sink });
    const id = (await t.upload(Buffer.from('TOP-SECRET-CONTENT'), 'tax-return-2026.txt')).json()
      .file.id as string;
    await attach(t, id, 'hi');
    await t.settle(1);
    const link = t.files.signedLink(id);
    await t.app.inject({ method: 'GET', url: link });
    await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/files/${id}` });
    await t.upload(Buffer.from([0, 1]), 'secret-binary.exe');
    await t.service.clear('alice', agent);
    const all = lines.join('');
    expect(all).toContain('/files');
    expect(all).not.toContain('tax-return');
    expect(all).not.toContain('secret-binary');
    expect(all).not.toContain('TOP-SECRET');
    expect(all).not.toContain(new URL(link).searchParams.get('sig')!);
  });
});

describe('file names cannot be disguised', () => {
  it('drops direction marks and overrides', () => {
    expect(cleanFileName('photo‮gpj.exe', 'image/jpeg')).toBe('photogpj.exe.jpg');
    expect(cleanFileName('⁦report⁩.pdf', 'application/pdf')).toBe('report.pdf');
    expect(cleanFileName('a‏b.txt', 'text/plain')).toBe('ab.txt');
  });
});
