/* eslint-disable @typescript-eslint/no-unsafe-member-access -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import { connectorEndpointUrl, MAX_STORED_AGENT_MESSAGE_CHARS } from '@twring/contracts';
import type { AgentEvent, UserTurn } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { hashConnectorToken } from '../connectors/pairing';
import { createLoggerOptions } from '../logger';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { ThreadService, type ThreadTurnTimeouts } from '../threads/service';
import { SqliteThreadStore } from '../threads/store';
import { FileBlobStore } from './blobs';
import { FileService } from './service';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const agent = `agt_${'a'.repeat(20)}`;
const other = `agt_${'b'.repeat(20)}`;
const connAgent = `agt_${'c'.repeat(20)}`;
const connAgent2 = `agt_${'d'.repeat(20)}`;
const bobAgent = `agt_${'e'.repeat(20)}`;
const connectorId = `con_${'a'.repeat(20)}`;
const connectorId2 = `con_${'b'.repeat(20)}`;
const token = `cct_${'a'.repeat(43)}`;
const token2 = `cct_${'b'.repeat(43)}`;
const open: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const app of open.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const png = Buffer.alloc(24);
Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
png.write('IHDR', 12);
png.writeUInt32BE(20, 16);
png.writeUInt32BE(10, 20);

async function fileServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  hits: { count: number } = { count: 0 },
): Promise<{ base: string; hits: { count: number }; closedSockets: () => number }> {
  let closed = 0;
  const server = createServer((request, response) => {
    hits.count++;
    request.socket.once('close', () => closed++);
    handler(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, hits, closedSockets: () => closed };
}
const serveFile = (bytes: Buffer, type = 'image/png') =>
  fileServer((_request, response) => {
    response.writeHead(200, { 'content-type': type });
    response.end(bytes);
  });

type Script = (turn: UserTurn) => AsyncIterable<AgentEvent> | AgentEvent[];

async function setup(
  options: {
    script?: Script;
    limits?: { quotaBytes: number; perDay: number };
    withAuth?: boolean;
    membersFile?: string;
    logSink?: Writable;
    timeouts?: Partial<ThreadTurnTimeouts>;
    uploadRate?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'cord-agentfiles-'));
  dirs.push(dir);
  const limits = options.limits ?? { quotaBytes: 50_000_000, perDay: 100 };
  const stores = createMemoryStores(keys);
  const db = new SqliteThreadStore(
    ':memory:',
    new CredentialCipher(messageKeys(keys)),
    () => new Date(),
    limits,
  );
  const files = new FileService(db, new FileBlobStore(join(dir, 'files')), keys, 'http://x');
  const now = new Date().toISOString();
  const base = { voice_id: 'flux-aura-en', status: 'ready', created_at: now, updated_at: now };
  for (const id of [agent, other])
    await stores.agents.create({
      ...base,
      id,
      user_id: 'alice',
      name: 'Agent',
      protocol: 'cord-rest',
      endpoint_url: 'https://example.com/agent',
    } as never);
  for (const [id, cid] of [
    [connAgent, connectorId],
    [connAgent2, connectorId2],
  ] as const)
    await stores.agents.create({
      ...base,
      id,
      user_id: 'alice',
      name: 'Computer agent',
      protocol: 'cord-connector',
      endpoint_url: connectorEndpointUrl(cid, 'claude-code'),
    } as never);
  await stores.agents.create({
    ...base,
    id: bobAgent,
    user_id: 'bob',
    name: 'Bob',
    protocol: 'cord-rest',
    endpoint_url: 'https://example.com/bob',
  } as never);
  for (const [id, t] of [
    [connectorId, token],
    [connectorId2, token2],
  ] as const)
    await stores.connectors.create({
      id,
      user_id: 'alice',
      name: 'Computer',
      token_hash: hashConnectorToken(t),
      agents: [],
      created_at: now,
    });
  const logs: string[] = [];
  const turns: UserTurn[] = [];
  const service = new ThreadService({
    store: db,
    files,
    fileFetchEnv: 'development',
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
          turns.push(turn);
          for await (const event of options.script?.(turn) ?? [])
            yield { ...event, turn_id: turn.turnId };
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
    log: {
      info: (obj, msg) => logs.push(JSON.stringify({ obj, msg })),
      warn: (obj, msg) => logs.push(JSON.stringify({ obj, msg })),
    },
    ...(options.timeouts && { timeouts: options.timeouts }),
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
  const { RingService } = await import('../ring/service');
  const { DeviceRepository, InviteRepository, RingSettingsRepository } =
    await import('../ring/store');
  const { MemoryCollection } = await import('../store/collection');
  const { ManualScheduler, recordingLogger } = await import('../calls/testing');
  const ringStores = {
    devices: new DeviceRepository(new MemoryCollection()),
    invites: new InviteRepository(new MemoryCollection()),
    settings: new RingSettingsRepository(new MemoryCollection()),
  };
  const ring = new RingService({
    stores: ringStores,
    scheduler: new ManualScheduler(),
    inCall: () => false,
    logger: recordingLogger(),
  });
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
      uploadRatePerMinute: options.uploadRate ?? 1000,
    },
    ring: {
      stores: ringStores,
      service: ring,
      connectorRatePerMinute: 1000,
      writeRatePerMinute: 100,
    },
  });
  open.push({
    close: async () => {
      service.stop();
      ring.close();
      await app.close();
      await db.close();
    },
  });
  const upload = (agentId: string, direction: 'owner' | 'agent', userId = 'alice', bytes = png) =>
    files.upload({
      userId,
      agentId,
      clientId: randomUUID(),
      name: 'secret-name.png',
      mimeType: 'image/png',
      bytes,
      direction,
    });
  const connectorUpload = (
    t: string | undefined,
    query = `local_agent=claude-code&client_id=${randomUUID()}&name=picture.png`,
    body: Buffer = png,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/connectors/files?${query}`,
      headers: {
        'content-type': 'application/octet-stream',
        ...(t && { authorization: `Bearer ${t}` }),
        ...headers,
      },
      payload: body,
    });
  const connectorMessage = (
    payload: Record<string, unknown>,
    key = randomUUID(),
    t: string | undefined = token,
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/connectors/messages',
      headers: { ...(t && { authorization: `Bearer ${t}` }), 'idempotency-key': key },
      payload: { local_agent: 'claude-code', text: 'hi', origin: 'agent', ...payload },
    });
  const sendTyped = (text = 'go') =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/messages`,
      payload: { client_id: randomUUID(), text },
    });
  const reply = async (agentId = agent) => {
    for (let i = 0; i < 600; i++) {
      const found = (await db.listMessages('alice', agentId, { limit: 50 })).messages.find(
        (item) => item.kind === 'agent_text',
      );
      if (found?.kind === 'agent_text') return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return undefined;
  };
  const idle = async () => {
    for (let i = 0; i < 600; i++) {
      const rows = (await db.listMessages('alice', agent, { limit: 50 })).messages;
      if (
        rows.some(
          (m) => m.kind === 'user_text' && ['answered', 'failed', 'stopped'].includes(m.status),
        )
      )
        return rows;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return [];
  };
  return {
    app,
    db,
    files,
    service,
    turns,
    logs,
    upload,
    connectorUpload,
    connectorMessage,
    sendTyped,
    reply,
    idle,
    dir,
    stores,
  };
}

const fileEvent = (over: Record<string, unknown> = {}): AgentEvent => ({
  type: 'file',
  event_id: randomUUID(),
  turn_id: 'pending',
  name: 'secret-name.png',
  mime_type: 'image/png',
  ...over,
});

describe('verifier 4a: connector file route auth and exemptions', () => {
  it('requires the connector token and scopes to the right connector, agent and owner', async () => {
    const t = await setup();
    expect((await t.connectorUpload(undefined)).statusCode).toBe(401);
    expect((await t.connectorUpload('cct_' + 'z'.repeat(43))).statusCode).toBe(401);
    expect((await t.connectorUpload('garbage')).statusCode).toBe(401);
    // connector 2 has an agent for claude-code too; connector 1 asking for another name has none
    expect(
      (await t.connectorUpload(token, `local_agent=nope&client_id=${randomUUID()}&name=a.png`))
        .statusCode,
    ).toBe(404);
    const ok = await t.connectorUpload(token);
    expect(ok.statusCode).toBe(201);
    const file = t.db.findFile('alice', String(ok.json().file.id));
    expect(file).toMatchObject({ agentId: connAgent, direction: 'agent' });
    const ok2 = await t.connectorUpload(token2);
    expect(t.db.findFile('alice', String(ok2.json().file.id))).toMatchObject({
      agentId: connAgent2,
    });
    // A deleted saved agent: 404, and its connector's token still cannot reach the other agent.
    await t.stores.agents.delete('alice', connAgent);
    expect((await t.connectorUpload(token)).statusCode).toBe(404);
    // A revoked connector: 401.
    await t.stores.connectors.delete('alice', connectorId2);
    expect((await t.connectorUpload(token2)).statusCode).toBe(401);
  });

  it('is exempt from sign-in and the beta list, and nothing else is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cord-members-'));
    dirs.push(dir);
    const members = join(dir, 'members.json');
    writeFileSync(members, '{"emails":["member@example.com"]}');
    const t = await setup({ withAuth: true, membersFile: members });
    expect((await t.connectorUpload(token)).statusCode).toBe(201);
    expect((await t.connectorUpload(undefined)).statusCode).toBe(401);
    const upload = (
      headers: Record<string, string>,
      url: string,
      method: 'POST' | 'GET' = 'POST',
    ) =>
      t.app.inject({
        method,
        url,
        headers: { 'content-type': 'application/octet-stream', ...headers },
        payload: method === 'POST' ? png : undefined,
      });
    const query = `client_id=${randomUUID()}&name=a.png`;
    // the owner route still needs sign-in and membership
    expect((await upload({}, `/v1/agents/${agent}/files?${query}`)).statusCode).toBe(401);
    expect(
      (
        await upload(
          { 'x-user': 'alice', 'x-email': 'stranger@example.com' },
          `/v1/agents/${agent}/files?${query}`,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await upload(
          { 'x-user': 'alice', 'x-email': 'member@example.com' },
          `/v1/agents/${agent}/files?${query}`,
        )
      ).statusCode,
    ).toBe(201);
    // other connector-ish and sibling routes: no exemption by prefix, trailing slash or method
    for (const [method, url] of [
      ['GET', '/v1/connectors/files'],
      ['POST', '/v1/connectors/files/'],
      ['POST', '/v1/connectors/files/x'],
      ['GET', '/v1/connectors/messages'],
      ['GET', '/v1/threads'],
    ] as const) {
      const response = await upload({}, url, method);
      expect([401, 404, 405], `${method} ${url}`).toContain(response.statusCode);
      if (url === '/v1/threads') expect(response.statusCode).toBe(401);
    }
    // a signed-in non-member does not get in through the connector routes' exemption on other routes
    expect(
      (await upload({ 'x-user': 'alice', 'x-email': 'stranger@example.com' }, '/v1/threads', 'GET'))
        .statusCode,
    ).toBe(403);
  });

  it('answers a bad token before reading a large body', async () => {
    const t = await setup();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const address = t.app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const socket = connect(address.port, '127.0.0.1');
    sockets.add(socket);
    const received: string[] = [];
    socket.on('data', (chunk) => received.push(chunk.toString()));
    socket.write(
      `POST /v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&name=a.png HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer cct_${'z'.repeat(43)}\r\nContent-Type: application/octet-stream\r\nContent-Length: 10000000\r\n\r\n`,
    );
    socket.write(Buffer.alloc(1000));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(received.join('')).toContain('401');
  });

  it('enforces 30 uploads a minute per connector, charged to the owner quota and daily count', async () => {
    const t = await setup({ uploadRate: 3, limits: { quotaBytes: 24 * 2 + 1, perDay: 100 } });
    expect((await t.connectorUpload(token)).statusCode).toBe(201);
    expect((await t.connectorUpload(token)).statusCode).toBe(201);
    // quota: the owner already holds 48 bytes (agent files count), an owner upload is refused too
    expect((await t.connectorUpload(token)).statusCode).toBe(507);
    await expect(t.upload(agent, 'owner')).rejects.toMatchObject({ code: 'storage_full' });
  });

  it('rate limits per connector', async () => {
    const t = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await t.connectorUpload(token)).statusCode);
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    // another connector of the same owner has its own window
    expect((await t.connectorUpload(token2)).statusCode).toBe(201);
  });

  it('is idempotent on client_id and refuses the same client_id from the other direction', async () => {
    const t = await setup();
    const clientId = randomUUID();
    const query = `local_agent=claude-code&client_id=${clientId}&name=a.png`;
    const a = await t.connectorUpload(token, query);
    const b = await t.connectorUpload(token, query);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().file.id).toBe(a.json().file.id);
    expect(
      await t.files
        .upload({
          userId: 'alice',
          agentId: connAgent,
          clientId,
          name: 'a.png',
          mimeType: 'image/png',
          bytes: png,
        })
        .catch((e: { code: string }) => e.code),
    ).toBe('bad_attachment');
  });

  it('rejects unsupported, empty, oversized and bad-query uploads without a 500', async () => {
    const t = await setup();
    expect((await t.connectorUpload(token, undefined, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await t.connectorUpload(token, undefined, Buffer.from([0, 1, 2, 3]))).statusCode).toBe(
      415,
    );
    expect((await t.connectorUpload(token, 'local_agent=claude-code&name=a.png')).statusCode).toBe(
      400,
    );
    expect(
      (await t.connectorUpload(token, `local_agent=..%2Fx&client_id=${randomUUID()}&name=a.png`))
        .statusCode,
    ).toBe(400);
    expect(
      (await t.connectorUpload(token, undefined, Buffer.alloc(10 * 1024 * 1024 + 2048))).statusCode,
    ).toBe(413);
  });
});

describe('verifier 4a: file_ids on connector messages', () => {
  it('refuses foreign, owner-direction, attached, other-owner and malformed ids and attaches nothing', async () => {
    const t = await setup();
    const good = (await t.upload(connAgent, 'agent')).file;
    const good2 = (await t.upload(connAgent, 'agent')).file;
    const foreignAgent = (await t.upload(connAgent2, 'agent')).file; // another agent of the same owner
    const ownerDir = (await t.upload(connAgent, 'owner')).file;
    const bobs = (await t.upload(bobAgent, 'agent', 'bob')).file;
    for (const ids of [
      [foreignAgent.id],
      [ownerDir.id],
      [bobs.id],
      [`fil_${'z'.repeat(20)}`],
      [good.id, foreignAgent.id], // a good one before a bad one must not stay attached
      [good2.id, ownerDir.id, good.id],
    ]) {
      const response = await t.connectorMessage({ text: '', file_ids: ids });
      expect(response.statusCode, JSON.stringify(ids)).toBe(400);
    }
    expect(t.db.findFile('alice', good.id)?.messageId).toBeFalsy();
    expect(t.db.findFile('alice', good2.id)?.messageId).toBeFalsy();
    expect((await t.db.listMessages('alice', connAgent, { limit: 20 })).messages).toHaveLength(0);
    // schema: duplicates, more than 5, empty list
    expect((await t.connectorMessage({ text: '', file_ids: [good.id, good.id] })).statusCode).toBe(
      400,
    );
    const six = [];
    for (let i = 0; i < 6; i++) six.push((await t.upload(connAgent, 'agent')).file.id);
    expect((await t.connectorMessage({ text: '', file_ids: six })).statusCode).toBe(400);
    expect((await t.connectorMessage({ text: '', file_ids: [] })).statusCode).toBe(400);
    // the good ones still attach afterwards, in the given order, and the same file cannot attach twice
    const key = randomUUID();
    const ok = await t.connectorMessage({ text: '', file_ids: [good2.id, good.id] }, key);
    expect(ok.statusCode).toBe(201);
    const saved = await t.db.findMessageById('alice', connAgent, String(ok.json().message_id));
    expect(saved).toMatchObject({ kind: 'agent_text', text: '' });
    if (saved?.kind === 'agent_text')
      expect(saved.attachments?.map((a) => a.id)).toEqual([good2.id, good.id]);
    expect((await t.connectorMessage({ text: '', file_ids: [good.id] })).statusCode).toBe(400);
    // idempotent retry returns 200 and the same message; a retry with other files is refused
    const retry = await t.connectorMessage({ text: '', file_ids: [good2.id, good.id] }, key);
    expect([retry.statusCode, retry.json().message_id]).toEqual([200, ok.json().message_id]);
    expect(
      (await t.connectorMessage({ text: '', file_ids: [good.id, good2.id] }, key)).statusCode,
    ).toBe(400);
    expect((await t.connectorMessage({ text: '' }, key)).statusCode).toBe(400);
  });

  it('refuses an empty message and accepts a hang-up-marker-only text with a file', async () => {
    const t = await setup();
    expect((await t.connectorMessage({ text: '' })).statusCode).toBe(400);
    const f = (await t.upload(connAgent, 'agent')).file;
    const response = await t.connectorMessage({ text: '⟪hangup⟫', file_ids: [f.id] });
    expect([201, 400]).toContain(response.statusCode);
  });
});

describe('verifier 4a: file events in a typed turn', () => {
  it('ignores foreign, owner-direction, attached and other-user file ids without a note', async () => {
    const ids: string[] = [];
    const t = await setup({ script: () => ids.map((file_id) => fileEvent({ file_id })) });
    const foreign = (await t.upload(other, 'agent')).file;
    const ownerDir = (await t.upload(agent, 'owner')).file;
    const attached = (await t.upload(agent, 'agent')).file;
    const bobs = (await t.upload(bobAgent, 'agent', 'bob')).file;
    const good = (await t.upload(agent, 'agent')).file;
    // attach one through another message first
    await t.db.appendMessage('alice', agent, {
      kind: 'agent_text',
      text: 'earlier',
      partial: false,
      attachmentIds: [attached.id],
    });
    ids.push(
      foreign.id,
      ownerDir.id,
      attached.id,
      bobs.id,
      `fil_${'q'.repeat(20)}`,
      good.id,
      good.id,
    );
    await t.sendTyped();
    const reply = await t.reply();
    const all = (await t.db.listMessages('alice', agent, { limit: 50 })).messages.filter(
      (m) => m.kind === 'agent_text' && m.text === '',
    );
    expect(all).toHaveLength(1);
    const found = all[0];
    if (found?.kind !== 'agent_text') throw new Error('no reply');
    expect(found.attachments?.map((a) => a.id)).toEqual([good.id]);
    expect(reply).toBeDefined();
    expect(t.db.findFile('alice', foreign.id)?.messageId).toBeFalsy();
    expect(t.db.findFile('alice', ownerDir.id)?.messageId).toBeFalsy();
    expect(t.db.findFile('bob', bobs.id)?.messageId).toBeFalsy();
  });

  it('counts every fetch attempt toward the 5-file limit, not only the successes', async () => {
    const hits = { count: 0 };
    const server = await fileServer((_request, response) => {
      response.writeHead(404);
      response.end();
    }, hits);
    const t = await setup({
      script: () =>
        Array.from({ length: 12 }, (_, i) => fileEvent({ url: `${server.base}/f${i}` })),
    });
    await t.sendTyped();
    const reply = await t.reply();
    expect(reply).toMatchObject({ text: "A file couldn't be saved." });
    expect(hits.count).toBeLessThanOrEqual(5);
  });

  it('keeps event order across file_id and url events, with one failure note after the text', async () => {
    const server = await serveFile(png);
    const t = await setup({
      script: async function* () {
        const a = await (async () => (await t.upload(agent, 'agent')).file)();
        yield fileEvent({ file_id: a.id, event_id: 'e1' });
        yield fileEvent({ url: 'https://10.0.0.1/x', event_id: 'e2' }); // blocked
        yield fileEvent({ url: `${server.base}/ok`, event_id: 'e3' });
        yield fileEvent({ url: 'https://169.254.169.254/x', event_id: 'e4' }); // blocked
        yield {
          type: 'text.delta',
          event_id: 'e5',
          turn_id: 'x',
          delta: 'Here you go.',
        } as AgentEvent;
        yield fileEvent({ url: `${server.base}/ok`, event_id: 'e3' }); // duplicate event id
      },
    });
    await t.sendTyped();
    const reply = await t.reply();
    if (reply?.kind !== 'agent_text') throw new Error('no reply');
    expect(reply.text).toBe("Here you go.\nA file couldn't be saved.");
    expect(reply.attachments).toHaveLength(2);
    expect(server.hits.count).toBe(1);
    // the url file is stored as an agent file idempotent on turnId:event_id
    const second = reply.attachments![1]!;
    const row = t.db.findFile('alice', second.id)!;
    expect(row.direction).toBe('agent');
    expect(row.clientId).toMatch(/^turn_.*:e3$/u);
  });

  it('adds a daily-limit note and fits the note within the stored text cap', async () => {
    const server = await serveFile(png);
    const long = 'x'.repeat(MAX_STORED_AGENT_MESSAGE_CHARS);
    const t = await setup({
      limits: { quotaBytes: 50_000_000, perDay: 0 },
      script: () => [
        { type: 'text.delta', event_id: 't', turn_id: 'x', delta: long } as AgentEvent,
        fileEvent({ url: `${server.base}/a` }),
      ],
    });
    await t.sendTyped();
    const reply = await t.reply();
    if (reply?.kind !== 'agent_text') throw new Error('no reply');
    expect(reply.text.length).toBeLessThanOrEqual(MAX_STORED_AGENT_MESSAGE_CHARS);
    expect(reply.text.endsWith("A file couldn't be saved: the daily file limit is reached.")).toBe(
      true,
    );
  });

  it('rejects an oversize, non-200, redirect and unsupported-type url with one note and no stored file', async () => {
    const big = await fileServer((_request, response) => {
      response.writeHead(200, { 'content-length': String(11 * 1024 * 1024) });
      response.end();
    });
    const bin = await serveFile(Buffer.from([0, 1, 2, 3, 4]), 'application/octet-stream');
    const redirect = await fileServer((_request, response) => {
      response.writeHead(302, { location: `${bin.base}/x` });
      response.end();
    });
    const t = await setup({
      script: () => [
        fileEvent({ url: `${big.base}/a` }),
        fileEvent({ url: `${bin.base}/a` }),
        fileEvent({ url: `${redirect.base}/a` }),
      ],
    });
    await t.sendTyped();
    const reply = await t.reply();
    expect(reply).toMatchObject({ text: "A file couldn't be saved." });
    expect(bin.hits.count).toBe(1);
    expect(t.db.staleUnattachedFiles(new Date(Date.now() + 1e9))).toHaveLength(0);
  });

  it('does not time the turn out while a slow fetch runs, and the next event gets a fresh idle budget', async () => {
    const slow = await fileServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(png);
      }, 700);
    });
    const t = await setup({
      timeouts: { connectMs: 2000, firstEventMs: 300, idleMs: 300, totalMs: 60_000 },
      script: async function* () {
        yield fileEvent({ url: `${slow.base}/a` });
        await new Promise((resolve) => setTimeout(resolve, 150));
        yield { type: 'text.delta', event_id: 'd', turn_id: 'x', delta: 'done' } as AgentEvent;
      },
    });
    await t.sendTyped();
    const reply = await t.reply();
    if (reply?.kind !== 'agent_text') throw new Error('no reply');
    expect(reply.text).toBe('done');
    expect(reply.attachments).toHaveLength(1);
    expect(reply.partial).toBe(false);
  });

  it('a turn cleared mid-fetch aborts the download and attaches/leaks nothing', async () => {
    let started = false;
    const slow = await fileServer((_request, response) => {
      started = true;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(png.subarray(0, 10));
    });
    const t = await setup({ script: () => [fileEvent({ url: `${slow.base}/a` })] });
    await t.sendTyped();
    for (let i = 0; i < 400 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    expect(started).toBe(true);
    await t.service.clear('alice', agent);
    for (let i = 0; i < 200 && slow.closedSockets() === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(slow.closedSockets()).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect((await t.db.listMessages('alice', agent, { limit: 20 })).messages).toHaveLength(0);
    // nothing attached anywhere; any stored file is unattached (the sweep removes it)
    for (const id of t.db.staleUnattachedFiles(new Date(Date.now() + 1e9)))
      expect(t.db.findFile('alice', id)?.messageId).toBeFalsy();
  });

  it('a turn stopped mid-fetch ends stopped, frees the slot and keeps the partial download out', async () => {
    let started = false;
    const slow = await fileServer((_request, response) => {
      started = true;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(png.subarray(0, 10));
    });
    const t = await setup({ script: () => [fileEvent({ url: `${slow.base}/a` })] });
    const sent = await t.sendTyped();
    const id = sent.json().message.id as string;
    for (let i = 0; i < 400 && !started; i++) await new Promise((r) => setTimeout(r, 5));
    await t.service.stop('alice', id);
    for (let i = 0; i < 200 && slow.closedSockets() === 0; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(slow.closedSockets()).toBe(1);
    const rows = await t.idle();
    const user = rows.find((m) => m.kind === 'user_text');
    expect(user).toMatchObject({ status: 'stopped' });
    for (const m of rows) if (m.kind === 'agent_text') expect(m.attachments ?? []).toHaveLength(0);
  });

  it('a retried turn id with the same event id does not duplicate a stored file', async () => {
    const server = await serveFile(png);
    const t = await setup({
      script: () => [fileEvent({ url: `${server.base}/a`, event_id: 'same' })],
    });
    await t.sendTyped();
    const first = await t.reply();
    if (first?.kind !== 'agent_text') throw new Error('no reply');
    await t.files.upload({
      userId: 'alice',
      agentId: agent,
      clientId: `${first.turn_id}:same`,
      name: 'x.png',
      mimeType: 'image/png',
      bytes: png,
      direction: 'agent',
    });
    expect(first.attachments).toHaveLength(1);
  });

  it('does not log urls, names or contents', async () => {
    const server = await serveFile(png);
    const sink: string[] = [];
    const t = await setup({
      logSink: new Writable({
        write(chunk: Buffer, _enc, cb) {
          sink.push(chunk.toString());
          cb();
        },
      }),
      script: () => [
        fileEvent({ url: `${server.base}/private-path-token`, name: 'tax-return-2026.png' }),
        fileEvent({ url: 'https://10.0.0.1/private-path-token', name: 'tax-return-2026.png' }),
        fileEvent({ file_id: `fil_${'q'.repeat(20)}`, name: 'tax-return-2026.png' }),
      ],
    });
    await t.connectorUpload(
      token,
      `local_agent=claude-code&client_id=${randomUUID()}&name=tax-return-2026.png`,
    );
    await t.sendTyped();
    await t.reply();
    await new Promise((r) => setTimeout(r, 100));
    const all = [...t.logs, ...sink].join('\n');
    expect(all).toContain('agent_file_rejected');
    expect(all).not.toContain('private-path-token');
    expect(all).not.toContain('tax-return');
    expect(all).not.toContain('secret-name');
    expect(all).not.toContain('10.0.0.1');
  });
});
