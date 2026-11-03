import {
  startFakeNativeServer,
  type FakeNativeServer,
} from '@twring/agent-adapter/fake-native-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentListResponseSchema,
  agentSchema,
  callHistoryResponseSchema,
  connectionTestResponseSchema,
  errorResponseSchema,
  voiceListResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { StoreCorruptError } from '../store/collection';
import { createMemoryStores, type Stores } from '../store/repositories';

import { DEV_USER_ID } from './routes';

const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const SECRET = 'sk-agent-secret-never-echoed';
const PUBLIC_URL = 'https://agent.example.com/cord/turns';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function setup(
  options: { stores?: Stores | undefined; writeRate?: number; cartesia?: boolean } = {},
) {
  const stores = 'stores' in options ? options.stores : createMemoryStores(KEYS);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    onError: () => undefined,
    agents: {
      stores,
      policy: {
        env: 'development',
        lookup: (host) =>
          Promise.resolve([
            {
              address: host.startsWith('metadata') ? '169.254.169.254' : '93.184.215.14',
              family: 4,
            },
          ]),
      },
      writeRatePerMinute: options.writeRate ?? 100,
      testBudget: { connectTimeoutMs: 2_000, probeTimeoutMs: 2_000 },
      ...(options.cartesia !== undefined && { cartesiaVoices: options.cartesia }),
    },
  });
  cleanups.push(() => app.close());
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress: '203.0.113.9',
      ...(payload !== undefined && { payload: payload as object }),
    });
  return { app, stores: stores!, send };
}

async function createAgent(
  send: ReturnType<typeof setup>['send'],
  body: Record<string, unknown> = {},
) {
  const res = await send('POST', '/v1/agents', {
    name: 'Operator',
    protocol: 'cord-rest',
    endpoint_url: PUBLIC_URL,
    credential: SECRET,
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return agentSchema.parse(res.json());
}

async function nativeServer(): Promise<FakeNativeServer> {
  const server = await startFakeNativeServer({ token: SECRET, mode: 'streamed' });
  cleanups.push(() => server.close());
  return server;
}

describe('POST /v1/agents/:id/new-conversation', () => {
  it('resets a saved OpenAI-compatible session key', async () => {
    const { send, stores } = setup();
    const agent = await createAgent(send, {
      protocol: 'openai-chat',
      endpoint_url: 'http://127.0.0.1:8787/v1',
      model: 'openclaw:main',
    });
    const before = await stores.agents.ensureSessionKey(DEV_USER_ID, agent.id);
    expect(await stores.agents.ensureSessionKey(DEV_USER_ID, agent.id)).toBe(before);
    expect((await send('POST', `/v1/agents/${agent.id}/new-conversation`)).statusCode).toBe(200);
    const after = await stores.agents.ensureSessionKey(DEV_USER_ID, agent.id);
    expect(before).toMatch(/^twring-[0-9a-f]+$/);
    expect(after).not.toBe(before);
  });

  it('creates, tests, and updates an OpenAI-compatible agent with its model', async () => {
    const server = createServer((req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ready"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No server address');
    const { send } = setup();
    const agent = await createAgent(send, {
      protocol: 'openai-chat',
      endpoint_url: `http://127.0.0.1:${address.port}/v1`,
      model: 'openclaw:main',
    });
    expect(agent.model).toBe('openclaw:main');
    const tested = connectionTestResponseSchema.parse(
      (await send('POST', `/v1/agents/${agent.id}/test`)).json(),
    );
    expect(tested.result.ok).toBe(true);
    const updated = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { model: 'other' })).json(),
    );
    expect(updated.model).toBe('other');
    expect(updated.status).toBe('untested');
    const cleared = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { model: null })).json(),
    );
    expect(cleared.model).toBeUndefined();
  });
  it('rejects non-connector protocols and shares the edit write limit', async () => {
    const stores = createMemoryStores(KEYS);
    const stamp = new Date().toISOString();
    const base = {
      user_id: DEV_USER_ID,
      name: 'Operator',
      voice_id: 'flux-haley-en',
      status: 'untested' as const,
      created_at: stamp,
      updated_at: stamp,
    };
    const restId = 'agt_aaaaaaaaaaaaaaaaaaaa';
    const nativeId = 'agt_bbbbbbbbbbbbbbbbbbbb';
    const connectorId = 'agt_cccccccccccccccccccc';
    await stores.agents.create({
      ...base,
      id: restId,
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
    });
    await stores.agents.create({
      ...base,
      id: nativeId,
      protocol: 'cord-native',
      endpoint_url: 'wss://agent.example.com/cord',
    });
    await stores.agents.create({
      ...base,
      id: connectorId,
      protocol: 'cord-connector',
      endpoint_url: 'cord-connector://con_aaaaaaaaaaaaaaaaaaaa/echo',
    });
    const { send } = setup({ stores, writeRate: 3 });
    for (const id of [restId, nativeId]) {
      const result = await send('POST', `/v1/agents/${id}/new-conversation`);
      expect(result.statusCode).toBe(400);
      expect(result.json()).toMatchObject({ error: { code: 'not_supported' } });
    }
    expect((await send('POST', `/v1/agents/${connectorId}/new-conversation`)).statusCode).toBe(200);
    expect((await send('POST', `/v1/agents/${connectorId}/new-conversation`)).statusCode).toBe(429);
  });
});

