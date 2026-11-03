import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { startFakeNativeServer } from '@twring/agent-adapter/fake-native-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentSchema,
  createCallResponseSchema,
  deleteMyDataResponseSchema,
  errorResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { savedAgentResolver } from './agents/routes';
import { VoiceSampleCache } from './agents/voice-samples';
import { buildApp, type BuildAppOptions } from './app';
import { CallCreateError, CallRegistry } from './calls/registry';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './calls/testing';
import { mintCallerToken, mintGatewayToken } from './livekit/tokens';
import { createLoggerOptions } from './logger';
import { FixedWindowLimiter } from './rate-limit';
import { MemoryCollection } from './store/collection';
import { createFileStores, createMemoryStores, type Stores } from './store/repositories';

// Milestone 10: rate and size limits, kill switches, the data-deletion route's edges, the
// production test-line refusal, and a log capture proving no secret reaches the logs.

const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 3).toString('base64')]]) };
const SECRET = 'sk-hardening-agent-secret-7f3a9c';
const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'APIfaketestkey',
  apiSecret: 'fake-secret-value-for-tests-0123456789',
};
const PUBLIC_LOOKUP = () => Promise.resolve([{ address: '93.184.215.14', family: 4 as const }]);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function registry(envOverrides: Record<string, string> = {}) {
  const env = loadGatewayEnv(
    gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'off', ...envOverrides }),
  );
  const calls = new CallRegistry({
    env,
    liveKitUrl: LIVEKIT.url,
    rooms: {
      deleteRoom: () => Promise.resolve(),
      removeParticipant: () => Promise.resolve(),
      ping: () => Promise.resolve(),
    },
    tokens: {
      caller: (request) => mintCallerToken(LIVEKIT, request),
      gateway: (request) => mintGatewayToken(LIVEKIT, request),
    },
    transports: () => new FakeTransport(),
    scheduler: new ManualScheduler(),
    logger: recordingLogger(),
  });
  cleanups.push(() => calls.shutdown());
  return calls;
}

function setup(rest: Partial<BuildAppOptions> = {}, withStores = true) {
  const env = loadGatewayEnv(gatewayEnvFixture());
  const stores = withStores ? createMemoryStores(KEYS) : undefined;
  const app = buildApp({
    env,
    onError: () => undefined,
    agents: {
      stores,
      policy: { env: 'development', lookup: PUBLIC_LOOKUP },
      writeRatePerMinute: 100,
      testRatePerMinute: 100,
      readRatePerMinute: 100,
      testBudget: { connectTimeoutMs: 2_000, probeTimeoutMs: 2_000 },
    },
    me: { deleteRatePerMinute: 100 },
    ...rest,
  });
  cleanups.push(() => app.close());
  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object | string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: '203.0.113.20',
      headers,
      ...(payload !== undefined && { payload }),
    });
  return { app, stores, send };
}

async function createAgent(send: ReturnType<typeof setup>['send']) {
  const res = await send('POST', '/v1/agents', {
    name: 'Operator',
    protocol: 'cord-rest',
    endpoint_url: 'https://agent.example.com/cord/turns',
    credential: SECRET,
  });
  expect(res.statusCode, res.body).toBe(201);
  return agentSchema.parse(res.json());
}

function codeOf(res: { json(): unknown }): string {
  return errorResponseSchema.parse(res.json()).error.code;
}

