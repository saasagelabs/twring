import { startFakeRestServer, type FakeRestServer } from '@twring/agent-adapter/fake-rest-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentListResponseSchema,
  agentSchema,
  callHistoryResponseSchema,
  createCallResponseSchema,
  deleteMyDataResponseSchema,
  errorResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { savedAgentResolver } from '../src/agents/routes';
import { buildApp } from '../src/app';
import type { UserResolver } from '../src/auth';
import { CallRegistry } from '../src/calls/registry';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { mintCallerToken, mintGatewayToken } from '../src/livekit/tokens';
import { createMemoryStores } from '../src/store/repositories';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// Milestone 10: object-level authorization (SECURITY §12) with two users, and DELETE /v1/me/data
// ending live calls and leaving nothing behind. The user comes from the resolver, as it will from
// a verified session after sign-in; here a test header stands in for the session.

const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'APIfaketestkey',
  apiSecret: 'fake-secret-value-for-tests-0123456789',
};
const TOKEN = 'security-int-agent-token-5c1f';
const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 4).toString('base64')]]) };
const ALICE = 'user-alice';
const BOB = 'user-bob';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const userFor: UserResolver = (request: FastifyRequest) => {
  const user = request.headers['x-test-user'];
  return typeof user === 'string' ? user : ALICE;
};

function gateway() {
  const env = loadGatewayEnv(gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'echo' }));
  const stores = createMemoryStores(KEYS);
  const policy = { env: 'development' as const };
  const stt = new FakeSttProvider();
  const transports: FakeTransport[] = [];
  const registry = new CallRegistry({
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
    transports: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    voice: { stt, tts: new FakeTtsProvider() },
    history: stores.history,
    scheduler: new ManualScheduler(),
    logger: recordingLogger(),
  });
  const app = buildApp({
    env,
    onError: () => undefined,
    userFor,
    calls: {
      registry,
      createRatePerMinute: 100,
      resolveAgent: savedAgentResolver(stores, policy, userFor),
    },
    agents: { stores, policy, writeRatePerMinute: 100, testRatePerMinute: 100 },
    me: { deleteRatePerMinute: 100 },
  });
  cleanups.push(async () => {
    await registry.shutdown();
    await app.close();
  });
  const as =
    (user: string) =>
    (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers: { 'x-test-user': user }, ...(payload && { payload }) });
  return { alice: as(ALICE), bob: as(BOB), stores, registry, transports };
}

async function restServer(): Promise<FakeRestServer> {
  const server = await startFakeRestServer({ token: TOKEN, mode: 'instant' });
  cleanups.push(() => server.close());
  return server;
}

type Send = ReturnType<typeof gateway>['alice'];

async function saveAgent(send: Send, url: string) {
  const res = await send('POST', '/v1/agents', {
    name: 'Operator',
    protocol: 'cord-rest',
    endpoint_url: url,
    credential: TOKEN,
  });
  expect(res.statusCode, res.body).toBe(201);
  return agentSchema.parse(res.json());
}

async function startCall(send: Send, agentId: string) {
  const res = await send('POST', '/v1/calls', { agent_id: agentId });
  expect(res.statusCode, res.body).toBe(201);
  return createCallResponseSchema.parse(res.json());
}

