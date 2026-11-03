import { Writable } from 'node:stream';

import {
  startFakeNativeServer,
  type FakeNativeServer,
} from '@twring/agent-adapter/fake-native-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import { agentSchema, connectionTestResponseSchema, errorResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createLoggerOptions } from '../logger';
import { createMemoryStores, type AgentRepository, type Stores } from '../store/repositories';

import { DEV_USER_ID } from './routes';
import type { EndpointPolicy } from './service';

// Verifier edge cases for /v1/agents: SSRF at every use, credential confidentiality (responses,
// errors, logs), strict bodies, per-user scoping, the shared write limiter, and test/edit races.

const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]) };
const SECRET = 'sk-edge-secret-never-echoed-4f1c';
const PUBLIC_URL = 'https://agent.example.com/cord/turns';
const PUBLIC_IP = '93.184.215.14';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Lookup = NonNullable<EndpointPolicy['lookup']>;
const publicLookup: Lookup = () => Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);

interface SetupOptions {
  stores?: Stores | undefined;
  writeRate?: number;
  env?: EndpointPolicy['env'];
  lookup?: Lookup;
  budget?: { connectTimeoutMs: number; probeTimeoutMs: number };
  onError?: (error: Error) => void;
}

function setup(options: SetupOptions = {}) {
  const stores = 'stores' in options ? options.stores : createMemoryStores(KEYS);
  const logLines: string[] = [];
  const env = loadGatewayEnv(gatewayEnvFixture());
  const app = buildApp({
    env,
    logger: {
      ...createLoggerOptions(env),
      level: 'trace',
      stream: new Writable({
        write(chunk: Buffer, _enc, done) {
          logLines.push(chunk.toString());
          done();
        },
      }),
    },
    onError: options.onError ?? (() => undefined),
    agents: {
      stores,
      policy: { env: options.env ?? 'development', lookup: options.lookup ?? publicLookup },
      userFor: (request) => {
        const header = request.headers['x-test-user'];
        return typeof header === 'string' ? header : DEV_USER_ID;
      },
      writeRatePerMinute: options.writeRate ?? 100,
      testBudget: options.budget ?? { connectTimeoutMs: 2_000, probeTimeoutMs: 2_000 },
    },
  });
  cleanups.push(() => app.close());
  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    extra: { user?: string; ip?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: extra.ip ?? '203.0.113.9',
      headers: {
        ...(extra.user !== undefined && { 'x-test-user': extra.user }),
        ...extra.headers,
      },
      ...(payload !== undefined && { payload: payload as object }),
    });
  return { app, stores: stores!, send, logLines };
}

async function create(
  send: ReturnType<typeof setup>['send'],
  body: Record<string, unknown> = {},
  user?: string,
) {
  const res = await send(
    'POST',
    '/v1/agents',
    {
      name: 'Operator',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      credential: SECRET,
      ...body,
    },
    user === undefined ? {} : { user },
  );
  expect(res.statusCode, res.body).toBe(201);
  return agentSchema.parse(res.json());
}

async function nativeServer(token = SECRET): Promise<FakeNativeServer> {
  const server = await startFakeNativeServer({ token, mode: 'streamed' });
  cleanups.push(() => server.close());
  return server;
}