describe('rate limits', () => {
  it('connection tests have their own tight budget and answer 429 rate_limited', async () => {
    // Saving resolves publicly; each test then fails its lookup, so nothing leaves the machine.
    let lookups = 0;
    const lookup = () => (lookups++ === 0 ? PUBLIC_LOOKUP() : Promise.resolve([]));
    const { send } = setup({
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development', lookup },
        writeRatePerMinute: 100,
        testRatePerMinute: 2,
      },
    });
    const agent = await createAgent(send);
    for (let i = 0; i < 2; i += 1) {
      expect((await send('POST', `/v1/agents/${agent.id}/test`)).statusCode).toBe(200);
    }
    const limited = await send('POST', `/v1/agents/${agent.id}/test`);
    expect(limited.statusCode).toBe(429);
    expect(codeOf(limited)).toBe('rate_limited');
    // Writes are a separate budget.
    expect((await send('PATCH', `/v1/agents/${agent.id}`, { name: 'Still fine' })).statusCode).toBe(
      200,
    );
  });

  it('reads (agents, one agent, voices, history) share a per-client budget', async () => {
    const { send } = setup({
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development', lookup: PUBLIC_LOOKUP },
        writeRatePerMinute: 100,
        readRatePerMinute: 4,
      },
    });
    const agent = await createAgent(send);
    for (const url of ['/v1/agents', `/v1/agents/${agent.id}`, '/v1/voices', '/v1/calls/history']) {
      expect((await send('GET', url)).statusCode, url).toBe(200);
    }
    for (const url of ['/v1/agents', '/v1/voices', '/v1/calls/history']) {
      const res = await send('GET', url);
      expect(res.statusCode, url).toBe(429);
      expect(codeOf(res)).toBe('rate_limited');
    }
  });

  it('call status reads are limited, but a hang-up never is', async () => {
    const calls = registry();
    const { send } = setup({
      calls: { registry: calls, createRatePerMinute: 100, readRatePerMinute: 1 },
    });
    const created = createCallResponseSchema.parse((await send('POST', '/v1/calls', {})).json());
    expect((await send('GET', `/v1/calls/${created.call_id}`)).statusCode).toBe(200);
    const limited = await send('GET', `/v1/calls/${created.call_id}`);
    expect(limited.statusCode).toBe(429);
    expect(codeOf(limited)).toBe('rate_limited');
    expect((await send('POST', `/v1/calls/${created.call_id}/end`)).statusCode).toBe(200);
  });

  it('people behind one address (an office, a carrier) each get their own budget', async () => {
    const calls = registry();
    const { send } = setup({
      userFor: (request) => (request.headers['x-test-user'] as string | undefined) ?? 'user-a',
      agents: {
        stores: createMemoryStores(KEYS),
        policy: { env: 'development', lookup: PUBLIC_LOOKUP },
        writeRatePerMinute: 100,
        readRatePerMinute: 2,
      },
      calls: { registry: calls, createRatePerMinute: 1, readRatePerMinute: 100 },
    });
    const as = (user: string) => ({ 'x-test-user': user });
    // All from 203.0.113.20: user A's budget does not spend user B's.
    expect((await send('GET', '/v1/agents', undefined, as('user-a'))).statusCode).toBe(200);
    expect((await send('GET', '/v1/agents', undefined, as('user-a'))).statusCode).toBe(200);
    expect((await send('GET', '/v1/agents', undefined, as('user-a'))).statusCode).toBe(429);
    expect((await send('GET', '/v1/agents', undefined, as('user-b'))).statusCode).toBe(200);
    expect((await send('POST', '/v1/calls', {}, as('user-a'))).statusCode).toBe(201);
    expect((await send('POST', '/v1/calls', {}, as('user-c'))).statusCode).toBe(201);
  });

  it('data deletion is limited', async () => {
    const { send } = setup({ me: { deleteRatePerMinute: 1 } });
    expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    const limited = await send('DELETE', '/v1/me/data');
    expect(limited.statusCode).toBe(429);
    expect(codeOf(limited)).toBe('rate_limited');
  });

  it('refuses a body over 64 KB before any handler runs', async () => {
    const { send, stores } = setup();
    const res = await send('POST', '/v1/agents', JSON.stringify({ name: 'x'.repeat(70 * 1024) }), {
      'content-type': 'application/json',
    });
    expect(res.statusCode).toBe(413);
    expect(codeOf(res)).toBe('bad_request');
    expect(await stores!.agents.list('dev-user')).toEqual([]);
  });
});

