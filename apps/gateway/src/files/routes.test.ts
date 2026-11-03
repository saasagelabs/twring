/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import {
  connectorEndpointUrl,
  connectorMessageResponseSchema,
  fileUploadResponseSchema,
} from '@twring/contracts';
import type { AgentEvent } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { AuthError, createRequestAuth } from '../auth';
import { ManualScheduler, recordingLogger } from '../calls/testing';
import { hashConnectorToken } from '../connectors/pairing';
import { RingService } from '../ring/service';
import { DeviceRepository, InviteRepository, RingSettingsRepository } from '../ring/store';
import { MemoryCollection } from '../store/collection';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { createMemoryStores } from '../store/repositories';
import { ThreadService } from '../threads/service';
import { SqliteThreadStore } from '../threads/store';
import { FileBlobStore } from './blobs';
import { FileService } from './service';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const agent = `agt_${'a'.repeat(20)}`;
const other = `agt_${'b'.repeat(20)}`;
const open: { close(): Promise<void> }[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const app of open.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
  limits = { quotaBytes: 1000, perDay: 100 },
  uploadRatePerMinute = 30,
  filesEnabled = true,
  connectorAuth = false,
  agentEvents: AgentEvent[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'cord-files-'));
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
  const turns: { text: string; attachments?: { url: string }[] }[] = [];
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
          await Promise.resolve();
          turns.push(turn);
          for (const agentEvent of agentEvents) yield { ...agentEvent, turn_id: turn.turnId };
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
    gatewayEnvFixture({ THREADS_ENABLED: 'true', FILES_ENABLED: String(filesEnabled) }),
  );
  const app = buildApp({
    env,
    ...(connectorAuth && {
      auth: createRequestAuth((request) =>
        typeof request.headers['x-user'] === 'string'
          ? Promise.resolve({ id: request.headers['x-user'] })
          : Promise.reject(new AuthError(401, 'auth_required', 'Sign in.')),
      ),
    }),
    userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
    agents: { stores, policy: { env: 'development' }, writeRatePerMinute: 100 },
    threads: {
      service,
      store: db,
      writeRatePerMinute: 100,
      readRatePerMinute: 100,
      messagesPerDay: 100,
    },
    files: { service: files, agents: stores.agents, readRatePerMinute: 100, uploadRatePerMinute },
    ring: {
      stores: ringStores,
      service: ring,
      connectorRatePerMinute: 100,
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
  const upload = (
    body: Buffer,
    name = 'photo.png',
    clientId = randomUUID(),
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/files?client_id=${clientId}&name=${encodeURIComponent(name)}`,
      headers: { 'content-type': 'application/octet-stream', ...headers },
      payload: body,
    });
  const png = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(20, 16);
  png.writeUInt32BE(10, 20);
  return { app, db, blobs, files, service, stores, turns, upload, png, dir };
}

describe('file routes', () => {
  it('does not mount connector uploads when files are disabled', async () => {
    const t = await setup(undefined, 30, false, true);
    const response = await t.app.inject({
      method: 'POST',
      url: `/v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&name=image.png`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: t.png,
    });
    expect(response.statusCode).toBe(404);
  });
  it('adds one storage note when a turn file exceeds the owner quota', async () => {
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(png);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const events: AgentEvent[] = [
      {
        type: 'file',
        event_id: randomUUID(),
        turn_id: 'pending',
        name: 'chart.png',
        mime_type: 'image/png',
        url: `http://127.0.0.1:${address.port}/chart`,
      },
    ];
    const t = await setup({ quotaBytes: 24, perDay: 100 }, 30, true, false, events);
    await t.files.upload({
      userId: 'alice',
      agentId: agent,
      clientId: randomUUID(),
      name: 'existing.png',
      mimeType: 'image/png',
      bytes: png,
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/messages`,
      payload: { client_id: randomUUID(), text: 'Chart' },
    });
    let reply;
    for (let i = 0; i < 100; i++) {
      reply = (await t.db.listMessages('alice', agent, { limit: 20 })).messages.find(
        (item) => item.kind === 'agent_text',
      );
      if (reply) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reply).toMatchObject({
      kind: 'agent_text',
      text: "A file couldn't be saved: storage is full.",
    });
  });
  it('fetches a server file event and attaches it to the turn reply', async () => {
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
    png.write('IHDR', 12);
    png.writeUInt32BE(20, 16);
    png.writeUInt32BE(10, 20);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(png);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const events: AgentEvent[] = [
      {
        type: 'file',
        event_id: randomUUID(),
        turn_id: 'pending',
        name: 'chart.png',
        mime_type: 'image/png',
        url: `http://127.0.0.1:${address.port}/chart`,
      },
    ];
    const t = await setup(undefined, 30, true, false, events);
    const sent = await t.app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/messages`,
      payload: { client_id: randomUUID(), text: 'Chart' },
    });
    expect(sent.statusCode).toBe(201);
    let reply;
    for (let i = 0; i < 100; i++) {
      reply = (await t.db.listMessages('alice', agent, { limit: 20 })).messages.find(
        (item) => item.kind === 'agent_text',
      );
      if (reply) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (reply?.kind !== 'agent_text') throw new Error('no reply');
    expect(reply.text).toBe('');
    expect(reply.attachments).toHaveLength(1);
    expect(
      (await t.files.bytes(t.db.findFile('alice', reply.attachments![0]!.id)!)).equals(png),
    ).toBe(true);
  });
  it('attaches turn file events in order, including a file-only reply, and ignores a sixth', async () => {
    const events: AgentEvent[] = [];
    const t = await setup(undefined, 30, true, false, events);
    for (let i = 0; i < 6; i++) {
      const saved = await t.files.upload({
        userId: 'alice',
        agentId: agent,
        clientId: randomUUID(),
        name: `file${i}.png`,
        mimeType: 'image/png',
        bytes: t.png,
        direction: 'agent',
      });
      events.push({
        type: 'file',
        event_id: randomUUID(),
        turn_id: 'pending',
        name: `file${i}.png`,
        mime_type: 'image/png',
        file_id: saved.file.id,
      });
    }
    const sent = await t.app.inject({
      method: 'POST',
      url: `/v1/agents/${agent}/messages`,
      payload: { client_id: randomUUID(), text: 'Show files' },
    });
    expect(sent.statusCode).toBe(201);
    let reply;
    for (let i = 0; i < 100; i++) {
      reply = (await t.db.listMessages('alice', agent, { limit: 20 })).messages.find(
        (item) => item.kind === 'agent_text',
      );
      if (reply) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(reply).toMatchObject({ kind: 'agent_text', text: '' });
    if (reply?.kind === 'agent_text')
      expect(reply.attachments?.map((item) => item.id)).toEqual(
        events.slice(0, 5).map((item) => (item.type === 'file' ? item.file_id : undefined)),
      );
  });
  it('authenticates connector uploads, scopes agents, and counts the owner quota', async () => {
    const t = await setup({ quotaBytes: 25, perDay: 1 }, 30, true, true);
    const connectorId = `con_${'a'.repeat(20)}`;
    const token = `cct_${'a'.repeat(43)}`;
    await t.stores.connectors.create({
      id: connectorId,
      user_id: 'alice',
      name: 'Computer',
      token_hash: hashConnectorToken(token),
      agents: [],
      created_at: new Date().toISOString(),
    });
    await t.stores.agents.create({
      id: `agt_${'c'.repeat(20)}`,
      user_id: 'alice',
      name: 'Computer agent',
      protocol: 'cord-connector',
      endpoint_url: connectorEndpointUrl(connectorId, 'claude-code'),
      voice_id: 'flux-aura-en',
      status: 'ready',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const url = `/v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&name=picture.png`;
    const send = (target: string, authorization?: string) =>
      t.app.inject({
        method: 'POST',
        url: target,
        headers: {
          'content-type': 'application/octet-stream',
          ...(authorization && { authorization }),
        },
        payload: t.png,
      });
    expect((await send(url)).statusCode).toBe(401);
    const first = await send(url, `Bearer ${token}`);
    expect(first.statusCode).toBe(201);
    expect((await send(url, `Bearer ${token}`)).statusCode).toBe(200);
    expect((await send(url.replace('claude-code', 'other'), `Bearer ${token}`)).statusCode).toBe(
      404,
    );
    expect(
      t.db.findFile('alice', fileUploadResponseSchema.parse(first.json()).file.id)?.direction,
    ).toBe('agent');
    const fileId = fileUploadResponseSchema.parse(first.json()).file.id;
    const message = { local_agent: 'claude-code', text: '', origin: 'agent', file_ids: [fileId] };
    const messageHeaders = {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'file-message-one',
    };
    const delivered = await t.app.inject({
      method: 'POST',
      url: '/v1/connectors/messages',
      headers: messageHeaders,
      payload: message,
    });
    expect(delivered.statusCode).toBe(201);
    expect(
      (
        await t.db.findMessageById(
          'alice',
          `agt_${'c'.repeat(20)}`,
          connectorMessageResponseSchema.parse(delivered.json()).message_id,
        )
      )?.kind,
    ).toBe('agent_text');
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/v1/connectors/messages',
          headers: messageHeaders,
          payload: message,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/v1/connectors/messages',
          headers: { ...messageHeaders, 'idempotency-key': 'file-message-two' },
          payload: message,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await send(url.replace(/client_id=[^&]+/, `client_id=${randomUUID()}`), `Bearer ${token}`))
        .statusCode,
    ).toBe(507);
  });
  it('attaches agent files to a captionless connector result in order and rejects reused files', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const saved = await t.files.upload({
        userId: 'alice',
        agentId: agent,
        clientId: randomUUID(),
        name: `image${i}.png`,
        mimeType: 'image/png',
        bytes: t.png,
        direction: 'agent',
      });
      ids.push(saved.file.id);
    }
    const input = {
      text: '',
      origin: 'agent' as const,
      idempotencyKey: 'result-one',
      target: { connectorId: 'con_test', localAgent: 'agent', agentName: 'Agent' },
      fileIds: ids,
    };
    const first = await t.service.deliverResult('alice', agent, input);
    expect(first.created).toBe(true);
    expect(await t.db.findMessageById('alice', agent, first.messageId)).toMatchObject({
      kind: 'agent_text',
      text: '',
      attachments: [{ id: ids[0] }, { id: ids[1] }],
    });
    expect((await t.service.deliverResult('alice', agent, input)).created).toBe(false);
    await expect(
      t.service.deliverResult('alice', agent, { ...input, idempotencyKey: 'result-two' }),
    ).rejects.toMatchObject({ code: 'bad_attachment' });
    const owner = await t.files.upload({
      userId: 'alice',
      agentId: agent,
      clientId: randomUUID(),
      name: 'owner.png',
      mimeType: 'image/png',
      bytes: t.png,
    });
    await expect(
      t.service.deliverResult('alice', agent, {
        ...input,
        idempotencyKey: 'result-three',
        fileIds: [owner.file.id],
      }),
    ).rejects.toMatchObject({ code: 'bad_attachment' });
    const foreign = await t.files.upload({
      userId: 'alice',
      agentId: other,
      clientId: randomUUID(),
      name: 'foreign.png',
      mimeType: 'image/png',
      bytes: t.png,
      direction: 'agent',
    });
    await expect(
      t.service.deliverResult('alice', agent, {
        ...input,
        idempotencyKey: 'result-four',
        fileIds: [foreign.file.id],
      }),
    ).rejects.toMatchObject({ code: 'bad_attachment' });
  });
  it('refuses attachment ids when files are disabled', async () => {
    const t = await setup(undefined, 30, false);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/v1/agents/${agent}/messages`,
          payload: {
            client_id: randomUUID(),
            text: '',
            attachment_ids: [`fil_${'a'.repeat(20)}`],
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/v1/threads' })).json().files).toBe(false);
  });
  it('uploads, isolates owner and agent paths, and accepts Android empty content type', async () => {
    const t = await setup();
    const clientId = randomUUID();
    const created = await t.upload(t.png, '../photo.txt', clientId, { 'content-type': '' });
    expect(created.statusCode).toBe(201);
    const file = created.json().file;
    expect(file).toMatchObject({
      name: 'photo.txt.png',
      mime_type: 'image/png',
      width: 20,
      height: 10,
    });
    expect((await t.upload(t.png, 'ignored.png', clientId)).statusCode).toBe(200);
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/agents/${agent}/files/${file.id}` }))
        .rawPayload,
    ).toEqual(t.png);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/v1/agents/${agent}/files/${file.id}`,
          headers: { 'x-user': 'bob' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: `/v1/agents/${other}/files/${file.id}` }))
        .statusCode,
    ).toBe(404);
    expect((await t.upload(Buffer.alloc(0))).statusCode).toBe(400);
    expect((await t.upload(Buffer.from([0, 1, 2]))).statusCode).toBe(415);
    expect((await t.upload(Buffer.alloc(10 * 1024 * 1024 + 1, 65))).statusCode).toBe(413);
  });

  it('enforces storage, daily and per-minute limits', async () => {
    const storage = await setup({ quotaBytes: 25, perDay: 100 });
    expect((await storage.upload(storage.png)).statusCode).toBe(201);
    expect((await storage.upload(storage.png)).statusCode).toBe(507);
    const daily = await setup({ quotaBytes: 1000, perDay: 1 });
    expect((await daily.upload(daily.png)).statusCode).toBe(201);
    expect((await daily.upload(daily.png)).statusCode).toBe(429);
    const rate = await setup(undefined, 1);
    expect((await rate.upload(rate.png)).statusCode).toBe(201);
    expect((await rate.upload(rate.png)).json().error.code).toBe('rate_limited');
  });

  it('sends attachment links and removes files on clear and sweep', async () => {
    const t = await setup();
    const result = await t.upload(t.png);
    const id = result.json().file.id as string;
    const link = t.files.signedLink(id);
    expect((await t.app.inject({ method: 'GET', url: link })).statusCode).toBe(404);
    const messageUrl = `/v1/agents/${agent}/messages`;
    const client = randomUUID();
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { client_id: client, text: '', attachment_ids: [id] },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: messageUrl,
          payload: { client_id: client, text: '', attachment_ids: [id] },
        })
      ).statusCode,
    ).toBe(200);
    const until = Date.now() + 1000;
    while (!t.turns.length && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.turns[0]?.text).toBe('[Attached: photo.png (PNG image, 24 B)]');
    expect(t.turns[0]?.attachments).toHaveLength(1);
    expect((await t.app.inject({ method: 'GET', url: link })).rawPayload).toEqual(t.png);
    const altered = new URL(link);
    altered.searchParams.set('sig', 'x'.repeat(43));
    expect((await t.app.inject({ method: 'GET', url: altered.toString() })).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: t.files.signedLink(id, new Date(Date.now() - 20 * 60_000)),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: t.files.signedLink(id, new Date(Date.now() + 2 * 60_000)),
        })
      ).statusCode,
    ).toBe(404);
    await t.service.clear('alice', agent);
    expect(t.db.findFile('alice', id)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', id))).toBe(false);
    const stale = (await t.upload(t.png)).json().file.id as string;
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    t.db.deleteFiles([stale]);
    utimesSync(join(t.dir, 'files', stale), old, old);
    await t.files.sweep();
    expect(existsSync(join(t.dir, 'files', stale))).toBe(false);
  });

  it('rejects files from another agent or owner and removes blobs on agent and account deletion', async () => {
    const t = await setup();
    const own = (await t.upload(t.png)).json().file.id as string;
    const otherFile = t.files.store.insertFile({
      id: `fil_${'c'.repeat(20)}`,
      userId: 'alice',
      agentId: other,
      clientId: randomUUID(),
      direction: 'owner',
      name: 'other.png',
      mime_type: 'image/png',
      size_bytes: t.png.length,
      sha256: 'a'.repeat(64),
    }).file;
    await t.blobs.write(otherFile.id, Buffer.from('not used'));
    const url = `/v1/agents/${agent}/messages`;
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url,
          payload: { client_id: randomUUID(), text: '', attachment_ids: [otherFile.id] },
        })
      ).statusCode,
    ).toBe(400);
    const bob = t.files.store.insertFile({
      id: `fil_${'d'.repeat(20)}`,
      userId: 'bob',
      agentId: agent,
      clientId: randomUUID(),
      direction: 'owner',
      name: 'bob.png',
      mime_type: 'image/png',
      size_bytes: t.png.length,
      sha256: 'b'.repeat(64),
    }).file;
    await t.blobs.write(bob.id, Buffer.from('not used'));
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url,
          payload: { client_id: randomUUID(), text: '', attachment_ids: [bob.id] },
        })
      ).statusCode,
    ).toBe(400);
    await t.service.deleteAgent('alice', agent);
    expect(t.db.findFile('alice', own)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', own))).toBe(false);
    await t.service.deleteAllForUser('bob');
    expect(t.db.findFile('bob', bob.id)).toBeUndefined();
    expect(existsSync(join(t.dir, 'files', bob.id))).toBe(false);
  });
});