describe('authorization between users (SECURITY §12)', () => {
  it("user B cannot list, fetch, edit, test, delete, or call user A's agent", async () => {
    const server = await restServer();
    const g = gateway();
    const agent = await saveAgent(g.alice, server.url);

    const list = agentListResponseSchema.parse((await g.bob('GET', '/v1/agents')).json());
    expect(list.agents).toEqual([]);
    for (const [method, url, body] of [
      ['GET', `/v1/agents/${agent.id}`, undefined],
      ['PATCH', `/v1/agents/${agent.id}`, { name: 'Taken' }],
      ['POST', `/v1/agents/${agent.id}/test`, undefined],
      ['DELETE', `/v1/agents/${agent.id}`, undefined],
      ['POST', '/v1/calls', { agent_id: agent.id }],
    ] as const) {
      const res = await g.bob(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('not_found');
    }
    // Nothing changed for A, and B's attempts made no request to A's agent.
    expect(server.received).toEqual([]);
    const mine = agentSchema.parse((await g.alice('GET', `/v1/agents/${agent.id}`)).json());
    expect(mine).toMatchObject({ name: 'Operator', has_credential: true });
    expect(await g.stores.credentials.get(ALICE, agent.id)).toBe(TOKEN);
  });

  it("user B cannot read or end user A's call, and sees none of A's history", async () => {
    const server = await restServer();
    const g = gateway();
    const agent = await saveAgent(g.alice, server.url);
    const { call_id } = await startCall(g.alice, agent.id);

    expect((await g.bob('GET', `/v1/calls/${call_id}`)).statusCode).toBe(404);
    expect((await g.bob('POST', `/v1/calls/${call_id}/end`)).statusCode).toBe(404);
    expect(g.registry.activeCount).toBe(1);
    expect((await g.alice('GET', `/v1/calls/${call_id}`)).statusCode).toBe(200);

    expect((await g.alice('POST', `/v1/calls/${call_id}/end`)).statusCode).toBe(200);
    await vi.waitFor(async () =>
      expect(
        callHistoryResponseSchema.parse((await g.alice('GET', '/v1/calls/history')).json()).calls,
      ).toHaveLength(1),
    );
    expect(
      callHistoryResponseSchema.parse((await g.bob('GET', '/v1/calls/history')).json()).calls,
    ).toEqual([]);
  });

  it('a test-line call belongs to whoever started it', async () => {
    const g = gateway();
    const res = await g.alice('POST', '/v1/calls', {});
    expect(res.statusCode, res.body).toBe(201);
    const { call_id } = createCallResponseSchema.parse(res.json());
    expect((await g.bob('GET', `/v1/calls/${call_id}`)).statusCode).toBe(404);
    expect((await g.alice('GET', `/v1/calls/${call_id}`)).statusCode).toBe(200);
  });
});

describe('DELETE /v1/me/data', () => {
  it("ends the user's live calls and removes their agents, credentials, and history only", async () => {
    const server = await restServer();
    const g = gateway();
    const first = await saveAgent(g.alice, server.url);
    const second = await saveAgent(g.alice, server.url);
    const bobs = await saveAgent(g.bob, server.url);

    // One finished call in history, one still live, and B's live call.
    const done = await startCall(g.alice, first.id);
    expect((await g.alice('POST', `/v1/calls/${done.call_id}/end`)).statusCode).toBe(200);
    const live = await startCall(g.alice, second.id);
    const bobCall = await startCall(g.bob, bobs.id);
    expect(g.registry.activeCount).toBe(2);

    const res = await g.alice('DELETE', '/v1/me/data');
    expect(res.statusCode, res.body).toBe(200);
    const body = deleteMyDataResponseSchema.parse(res.json());
    expect(body).toEqual({
      deleted: { agents: 2, credentials: 2, call_history: 2, speech_keys: 0 },
      live_calls_ended: 1,
    });

    // A's live call ended; B's did not.
    expect(g.registry.get(live.call_id)?.status).toMatch(/^(ended|failed)$/);
    expect(g.registry.get(bobCall.call_id)?.status).not.toMatch(/^(ended|failed)$/);
    // Nothing of A's is left in any store.
    expect(await g.stores.agents.list(ALICE)).toEqual([]);
    expect(await g.stores.credentials.has(ALICE, first.id)).toBe(false);
    expect(await g.stores.credentials.has(ALICE, second.id)).toBe(false);
    expect(await g.stores.history.list(ALICE, 100)).toEqual([]);
    expect(await g.stores.history.usageRollup(ALICE)).toEqual([]);
    // B keeps everything.
    expect(await g.stores.agents.list(BOB)).toHaveLength(1);
    expect(await g.stores.credentials.get(BOB, bobs.id)).toBe(TOKEN);

    // Deleting again is harmless and reports nothing left.
    const again = deleteMyDataResponseSchema.parse((await g.alice('DELETE', '/v1/me/data')).json());
    expect(again).toEqual({
      deleted: { agents: 0, credentials: 0, call_history: 0, speech_keys: 0 },
      live_calls_ended: 0,
    });
  });
});