describe('kill switches', () => {
  it('AGENT_TESTS_ENABLED=false answers connection tests with agent_tests_disabled', async () => {
    const stores = createMemoryStores(KEYS);
    const { send } = setup({
      agents: {
        stores,
        policy: { env: 'development', lookup: PUBLIC_LOOKUP },
        writeRatePerMinute: 100,
        testsEnabled: false,
      },
    });
    const agent = await createAgent(send);
    const res = await send('POST', `/v1/agents/${agent.id}/test`);
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('agent_tests_disabled');
    // Everything else keeps working.
    expect((await send('GET', `/v1/agents/${agent.id}`)).statusCode).toBe(200);
  });

  it('VOICE_SAMPLES_ENABLED=false answers previews with voice_samples_disabled', async () => {
    let synthesized = 0;
    const samples = new VoiceSampleCache('unused-dir', () => {
      synthesized += 1;
      return Promise.resolve(new Uint8Array(10));
    });
    const { send } = setup({ voiceSamples: { samples, enabled: false } });
    const res = await send('GET', '/v1/voices/flux-haley-en/sample');
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('voice_samples_disabled');
    expect(synthesized).toBe(0);
  });

  it('the config reads both switches, on by default', () => {
    const defaults = loadGatewayEnv(gatewayEnvFixture());
    expect(defaults.AGENT_TESTS_ENABLED).toBe(true);
    expect(defaults.VOICE_SAMPLES_ENABLED).toBe(true);
    const off = loadGatewayEnv(
      gatewayEnvFixture({ AGENT_TESTS_ENABLED: 'false', VOICE_SAMPLES_ENABLED: '0' }),
    );
    expect(off.AGENT_TESTS_ENABLED).toBe(false);
    expect(off.VOICE_SAMPLES_ENABLED).toBe(false);
  });
});