describe('GET /v1/voices', () => {
  it('lists the server-owned voices with the default', async () => {
    const { send } = setup();
    const body = voiceListResponseSchema.parse((await send('GET', '/v1/voices')).json());
    expect(body.default_voice_id).toBe('flux-haley-en');
    expect(body.voices.map((v) => v.id)).toContain('flux-haley-en');
  });

  it('defaults to Janvi when Cartesia is configured (ADR-022)', async () => {
    const { send } = setup({ cartesia: true });
    const body = voiceListResponseSchema.parse((await send('GET', '/v1/voices')).json());
    expect(body.default_voice_id).toBe('cartesia-janvi-en');
    expect(body.voices.map((v) => v.id)).toContain('cartesia-janvi-en');
  });
});

describe('new agent default voice', () => {
  it('is Janvi with Cartesia configured and Haley without; an explicit voice is kept', async () => {
    const withCartesia = setup({ cartesia: true });
    expect((await createAgent(withCartesia.send)).voice_id).toBe('cartesia-janvi-en');
    expect((await createAgent(withCartesia.send, { voice_id: 'flux-kit-en' })).voice_id).toBe(
      'flux-kit-en',
    );
    const plain = setup({ cartesia: false });
    expect((await createAgent(plain.send)).voice_id).toBe('flux-haley-en');
  });
});