describe('SSRF and scheme policy', () => {
  it('outside development, plain http:// and ws:// are rejected on create and on edit', async () => {
    const { send, stores } = setup({ env: 'production' });
    for (const [protocol, endpoint_url] of [
      ['cord-rest', 'http://agent.example.com/cord'],
      ['cord-native', 'ws://agent.example.com/cord'],
    ] as const) {
      const res = await send('POST', '/v1/agents', { name: 'A', protocol, endpoint_url });
      expect(res.json(), endpoint_url).toMatchObject({ error: { code: 'endpoint_rejected' } });
    }
    expect(await stores.agents.list(DEV_USER_ID)).toEqual([]);

    const agent = await create(send);
    const edit = await send('PATCH', `/v1/agents/${agent.id}`, {
      protocol: 'cord-native',
      endpoint_url: 'ws://agent.example.com/cord',
    });
    expect(edit.json()).toMatchObject({ error: { code: 'endpoint_rejected' } });
    expect((await stores.agents.get(DEV_USER_ID, agent.id))?.endpoint_url).toBe(PUBLIC_URL);
  });

  it('outside development, loopback literals are rejected (no localhost allow-list)', async () => {
    const { send } = setup({
      env: 'staging',
      lookup: (host) =>
        Promise.resolve([{ address: host === 'localhost' ? '127.0.0.1' : PUBLIC_IP, family: 4 }]),
    });
    for (const endpoint_url of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x']) {
      const res = await send('POST', '/v1/agents', {
        name: 'A',
        protocol: 'cord-rest',
        endpoint_url,
      });
      expect(res.statusCode, endpoint_url).toBe(400);
    }
  });

  it('re-resolves at test time: a host that rebinds to a private address after saving is refused', async () => {
    let lookups = 0;
    const rebinding: Lookup = () => {
      lookups += 1;
      return Promise.resolve([{ address: lookups === 1 ? PUBLIC_IP : '10.0.0.8', family: 4 }]);
    };
    const { send } = setup({ lookup: rebinding });
    const agent = await create(send, { endpoint_url: 'https://rebind.example/cord' });
    const res = await send('POST', `/v1/agents/${agent.id}/test`);
    const body = connectionTestResponseSchema.parse(res.json());
    expect(lookups).toBe(2);
    expect(body.result.ok).toBe(false);
    expect(body.result.checks).toEqual([{ name: 'endpoint', status: 'failed' }]);
    expect(body.result.message).toMatch(/not allowed/);
    expect(body.agent.status).toBe('failing');
  });

  it('a connection test finishes within its budget even when DNS never answers', async () => {
    let lookups = 0;
    let release: (() => void) | undefined;
    const stalling: Lookup = () => {
      lookups += 1;
      if (lookups === 1) return Promise.resolve([{ address: PUBLIC_IP, family: 4 }]);
      return new Promise((_, reject) => {
        release = () => reject(new Error('released by test cleanup'));
      });
    };
    cleanups.push(() => release?.());
    const { send } = setup({
      lookup: stalling,
      budget: { connectTimeoutMs: 200, probeTimeoutMs: 200 },
    });
    const agent = await create(send, { endpoint_url: 'https://slow-dns.example/cord' });
    const outcome = await Promise.race([
      send('POST', `/v1/agents/${agent.id}/test`).then((r) => r.statusCode),
      new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 2_000)),
    ]);
    expect(outcome).toBe(200);
  });
});