describe('DELETE /v1/me/data edges', () => {
  it('removes the caller’s feedback but keeps another user’s feedback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-feedback-delete-'));
    try {
      const path = join(dir, 'call-feedback.json');
      const base = {
        agent_id: `agt_${'a'.repeat(20)}`,
        rating: 3,
        issues: ['slow'],
        created_at: new Date().toISOString(),
      };
      await writeFile(
        path,
        JSON.stringify([
          { ...base, call_id: `call_${'a'.repeat(20)}`, user_id: 'dev-user' },
          { ...base, call_id: `call_${'b'.repeat(20)}`, user_id: 'other' },
        ]),
      );
      const { send } = setup({ env: loadGatewayEnv(gatewayEnvFixture({ CORD_DATA_DIR: dir })) });
      expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject([{ user_id: 'other' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('answers 503 when saved agents are not configured', async () => {
    const { send } = setup({}, false);
    const res = await send('DELETE', '/v1/me/data');
    expect(res.statusCode).toBe(503);
    expect(codeOf(res)).toBe('service_unavailable');
  });

  it('is idempotent: a second delete finds nothing and succeeds', async () => {
    const { send } = setup();
    await createAgent(send);
    const first = deleteMyDataResponseSchema.parse((await send('DELETE', '/v1/me/data')).json());
    expect(first.deleted).toEqual({ agents: 1, credentials: 1, call_history: 0, speech_keys: 0 });
    const second = await send('DELETE', '/v1/me/data');
    expect(second.statusCode).toBe(200);
    expect(deleteMyDataResponseSchema.parse(second.json())).toEqual({
      deleted: { agents: 0, credentials: 0, call_history: 0, speech_keys: 0 },
      live_calls_ended: 0,
    });
  });

  it('an agent created while the deletion runs never leaves a credential without its agent', async () => {
    const { send, stores } = setup();
    // The deletion has removed the credentials and is about to remove the agents...
    const gate = opened();
    const deleteAgents = stores!.agents.deleteAllForUser.bind(stores!.agents);
    stores!.agents.deleteAllForUser = async (userId) => {
      await gate.wait;
      return deleteAgents(userId);
    };
    const deleting = send('DELETE', '/v1/me/data');
    await flushMicrotasks();
    // ...when a create lands in full, secret included.
    await createAgent(send);
    gate.open();
    expect((await deleting).statusCode).toBe(200);
    expect(await stores!.agents.list('dev-user')).toEqual([]);
    expect(await sealedRows(stores!)).toBe(0);
  });

  it('a create whose secret lands after the deletion finished leaves no orphaned credential', async () => {
    const { send, stores } = setup();
    // The create has stored its profile and is sealing the secret...
    const gate = opened();
    const put = stores!.credentials.put.bind(stores!.credentials);
    stores!.credentials.put = async (userId, agentId, secret) => {
      await gate.wait;
      return put(userId, agentId, secret);
    };
    const creating = send('POST', '/v1/agents', {
      name: 'Operator',
      protocol: 'cord-rest',
      endpoint_url: 'https://agent.example.com/cord/turns',
      credential: SECRET,
    });
    for (let i = 0; i < 5 && (await stores!.agents.list('dev-user')).length === 0; i += 1) {
      await flushMicrotasks();
    }
    expect(await stores!.agents.list('dev-user')).toHaveLength(1);
    // ...while the whole deletion runs.
    expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    gate.open();
    // The agent it made is already gone: the same 404 an edit racing a delete gets.
    expect((await creating).statusCode).toBe(404);
    expect(await stores!.agents.list('dev-user')).toEqual([]);
    expect(await sealedRows(stores!)).toBe(0);
  });

  it('a connection test finishing after the deletion does not bring the agent back', async () => {
    let release!: () => void;
    const lookups: string[] = [];
    // Saving resolves at once; the test's own lookup waits until the deletion is done.
    const lookup = (host: string) => {
      lookups.push(host);
      if (lookups.length === 1) return PUBLIC_LOOKUP();
      return new Promise<{ address: string; family: 4 }[]>((resolve) => {
        release = () => resolve([]);
      });
    };
    const stores = createMemoryStores(KEYS);
    const { send } = setup({
      agents: {
        stores,
        policy: { env: 'development', lookup },
        writeRatePerMinute: 100,
        testRatePerMinute: 100,
      },
    });
    const agent = await createAgent(send);
    const testing = send('POST', `/v1/agents/${agent.id}/test`);
    for (let i = 0; i < 20 && lookups.length < 2; i += 1) await flushMicrotasks();
    expect(lookups).toHaveLength(2);
    expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    release();
    const tested = await testing;
    expect(tested.statusCode).toBe(404);
    expect(await stores.agents.list('dev-user')).toEqual([]);
    expect(await sealedRows(stores)).toBe(0);
  });

  it('removes the sealed secret from the file on disk, and leaves voice samples alone', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cord-delete-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const samplesDir = join(dataDir, 'voice-samples');
    await mkdir(samplesDir, { recursive: true });
    await writeFile(join(samplesDir, 'flux-haley-en.wav'), 'sample bytes');
    const stores = createFileStores(dataDir, KEYS);
    const { send } = setup({
      agents: {
        stores,
        policy: { env: 'development', lookup: PUBLIC_LOOKUP },
        writeRatePerMinute: 100,
      },
    });
    await createAgent(send);
    const sealedBefore = JSON.parse(await readFile(join(dataDir, 'credentials.json'), 'utf8')) as {
      sealed: unknown;
    }[];
    expect(sealedBefore).toHaveLength(1);
    const ciphertext = JSON.stringify(sealedBefore[0]!.sealed);
    expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    const onDisk = await readFile(join(dataDir, 'credentials.json'), 'utf8');
    expect(JSON.parse(onDisk)).toEqual([]);
    expect(onDisk).not.toContain(ciphertext.slice(1, 40));
    expect(JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8'))).toEqual([]);
    // No temporary copy of the old file is left behind.
    expect((await readdir(dataDir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(join(samplesDir, 'flux-haley-en.wav'), 'utf8')).toBe('sample bytes');
  });
});

describe('rate-limit keys behind a proxy', () => {
  // Signed-in routes limit per person (review finding 6); the address still keys the routes
  // used before sign-in, here the public waitlist (one request a minute per address).
  function appWith(trustProxy: string) {
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture({ TRUST_PROXY: trustProxy })),
      onError: () => undefined,
      waitlist: {
        records: new MemoryCollection(),
        allowedOrigins: [],
        limiter: new FixedWindowLimiter(1, 60_000),
      },
    });
    cleanups.push(() => app.close());
    let n = 0;
    const remove = (remoteAddress: string, forwardedFor?: string) =>
      app
        .inject({
          method: 'POST',
          url: '/v1/waitlist',
          payload: { email: `person${(n += 1)}@example.com` },
          remoteAddress,
          ...(forwardedFor !== undefined && { headers: { 'x-forwarded-for': forwardedFor } }),
        })
        .then((res) => (res.statusCode === 429 ? 429 : 200));
    return { remove };
  }

  it('TRUST_PROXY=false: a forged X-Forwarded-For never buys a fresh budget', async () => {
    const { remove } = appWith('false');
    expect(await remove('203.0.113.9', '198.51.100.1')).toBe(200);
    expect(await remove('203.0.113.9', '198.51.100.2')).toBe(429);
    expect(await remove('203.0.113.9')).toBe(429);
    expect(await remove('203.0.113.10', '203.0.113.9')).toBe(200);
  });

  it('TRUST_PROXY list: the client is the first untrusted hop; a forged leftmost entry is ignored', async () => {
    const { remove } = appWith('127.0.0.1');
    // Through the proxy, which appends the real client address.
    expect(await remove('127.0.0.1', '198.51.100.1')).toBe(200);
    expect(await remove('127.0.0.1', '1.2.3.4, 198.51.100.1')).toBe(429);
    expect(await remove('127.0.0.1', '5.6.7.8, 198.51.100.1')).toBe(429);
    expect(await remove('127.0.0.1', '198.51.100.2')).toBe(200);
    // Straight to the server, not via the proxy: the header is not believed.
    expect(await remove('203.0.113.9', '198.51.100.3')).toBe(200);
    expect(await remove('203.0.113.9', '198.51.100.4')).toBe(429);
  });
});

describe('call ownership edges', () => {
  function asUser() {
    const calls = registry();
    const { send } = setup({
      calls: { registry: calls, createRatePerMinute: 100, readRatePerMinute: 100 },
      userFor: (request) => String(request.headers['x-test-user'] ?? 'dev-user'),
    });
    const as = (user: string, method: 'GET' | 'POST', url: string, body?: object) =>
      send(method, url, body, { 'x-test-user': user });
    return { calls, as };
  }

  it("a guessed call id of another user's call is 404, before and after it ends", async () => {
    const { as } = asUser();
    const created = createCallResponseSchema.parse(
      (await as('alice', 'POST', '/v1/calls', {})).json(),
    );
    const id = created.call_id;
    expect((await as('mallory', 'GET', `/v1/calls/${id}`)).statusCode).toBe(404);
    expect((await as('mallory', 'POST', `/v1/calls/${id}/end`)).statusCode).toBe(404);
    expect((await as('alice', 'GET', `/v1/calls/${id}`)).statusCode).toBe(200);
    const ended = await as('alice', 'POST', `/v1/calls/${id}/end`);
    expect(ended.statusCode).toBe(200);
    // endFor on an already-ended call is an idempotent success for its owner only.
    const again = await as('alice', 'POST', `/v1/calls/${id}/end`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(ended.json());
    expect((await as('mallory', 'POST', `/v1/calls/${id}/end`)).statusCode).toBe(404);
    expect((await as('mallory', 'GET', `/v1/calls/${id}`)).statusCode).toBe(404);
  });

  it('the 404 for a stranger is byte-for-byte the 404 for an unknown id', async () => {
    const { as } = asUser();
    const created = createCallResponseSchema.parse(
      (await as('alice', 'POST', '/v1/calls', {})).json(),
    );
    const theirs = await as('mallory', 'GET', `/v1/calls/${created.call_id}`);
    const unknown = await as('mallory', 'GET', `/v1/calls/call_zzzzzzzzzzzzzzzzzzzz`);
    const strip = (body: unknown) => ({
      ...(body as { error: object }).error,
      request_id: undefined,
    });
    expect(strip(theirs.json())).toEqual(strip(unknown.json()));
  });
});

describe('ending a call while it is still being created', () => {
  function gatedRegistry() {
    const env = loadGatewayEnv(gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'off' }));
    const gate = opened();
    let transports = 0;
    const calls = new CallRegistry({
      env,
      liveKitUrl: LIVEKIT.url,
      rooms: {
        deleteRoom: () => Promise.resolve(),
        removeParticipant: () => Promise.resolve(),
        ping: () => Promise.resolve(),
      },
      tokens: {
        caller: async (request) => {
          await gate.wait;
          return mintCallerToken(LIVEKIT, request);
        },
        gateway: (request) => mintGatewayToken(LIVEKIT, request),
      },
      transports: () => {
        transports += 1;
        return new FakeTransport();
      },
      scheduler: new ManualScheduler(),
      logger: recordingLogger(),
    });
    cleanups.push(() => calls.shutdown());
    return { calls, gate, transports: () => transports };
  }

  it('deleting my data while my call mints its tokens leaves no call running', async () => {
    const { calls, gate, transports } = gatedRegistry();
    const creating = calls.create(undefined, 'alice').catch((error: unknown) => error);
    await flushMicrotasks();
    expect(calls.activeCount).toBe(1);
    expect(await calls.endCallsForUser('alice')).toBe(1);
    gate.open();
    expect(await creating).toBeInstanceOf(CallCreateError);
    // The hang-up must win: no runtime starts, and the slot is free again.
    expect(transports()).toBe(0);
    expect(calls.activeCount).toBe(0);
  });

  it('shutdown while a call mints its tokens does not start that call afterwards', async () => {
    const { calls, gate, transports } = gatedRegistry();
    const creating = calls.create(undefined, 'alice').catch((error: unknown) => error);
    await flushMicrotasks();
    const stopping = calls.shutdown();
    gate.open();
    await creating;
    await stopping;
    expect(transports()).toBe(0);
    expect(calls.activeCount).toBe(0);
  });
});

describe('a call racing DELETE /v1/me/data', () => {
  it('a call whose agent was looked up just before the deletion leaves no history after it', async () => {
    const stores = createMemoryStores(KEYS);
    const policy = { env: 'development' as const, lookup: PUBLIC_LOOKUP };
    const calls = new CallRegistry({
      env: loadGatewayEnv(gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'off' })),
      liveKitUrl: LIVEKIT.url,
      rooms: {
        deleteRoom: () => Promise.resolve(),
        removeParticipant: () => Promise.resolve(),
        ping: () => Promise.resolve(),
      },
      tokens: {
        caller: (request) => mintCallerToken(LIVEKIT, request),
        gateway: (request) => mintGatewayToken(LIVEKIT, request),
      },
      transports: () => new FakeTransport(),
      history: stores.history,
      scheduler: new ManualScheduler(),
      logger: recordingLogger(),
    });
    cleanups.push(() => calls.shutdown());
    const { send } = setup({
      agents: { stores, policy, writeRatePerMinute: 100 },
      calls: {
        registry: calls,
        createRatePerMinute: 100,
        resolveAgent: savedAgentResolver(stores, policy),
      },
    });
    const agent = await createAgent(send);
    // POST /v1/calls has read the agent, and is about to create the call...
    const gate = opened();
    const get = stores.agents.get.bind(stores.agents);
    let hold = true;
    stores.agents.get = async (userId, agentId) => {
      const found = await get(userId, agentId);
      if (hold) {
        hold = false;
        await gate.wait;
      }
      return found;
    };
    const calling = send('POST', '/v1/calls', { agent_id: agent.id });
    for (let i = 0; i < 20 && hold; i += 1) await flushMicrotasks();
    expect(hold).toBe(false);
    // ...when the whole deletion runs.
    expect((await send('DELETE', '/v1/me/data')).statusCode).toBe(200);
    gate.open();
    // The agent is gone: the call is refused rather than started after the deletion.
    expect((await calling).statusCode).toBe(404);
    expect(calls.activeCount).toBe(0);
    await calls.shutdown();
    expect(await stores.history.list('dev-user', 50)).toEqual([]);
  });
});