describe('agents CRUD', () => {
  it('returns the known MCP client kind only for AI app contacts', async () => {
    const { send, stores } = setup();
    const now = new Date().toISOString();
    const id = 'agt_abcdefghij0123456789';
    await stores.agents.create({
      id,
      user_id: DEV_USER_ID,
      name: 'My coding agent',
      protocol: 'mcp-app',
      endpoint_url: 'mcp-app://client',
      mcp_client: 'claude-code',
      voice_id: 'flux-haley-en',
      status: 'ready',
      created_at: now,
      updated_at: now,
    });
    const response = await send('GET', `/v1/agents/${id}`);
    expect(response.statusCode).toBe(200);
    expect(agentSchema.parse(response.json()).mcp_client).toBe('claude-code');
    const otherId = 'agt_abcdefghij0123456788';
    await stores.agents.create({
      id: otherId,
      user_id: DEV_USER_ID,
      name: 'Other',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      mcp_client: 'codex',
      voice_id: 'flux-haley-en',
      status: 'ready',
      created_at: now,
      updated_at: now,
    });
    expect(
      agentSchema.parse((await send('GET', `/v1/agents/${otherId}`)).json()).mcp_client,
    ).toBeUndefined();
  });
  it('creates, reads, lists, updates, and deletes without ever echoing the credential', async () => {
    const { send, stores } = setup();
    const created = await createAgent(send);
    expect(created).toMatchObject({
      name: 'Operator',
      protocol: 'cord-rest',
      voice_id: 'flux-haley-en',
      has_credential: true,
      status: 'untested',
    });

    const got = await send('GET', `/v1/agents/${created.id}`);
    const list = await send('GET', '/v1/agents');
    expect(agentListResponseSchema.parse(list.json()).agents).toHaveLength(1);

    const renamed = await send('PATCH', `/v1/agents/${created.id}`, {
      name: 'Butler',
      voice_id: 'flux-kit-en',
    });
    expect(renamed.json()).toMatchObject({ name: 'Butler', voice_id: 'flux-kit-en' });

    const cleared = await send('PATCH', `/v1/agents/${created.id}`, { credential: null });
    expect(cleared.json()).toMatchObject({ has_credential: false });
    await send('PATCH', `/v1/agents/${created.id}`, { credential: `${SECRET}-2` });

    for (const res of [got, list, renamed, cleared]) {
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain('ciphertext');
    }

    const deleted = await send('DELETE', `/v1/agents/${created.id}`);
    expect(deleted.statusCode).toBe(204);
    expect(await stores.credentials.has(DEV_USER_ID, created.id)).toBe(false);
    expect((await send('GET', `/v1/agents/${created.id}`)).statusCode).toBe(404);
    expect((await send('DELETE', `/v1/agents/${created.id}`)).statusCode).toBe(404);
  });

  it.each([
    [{ name: '' }],
    [{ name: 'x'.repeat(61) }],
    [{ protocol: 'grpc' }],
    [{ endpoint_url: 'not a url' }],
    [{ endpoint_url: 'wss://agent.example.com' }], // ws scheme with cord-rest
    [{ voice_id: 'flux-nobody-en' }],
    [{ voice_id: 'aura-2-thalia-en' }],
    [{ user_id: 'someone-else' }],
    [{ keyterms: ['  '] }],
    [{ keyterms: ['x'.repeat(51)] }],
    [{ keyterms: ['a‮b'] }],
    [{ keyterms: Array.from({ length: 41 }, (_, i) => `t${i}`) }],
    [{ keyterms: 'Chennai' }],
  ])('rejects invalid input %j', async (override) => {
    const { send } = setup();
    const res = await send('POST', '/v1/agents', {
      name: 'Operator',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      ...override,
    });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('bad_request');
  });

  it('stores words to recognise trimmed and deduped, and edits them without a retest', async () => {
    const { send } = setup();
    const agent = await createAgent(send, { keyterms: [' Chennai ', 'chennai', 'Priya'] });
    expect(agent.keyterms).toEqual(['Chennai', 'Priya']);
    const plain = await createAgent(send);
    expect(plain.keyterms).toEqual([]);
    const res = await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: ['Madurai'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(agentSchema.parse(res.json())).toMatchObject({
      keyterms: ['Madurai'],
      status: agent.status,
    });
    const bad = await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: ['a\nb'] });
    expect(bad.statusCode).toBe(400);
  });

  it('PATCH keyterms: [] clears, omitted leaves them, and a ready agent stays ready (m9 verifier)', async () => {
    const server = await nativeServer();
    const { send } = setup();
    const agent = await createAgent(send, {
      protocol: 'cord-native',
      endpoint_url: server.url,
      keyterms: ['Chennai', 'Priya'],
    });
    expect((await send('POST', `/v1/agents/${agent.id}/test`)).statusCode).toBe(200);

    const renamed = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { name: 'Butler' })).json(),
    );
    expect(renamed.keyterms).toEqual(['Chennai', 'Priya']);

    const edited = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: ['Madurai', 'madurai'] })).json(),
    );
    expect(edited).toMatchObject({ keyterms: ['Madurai'], status: 'ready' });
    expect(edited.last_test?.ok).toBe(true);

    const cleared = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: [] })).json(),
    );
    expect(cleared).toMatchObject({ keyterms: [], status: 'ready' });
    const got = agentSchema.parse((await send('GET', `/v1/agents/${agent.id}`)).json());
    expect(got.keyterms).toEqual([]);

    expect((await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: null })).statusCode).toBe(
      400,
    );
  });

  it('reads a row stored before keyterms existed as [] and keeps it editable (m9 verifier)', async () => {
    const { send, stores } = setup();
    const stamp = '2026-08-01T00:00:00.000Z';
    await stores.agents.create({
      id: 'agt_0123456789abcdef0123',
      user_id: DEV_USER_ID,
      name: 'Old',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      voice_id: 'flux-haley-en',
      status: 'untested',
      created_at: stamp,
      updated_at: stamp,
    });
    const [old] = agentListResponseSchema.parse((await send('GET', '/v1/agents')).json()).agents;
    expect(old).toMatchObject({ name: 'Old', keyterms: [] });
    const renamed = await send('PATCH', `/v1/agents/${old!.id}`, { name: 'Older' });
    expect(agentSchema.parse(renamed.json()).keyterms).toEqual([]);
    const words = await send('PATCH', `/v1/agents/${old!.id}`, { keyterms: ['Ooty'] });
    expect(agentSchema.parse(words.json()).keyterms).toEqual(['Ooty']);
  });

  it('rejects private, metadata, and credential-bearing endpoints', async () => {
    const { send, stores } = setup();
    for (const endpoint_url of [
      'https://metadata.example/latest',
      'http://169.254.169.254/latest/meta-data',
      'https://10.0.0.8/cord',
      'https://user:pass@agent.example.com/cord',
    ]) {
      const res = await send('POST', '/v1/agents', {
        name: 'Operator',
        protocol: 'cord-rest',
        endpoint_url,
        credential: SECRET,
      });
      expect(res.statusCode, endpoint_url).toBe(400);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('endpoint_rejected');
    }
    expect(await stores.agents.list(DEV_USER_ID)).toEqual([]);
  });

  it('rechecks the endpoint on edit and the protocol/scheme pair against the saved value', async () => {
    const { send } = setup();
    const agent = await createAgent(send);
    const ssrf = await send('PATCH', `/v1/agents/${agent.id}`, {
      endpoint_url: 'http://192.168.1.1/x',
    });
    expect(ssrf.json()).toMatchObject({ error: { code: 'endpoint_rejected' } });
    const mismatch = await send('PATCH', `/v1/agents/${agent.id}`, { protocol: 'cord-native' });
    expect(mismatch.statusCode).toBe(400);
    expect((await send('PATCH', `/v1/agents/${agent.id}`, {})).statusCode).toBe(400);
  });

  it('answers 404 for unknown or malformed ids', async () => {
    const { send } = setup();
    for (const id of ['agt_zzzzzzzzzzzzzzzzzzzz', '../etc', 'agt_']) {
      expect((await send('GET', `/v1/agents/${id}`)).statusCode).toBe(404);
      expect((await send('POST', `/v1/agents/${id}/test`)).statusCode).toBe(404);
    }
  });

  it('rate-limits writes per client', async () => {
    const { send } = setup({ writeRate: 1 });
    await createAgent(send);
    const res = await send('POST', '/v1/agents', {
      name: 'Two',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
    });
    expect(res.statusCode).toBe(429);
  });

  it('answers 503 when saved agents are not configured', async () => {
    const { send } = setup({ stores: undefined });
    const res = await send('GET', '/v1/agents');
    expect(res.statusCode).toBe(503);
    expect((await send('GET', '/v1/voices')).statusCode).toBe(200);
  });
});