describe('credential confidentiality', () => {
  it('never appears in any response, error body, or log line across the whole lifecycle', async () => {
    const server = await nativeServer();
    const { send, logLines } = setup();
    const agent = await create(send, { protocol: 'cord-native', endpoint_url: server.url });
    const responses = [
      await send('GET', '/v1/agents'),
      await send('GET', `/v1/agents/${agent.id}`),
      await send('PATCH', `/v1/agents/${agent.id}`, { credential: SECRET }),
      await send('POST', `/v1/agents/${agent.id}/test`),
      // Invalid bodies that carry the secret must not reflect it.
      await send('POST', '/v1/agents', { name: '', protocol: 'cord-rest', credential: SECRET }),
      await send('PATCH', `/v1/agents/${agent.id}`, { credential: SECRET, surprise: SECRET }),
      await send('POST', '/v1/agents', `{"credential":"${SECRET}"`, {
        headers: { 'content-type': 'application/json' },
      }),
      await send('POST', `/v1/agents?credential=${SECRET}`, { credential: SECRET }),
      await send('DELETE', `/v1/agents/${agent.id}`),
    ];
    for (const res of responses) expect(res.body).not.toContain(SECRET);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join('\n')).not.toContain(SECRET);
  });

  it('a store failure whose error text contains the secret is not leaked to the client, log, or onError', async () => {
    const stores = createMemoryStores(KEYS);
    const reported: string[] = [];
    const leaky: Stores = {
      ...stores,
      credentials: {
        ...stores.credentials,
        put: (_u, _a, secret) => Promise.reject(new Error(`disk full while writing ${secret}`)),
      },
    };
    const { send, logLines } = setup({
      stores: leaky,
      onError: (error) => reported.push(`${error.message}\n${error.stack ?? ''}`),
    });
    const res = await send('POST', '/v1/agents', {
      name: 'A',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      credential: SECRET,
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(logLines.join('\n')).not.toContain(SECRET);
    expect(reported.join('\n')).not.toContain(SECRET);
    expect(await stores.agents.list(DEV_USER_ID)).toEqual([]);
  });
});

describe('strict bodies and status codes', () => {
  it.each([
    ['server-owned status', { status: 'ready' }],
    ['server-owned has_credential', { has_credential: true }],
    ['server-owned id', { id: 'agt_zzzzzzzzzzzzzzzzzzzz' }],
    ['oversized credential', { credential: 'x'.repeat(4097) }],
    ['oversized url', { endpoint_url: `https://agent.example.com/${'a'.repeat(2048)}` }],
    ['whitespace name', { name: '   ' }],
  ])('POST rejects %s', async (_label, override) => {
    const { send, stores } = setup();
    const res = await send('POST', '/v1/agents', {
      name: 'A',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      ...override,
    });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('bad_request');
    expect(await stores.agents.list(DEV_USER_ID)).toEqual([]);
  });

  it('non-object, wrong-type, and oversized bodies are 4xx with the standard error shape', async () => {
    const { send } = setup();
    const agent = await create(send);
    for (const payload of [[], 'null', '42']) {
      const res = await send('POST', '/v1/agents', payload, {
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode, String(payload)).toBe(400);
    }
    // Fastify parses text/plain to a string by default, which the schema then rejects.
    const text = await send('POST', '/v1/agents', 'name=A', {
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
    const form = await send('POST', '/v1/agents', 'name=A', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.statusCode).toBe(415);
    const huge = await send('PATCH', `/v1/agents/${agent.id}`, { name: 'x'.repeat(70 * 1024) });
    expect(huge.statusCode).toBe(413);
    for (const res of [text, form, huge]) errorResponseSchema.parse(res.json());
    const statusEdit = await send('PATCH', `/v1/agents/${agent.id}`, { status: 'ready' });
    expect(statusEdit.statusCode).toBe(400);
  });

  it('a rename keeps the status and last test; a credential change resets both', async () => {
    const server = await nativeServer();
    const { send } = setup();
    const agent = await create(send, { protocol: 'cord-native', endpoint_url: server.url });
    await send('POST', `/v1/agents/${agent.id}/test`);
    const renamed = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { name: '  Butler  ' })).json(),
    );
    expect(renamed).toMatchObject({ name: 'Butler', status: 'ready' });
    expect(renamed.last_test?.ok).toBe(true);
    const rekeyed = agentSchema.parse(
      (await send('PATCH', `/v1/agents/${agent.id}`, { credential: `${SECRET}-2` })).json(),
    );
    expect(rekeyed.status).toBe('untested');
    expect(rekeyed.last_test).toBeUndefined();
  });

  it('503 on every saved-agent route when the store is not configured', async () => {
    const { send } = setup({ stores: undefined });
    const id = 'agt_aaaaaaaaaaaaaaaaaaaa';
    for (const [method, url] of [
      ['GET', '/v1/agents'],
      ['POST', '/v1/agents'],
      ['GET', `/v1/agents/${id}`],
      ['PATCH', `/v1/agents/${id}`],
      ['DELETE', `/v1/agents/${id}`],
      ['POST', `/v1/agents/${id}/test`],
      ['GET', '/v1/calls/history'],
    ] as const) {
      const res = await send(method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
      expect(res.statusCode, `${method} ${url}`).toBe(503);
    }
  });
});

describe('per-user scoping', () => {
  it('another user can neither see, edit, test, nor delete an agent, and cannot touch its credential', async () => {
    const { send, stores } = setup();
    const mine = await create(send);
    const intruder = { user: 'intruder' };
    expect((await send('GET', `/v1/agents/${mine.id}`, undefined, intruder)).statusCode).toBe(404);
    expect((await send('GET', '/v1/agents', undefined, intruder)).json()).toEqual({ agents: [] });
    expect(
      (await send('PATCH', `/v1/agents/${mine.id}`, { credential: null }, intruder)).statusCode,
    ).toBe(404);
    expect((await send('POST', `/v1/agents/${mine.id}/test`, undefined, intruder)).statusCode).toBe(
      404,
    );
    expect((await send('DELETE', `/v1/agents/${mine.id}`, undefined, intruder)).statusCode).toBe(
      404,
    );
    expect(await stores.credentials.get(DEV_USER_ID, mine.id)).toBe(SECRET);
    expect((await send('GET', `/v1/agents/${mine.id}`)).json()).toMatchObject({
      has_credential: true,
    });
  });
});

describe('shared write limiter', () => {
  it('creates, edits, and deletes share one per-person budget; tests, reads and other people do not', async () => {
    const { send } = setup({ writeRate: 3 });
    const agent = await create(send); // 1
    expect((await send('PATCH', `/v1/agents/${agent.id}`, { name: 'B' })).statusCode).toBe(200); // 2
    // Connection tests have their own, tighter budget (Milestone 10).
    expect((await send('POST', `/v1/agents/${agent.id}/test`)).statusCode).toBe(200);
    expect((await send('PATCH', `/v1/agents/${agent.id}`, { name: 'C' })).statusCode).toBe(200); // 3
    const limited = await send('DELETE', `/v1/agents/${agent.id}`);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect((await send('GET', `/v1/agents/${agent.id}`)).statusCode).toBe(200);
    // The budget follows the person (review finding 9), not their address.
    expect(
      (await send('DELETE', `/v1/agents/${agent.id}`, undefined, { ip: '198.51.100.7' }))
        .statusCode,
    ).toBe(429);
    // Someone else still writes: not limited (404, it isn't theirs).
    expect(
      (await send('DELETE', `/v1/agents/${agent.id}`, undefined, { user: 'someone-else' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('connection test races', () => {
  it('an edit that lands between the test finishing and its verdict being saved is not overwritten', async () => {
    const stores = createMemoryStores(KEYS);
    let gets = 0;
    const agents: AgentRepository = {
      list: (u) => stores.agents.list(u),
      consumeFreshSession: (u, a) => stores.agents.consumeFreshSession(u, a),
      requestFreshSession: (u, a) => stores.agents.requestFreshSession(u, a),
      ensureSessionKey: (u, a, replace) => stores.agents.ensureSessionKey(u, a, replace),
      create: (r) => stores.agents.create(r),
      update: (u, a, p, n) => stores.agents.update(u, a, p, n),
      delete: (u, a) => stores.agents.delete(u, a),
      deleteAllForUser: (u) => stores.agents.deleteAllForUser(u),
      get: async (userId, agentId) => {
        gets += 1;
        const current = await stores.agents.get(userId, agentId);
        // The test route's second read is its "edited meanwhile?" check. A PATCH queued right
        // behind that read commits before the route writes its verdict.
        if (gets === 2) {
          await stores.agents.update(
            userId,
            agentId,
            { endpoint_url: 'https://new-agent.example.com/cord', status: 'untested' },
            new Date(Date.now() + 1_000),
          );
        }
        return current;
      },
    };
    const { send } = setup({
      stores: { ...stores, agents },
      lookup: () => Promise.resolve([{ address: '10.0.0.8', family: 4 }]),
    });
    await stores.agents.create({
      id: 'agt_aaaaaaaaaaaaaaaaaaaa',
      user_id: DEV_USER_ID,
      name: 'Operator',
      protocol: 'cord-rest',
      endpoint_url: PUBLIC_URL,
      voice_id: 'flux-haley-en',
      status: 'untested',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const res = await send('POST', '/v1/agents/agt_aaaaaaaaaaaaaaaaaaaa/test');
    expect(res.statusCode).toBe(200);
    expect(gets).toBe(2);
    const saved = await stores.agents.get(DEV_USER_ID, 'agt_aaaaaaaaaaaaaaaaaaaa');
    expect(saved?.endpoint_url).toBe('https://new-agent.example.com/cord');
    // The verdict belonged to the old endpoint; the edited agent must stay untested.
    expect(saved?.status).toBe('untested');
    expect(saved?.last_test).toBeUndefined();
  });

  it('an agent deleted while its test runs is not resurrected and keeps no credential', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lookups = 0;
    // Public when saved; at test time it waits for the gate, then resolves private (so the test
    // fails fast without touching the network).
    const gated: Lookup = async () => {
      lookups += 1;
      if (lookups === 1) return [{ address: PUBLIC_IP, family: 4 }];
      await gate;
      return [{ address: '10.0.0.8', family: 4 }];
    };
    const { send, stores } = setup({ lookup: gated });
    const agent = await create(send, { endpoint_url: 'https://gated.example/cord' });
    const testing = send('POST', `/v1/agents/${agent.id}/test`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await send('DELETE', `/v1/agents/${agent.id}`)).statusCode).toBe(204);
    release?.();
    await testing;
    expect(await stores.agents.get(DEV_USER_ID, agent.id)).toBeUndefined();
    expect(await stores.credentials.has(DEV_USER_ID, agent.id)).toBe(false);
  });

  it('concurrent tests of one agent both answer and leave one consistent verdict', async () => {
    const server = await nativeServer();
    const { send, stores } = setup();
    const agent = await create(send, { protocol: 'cord-native', endpoint_url: server.url });
    const [a, b] = await Promise.all([
      send('POST', `/v1/agents/${agent.id}/test`),
      send('POST', `/v1/agents/${agent.id}/test`),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const saved = await stores.agents.get(DEV_USER_ID, agent.id);
    expect(saved?.status).toBe('ready');
    expect(saved?.last_test?.ok).toBe(true);
  });
});