/** A promise the test opens when it chooses. */
function opened() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Sealed credential rows left for the development user, whatever agent they belong to. */
async function sealedRows(stores: Stores): Promise<number> {
  // Counts by removing: each test only needs to know whether any were left behind.
  return stores.credentials.deleteAllForUser('dev-user');
}

describe('production test line', () => {
  it('refuses a call without an agent when the test line is off', async () => {
    const calls = registry();
    const { send } = setup({
      calls: { registry: calls, createRatePerMinute: 100, allowTestLine: false },
    });
    const res = await send('POST', '/v1/calls', {});
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('bad_request');
    expect(calls.activeCount).toBe(0);
  });
});

describe('log redaction under representative requests', () => {
  it('no secret, key, or token value reaches the logs', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const feedbackDir = await mkdtemp(join(tmpdir(), 'cord-log-feedback-'));
    cleanups.push(() => rm(feedbackDir, { recursive: true, force: true }));
    const env = loadGatewayEnv(
      gatewayEnvFixture({ LOG_LEVEL: 'trace', CORD_DATA_DIR: feedbackDir }),
    );
    const agentServer = await startFakeNativeServer({ token: SECRET, mode: 'streamed' });
    cleanups.push(() => agentServer.close());
    const calls = registry();
    const stores = createMemoryStores(KEYS);
    const app = buildApp({
      env,
      logger: { ...createLoggerOptions(env), stream: sink },
      onError: () => undefined,
      calls: { registry: calls, createRatePerMinute: 100 },
      agents: {
        stores,
        policy: { env: 'development' },
        writeRatePerMinute: 100,
        testBudget: { connectTimeoutMs: 2_000, probeTimeoutMs: 2_000 },
      },
      me: { deleteRatePerMinute: 100 },
    });
    cleanups.push(() => app.close());
    const secretHeaders = {
      authorization: 'Bearer header-bearer-value-11aa',
      cookie: 'session=cookie-value-22bb',
      'x-api-key': 'header-api-key-33cc',
    };

    const created = await app.inject({
      method: 'POST',
      url: '/v1/agents?token=query-token-44dd&api_key=query-key-55ee',
      headers: secretHeaders,
      payload: {
        name: 'Logged',
        protocol: 'cord-native',
        endpoint_url: `${agentServer.url}?access_token=endpoint-query-66ff`,
        credential: SECRET,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agent = agentSchema.parse(created.json());
    const tested = await app.inject({
      method: 'POST',
      url: `/v1/agents/${agent.id}/test`,
      headers: secretHeaders,
    });
    expect(tested.statusCode).toBe(200);
    const call = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: secretHeaders,
      payload: {},
    });
    expect(call.statusCode).toBe(201);
    const liveKitToken = createCallResponseSchema.parse(call.json()).livekit.token;
    const note = 'private-call-feedback-note-7e2c';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/calls/${createCallResponseSchema.parse(call.json()).call_id}/feedback`,
          headers: secretHeaders,
          payload: { rating: 2, issues: ['slow'], note },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({ method: 'DELETE', url: '/v1/me/data', headers: secretHeaders });

    // A structured field that slips through is censored too.
    app.log.info({ livekit: { token: liveKitToken }, agent: { credential: SECRET } }, 'probe');
    app.log.info({ url: 'https://agent.example.com/x?token=query-token-44dd' }, 'probe url');

    const output = lines.join('');
    expect(output).toContain('incoming request'); // the capture really ran
    for (const value of [
      SECRET,
      note,
      liveKitToken,
      LIVEKIT.apiSecret,
      'header-bearer-value-11aa',
      'cookie-value-22bb',
      'header-api-key-33cc',
      'query-token-44dd',
      'query-key-55ee',
      'endpoint-query-66ff',
    ]) {
      expect(output, value).not.toContain(value);
    }
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('?[query omitted]');
  });
});

describe('speech listening setting on disk', () => {
  it('survives a restart of the file stores', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cord-listening-'));
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
    const first = createFileStores(dataDir, KEYS);
    await first.speechKeys.put('alice', 'deepgram', 'dg-secret-key-abcd1234', new Date());
    await first.speechKeys.put('alice', 'xai', 'xai-secret-key-abcd1234', new Date());
    await first.speechKeys.setListening('alice', 'xai');
    const second = createFileStores(dataDir, KEYS);
    expect(await second.speechKeys.getListening('alice')).toBe('xai');
    expect(JSON.parse(await readFile(join(dataDir, 'speech-settings.json'), 'utf8'))).toEqual([
      { user_id: 'alice', listening: 'xai' },
    ]);
  });
});