describe('POST /v1/agents/:id/test', () => {
  it('marks a reachable agent ready with the checks it performed', async () => {
    const server = await nativeServer();
    const { send } = setup();
    const agent = await createAgent(send, { protocol: 'cord-native', endpoint_url: server.url });
    const res = await send('POST', `/v1/agents/${agent.id}/test`);
    expect(res.statusCode).toBe(200);
    const body = connectionTestResponseSchema.parse(res.json());
    expect(body.result.ok).toBe(true);
    expect(body.result.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'endpoint:passed',
      'authentication:passed',
      'response:passed',
      'streaming:passed',
    ]);
    expect(body.agent.status).toBe('ready');
    expect(body.agent.last_tested_at).toBe(body.result.tested_at);
    expect(res.body).not.toContain(SECRET);
  });

  it('marks a rejected credential failing, then untested after the credential changes', async () => {
    const server = await nativeServer();
    const { send } = setup();
    const agent = await createAgent(send, {
      protocol: 'cord-native',
      endpoint_url: server.url,
      credential: 'the-wrong-secret',
    });
    const res = await send('POST', `/v1/agents/${agent.id}/test`);
    const body = connectionTestResponseSchema.parse(res.json());
    expect(body.result.ok).toBe(false);
    expect(body.result.checks).toContainEqual({ name: 'authentication', status: 'failed' });
    expect(body.agent.status).toBe('failing');
    expect(res.body).not.toContain('the-wrong-secret');

    const fixed = await send('PATCH', `/v1/agents/${agent.id}`, { credential: SECRET });
    expect(fixed.json()).toMatchObject({ status: 'untested' });
    expect(fixed.json()).not.toHaveProperty('last_test');
    const retest = connectionTestResponseSchema.parse(
      (await send('POST', `/v1/agents/${agent.id}/test`)).json(),
    );
    expect(retest.agent.status).toBe('ready');
  });

  it('trims a pasted key before storing it, so it still authenticates', async () => {
    const server = await startFakeNativeServer({ token: 'cord-demo', mode: 'streamed' });
    cleanups.push(() => server.close());
    const { send, stores } = setup();
    const agent = await createAgent(send, {
      protocol: 'cord-native',
      endpoint_url: server.url,
      credential: ' cord-demo \n',
    });
    expect(await stores.credentials.get(DEV_USER_ID, agent.id)).toBe('cord-demo');
    const body = connectionTestResponseSchema.parse(
      (await send('POST', `/v1/agents/${agent.id}/test`)).json(),
    );
    expect(body.result.ok).toBe(true);

    const patched = await send('PATCH', `/v1/agents/${agent.id}`, {
      credential: '\u00a0\tcord-demo\r\n',
    });
    expect(patched.statusCode).toBe(200);
    expect(await stores.credentials.get(DEV_USER_ID, agent.id)).toBe('cord-demo');
  });

  it('treats a whitespace-only key as no key on create and refuses it on edit', async () => {
    const { send, stores } = setup();
    const agent = await createAgent(send, { credential: ' \t\n\u00a0' });
    expect(agent.has_credential).toBe(false);
    expect(await stores.credentials.has(DEV_USER_ID, agent.id)).toBe(false);

    const withKey = await createAgent(send);
    const blank = await send('PATCH', `/v1/agents/${withKey.id}`, { credential: '  \n' });
    expect(blank.statusCode).toBe(400);
    expect(errorResponseSchema.parse(blank.json()).error.message).toMatch(/API key is empty/);
    expect(await stores.credentials.get(DEV_USER_ID, withKey.id)).toBe(SECRET);
    const removed = await send('PATCH', `/v1/agents/${withKey.id}`, { credential: null });
    expect(removed.json()).toMatchObject({ has_credential: false });
  });

  it('fails an unreachable agent within the budget', async () => {
    const server = await nativeServer();
    const url = server.url;
    await server.close();
    const { send } = setup();
    const agent = await createAgent(send, { protocol: 'cord-native', endpoint_url: url });
    const body = connectionTestResponseSchema.parse(
      (await send('POST', `/v1/agents/${agent.id}/test`)).json(),
    );
    expect(body.result.checks).toEqual([{ name: 'endpoint', status: 'failed' }]);
    expect(body.agent.status).toBe('failing');
  });

  it('asks for the credential again when it can no longer be decrypted', async () => {
    const { send, stores } = setup();
    const agent = await createAgent(send);
    const failing = {
      ...stores.credentials,
      get: () => Promise.reject(new Error('decrypt')),
      has: () => Promise.resolve(true),
    };
    const broken = setup({ stores: { ...stores, credentials: failing } });
    const res = await broken.send('POST', `/v1/agents/${agent.id}/test`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'credential_unreadable' } });
  });
});

describe('GET /v1/calls/history', () => {
  it('returns the most recent 50 calls, newest first', async () => {
    const { send, stores } = setup();
    for (let n = 0; n < 55; n += 1) {
      await stores.history.record(DEV_USER_ID, {
        call_id: `call_${String(n).padStart(20, '0')}`,
        agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
        agent_name: 'Operator',
        started_at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
        duration_s: n,
        outcome: n % 2 === 0 ? 'completed' : 'failed',
        end_reason: 'hangup',
      });
    }
    const body = callHistoryResponseSchema.parse((await send('GET', '/v1/calls/history')).json());
    expect(body.calls).toHaveLength(50);
    expect(body.calls[0]?.duration_s).toBe(54);
  });
});
import { createServer } from 'node:http';

describe('GET /v1/voices with a person’s own Cartesia key', () => {
  function ownSetup(enabled: boolean) {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development' },
        writeRatePerMinute: 100,
        cartesiaVoices: false,
        speech: {
          resolve: (userId) =>
            Promise.resolve(
              enabled && userId === 'alice'
                ? { cartesia: { apiKey: 'own-cartesia-secret', source: 'own' as const } }
                : {},
            ),
        },
      },
    });
    cleanups.push(() => app.close());
    return (user: string) =>
      app
        .inject({ method: 'GET', url: '/v1/voices', headers: { 'x-user': user } })
        .then((res) => voiceListResponseSchema.parse(res.json()).voices.map((v) => v.id));
  }

  it('lists Cartesia voices for Alice (own key) and not for Bob', async () => {
    const list = ownSetup(true);
    expect(await list('alice')).toContain('cartesia-janvi-en');
    expect(await list('bob')).not.toContain('cartesia-janvi-en');
  });

  it('with the switch off lists only the server voices', async () => {
    expect(await ownSetup(false)('alice')).not.toContain('cartesia-janvi-en');
  });
});

describe('GET /v1/voices with a person’s own xAI key', () => {
  it('lists Grok voices for Alice (own xAI key) and not for Bob', async () => {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development' },
        writeRatePerMinute: 100,
        cartesiaVoices: false,
        speech: {
          resolve: (userId) =>
            Promise.resolve(
              userId === 'alice'
                ? { xai: { apiKey: 'own-xai-secret', source: 'own' as const } }
                : {},
            ),
        },
      },
    });
    cleanups.push(() => app.close());
    const list = async (user: string) => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/voices',
        headers: { 'x-user': user },
      });
      expect(res.body).not.toContain('own-xai-secret');
      return voiceListResponseSchema.parse(res.json()).voices.map((v) => v.id);
    };
    expect(await list('alice')).toContain('xai-eve-en');
    expect(await list('bob')).not.toContain('xai-eve-en');
  });
});

describe('GET /v1/voices on a self-hosted server with only its own xAI key', () => {
  function xaiServer(withSpeech: boolean) {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development' },
        writeRatePerMinute: 100,
        cartesiaVoices: false,
        serverXaiVoices: true,
        ...(withSpeech && {
          speech: {
            resolve: (userId: string) =>
              Promise.resolve({
                xai: { apiKey: 'server-xai-key', source: 'twring' as const },
                ...(userId === 'alice' && {
                  deepgram: { apiKey: 'own-dg-secret', source: 'own' as const },
                }),
              }),
          },
        }),
      },
    });
    cleanups.push(() => app.close());
    return async (user: string) => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/voices',
        headers: { 'x-user': user },
      });
      return voiceListResponseSchema.parse(res.json());
    };
  }

  it('lists the Grok voices with Eve as the default, and no Deepgram voices', async () => {
    for (const withSpeech of [true, false]) {
      const body = await xaiServer(withSpeech)('bob');
      expect(body.voices.map((v) => v.id)).toEqual([
        'xai-eve-en',
        'xai-ara-en',
        'xai-rex-en',
        'xai-sal-en',
        'xai-leo-en',
      ]);
      expect(body.default_voice_id).toBe('xai-eve-en');
    }
  });

  it('adds the Deepgram voices for a person with their own Deepgram key', async () => {
    const body = await xaiServer(true)('alice');
    expect(body.voices.map((v) => v.id)).toContain('flux-haley-en');
    expect(body.voices.map((v) => v.id)).toContain('xai-eve-en');
    expect(body.default_voice_id).toBe('xai-eve-en');
  });
});

describe('GET /v1/voices with an unreadable key store', () => {
  it('logs speech_keys_unavailable, alerts, and still lists the server voices', async () => {
    const lines: string[] = [];
    const onError = vi.fn();
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError,
      userFor: () => 'alice',
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development' },
        writeRatePerMinute: 100,
        cartesiaVoices: false,
        speech: { resolve: () => Promise.reject(new StoreCorruptError('speech-keys.json')) },
      },
    });
    cleanups.push(() => app.close());
    const res = await app.inject({ method: 'GET', url: '/v1/voices' });
    expect(res.statusCode).toBe(200);
    expect(voiceListResponseSchema.parse(res.json()).voices.map((v) => v.id)).toContain(
      'flux-haley-en',
    );
    const logged = lines.find((line) => line.includes('speech_keys_unavailable'));
    expect(logged).toBeDefined();
    expect(logged).not.toContain('speech-keys.json');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
