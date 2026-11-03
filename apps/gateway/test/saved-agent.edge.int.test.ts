import { startFakeNativeServer } from '@twring/agent-adapter/fake-native-server';
import { startFakeRestServer, type FakeRestServer } from '@twring/agent-adapter/fake-rest-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentSchema,
  callHistoryResponseSchema,
  createCallResponseSchema,
  type CallHistoryItem,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEV_USER_ID, savedAgentResolver } from '../src/agents/routes';
import type { EndpointPolicy } from '../src/agents/service';
import { buildApp } from '../src/app';
import { CallRegistry } from '../src/calls/registry';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { mintCallerToken, mintGatewayToken } from '../src/livekit/tokens';
import {
  createMemoryStores,
  type CallHistoryRepository,
  type Stores,
} from '../src/store/repositories';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// Verifier edge cases for POST /v1/calls with agent_id: credential lifetime, edits and deletes
// around a live call, SSRF at call time, voice fallback, and history on every end path.

const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'APIfaketestkey',
  apiSecret: 'fake-secret-value-for-tests-0123456789',
};
const TOKEN = 'saved-agent-edge-token-9d2e';
const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 6).toString('base64')]]) };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const noRooms = {
  deleteRoom: () => Promise.resolve(),
  removeParticipant: () => Promise.resolve(),
  ping: () => Promise.resolve(),
};

interface GatewayOptions {
  policy?: EndpointPolicy;
  history?: CallHistoryRepository;
  /** Unset: the configured default. */
  shortTurnHoldMs?: string;
}

function gateway(options: GatewayOptions = {}) {
  const env = loadGatewayEnv(
    // A manual clock: send short turns at once unless a test holds them (ADR-017 amendment).
    gatewayEnvFixture({
      GATEWAY_AUDIO_TEST_MODE: 'echo',
      SHORT_TURN_HOLD_MS: options.shortTurnHoldMs ?? '0',
    }),
  );
  const stores = createMemoryStores(KEYS);
  const policy = options.policy ?? { env: 'development' as const };
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const transports: FakeTransport[] = [];
  const logger = recordingLogger();
  const scheduler = new ManualScheduler();
  const registry = new CallRegistry({
    env,
    liveKitUrl: LIVEKIT.url,
    rooms: noRooms,
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
    ttsForVoice: () => tts,
    history: options.history ?? stores.history,
    scheduler,
    logger,
  });
  const app = buildApp({
    env,
    onError: () => undefined,
    calls: {
      registry,
      createRatePerMinute: 100,
      resolveAgent: savedAgentResolver(stores, policy),
    },
    agents: { stores, policy, writeRatePerMinute: 100 },
  });
  cleanups.push(async () => {
    await registry.shutdown();
    await app.close();
  });
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, ...(payload && { payload }) });
  return { send, stt, tts, transports, logger, stores, registry, scheduler, policy };
}

async function restServer(token = TOKEN): Promise<FakeRestServer> {
  const server = await startFakeRestServer({ token, mode: 'instant' });
  cleanups.push(() => server.close());
  return server;
}

async function saveAgent(send: ReturnType<typeof gateway>['send'], body: Record<string, unknown>) {
  const res = await send('POST', '/v1/agents', { name: 'Operator', credential: TOKEN, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return agentSchema.parse(res.json());
}

async function startCall(g: ReturnType<typeof gateway>, agentId: string) {
  const res = await g.send('POST', '/v1/calls', { agent_id: agentId });
  expect(res.statusCode, res.body).toBe(201);
  const { call_id } = createCallResponseSchema.parse(res.json());
  const transport = g.transports.at(-1)!;
  return { call_id, transport };
}

async function historyOf(send: ReturnType<typeof gateway>['send']): Promise<CallHistoryItem[]> {
  return callHistoryResponseSchema.parse((await send('GET', '/v1/calls/history')).json()).calls;
}

describe('credential lifetime around a live call', () => {
  it('deleting the agent stops its credential being used by the live call (SECURITY §20)', async () => {
    const server = await restServer();
    const g = gateway();
    const agent = await saveAgent(g.send, { protocol: 'cord-rest', endpoint_url: server.url });
    const { transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    transport.emit({ type: 'caller_joined' });
    g.stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first turn' });
    await vi.waitFor(() => expect(server.received).toHaveLength(1));
    await vi.waitFor(() => expect(g.tts.calls.at(-1)).toBe('flush gen_1'));

    expect((await g.send('DELETE', `/v1/agents/${agent.id}`)).statusCode).toBe(204);
    g.stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second turn after delete' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // "Agent credential removal must immediately stop future use": no authenticated request
    // after the delete.
    expect(server.received).toHaveLength(1);
  });

  it('an edit between POST /v1/calls and connect never sends the new credential to the old endpoint', async () => {
    // The old endpoint accepts only the NEW token, so a successful handshake there proves the new
    // credential reached the old address.
    const oldServer = await startFakeNativeServer({ token: 'new-token', mode: 'instant' });
    const newServer = await startFakeNativeServer({ token: 'new-token', mode: 'instant' });
    cleanups.push(
      () => oldServer.close(),
      () => newServer.close(),
    );
    const g = gateway();
    const agent = await saveAgent(g.send, {
      protocol: 'cord-native',
      endpoint_url: oldServer.url,
      credential: 'old-token',
    });
    const resolve = savedAgentResolver(g.stores, g.policy);
    const call = await resolve({} as FastifyRequest, agent.id);
    expect(call).toBeDefined();

    const edit = await g.send('PATCH', `/v1/agents/${agent.id}`, {
      endpoint_url: newServer.url,
      credential: 'new-token',
    });
    expect(edit.statusCode).toBe(200);

    const adapter = await call!.createAgent('call_edge');
    cleanups.push(() => adapter.close().catch(() => undefined));
    await adapter
      .connect({ callId: 'call_edge', sessionId: 'sess_edge' }, AbortSignal.timeout(2_000))
      .catch(() => undefined);
    expect(oldServer.received).toEqual([]);
  });

  it('a host that rebinds to a private address after saving cannot be called', async () => {
    let lookups = 0;
    const policy: EndpointPolicy = {
      env: 'development',
      lookup: () => {
        lookups += 1;
        return Promise.resolve([
          { address: lookups === 1 ? '93.184.215.14' : '169.254.169.254', family: 4 },
        ]);
      },
    };
    const g = gateway({ policy });
    const agent = await saveAgent(g.send, {
      protocol: 'cord-rest',
      endpoint_url: 'https://rebind.example/cord',
    });
    const { transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.endReasons).toEqual(['agent_unavailable']));
    expect(lookups).toBe(2);
    expect(JSON.stringify(g.logger.events)).not.toContain(TOKEN);
    expect(JSON.stringify(g.logger.events)).not.toContain('rebind.example');
  });
});

describe('voice fallback', () => {
  it('a saved voice that is no longer offered falls back to the default voice', async () => {
    const stores: Stores = createMemoryStores(KEYS);
    await stores.agents.create({
      id: 'agt_aaaaaaaaaaaaaaaaaaaa',
      user_id: DEV_USER_ID,
      name: 'Old voice',
      protocol: 'cord-rest',
      endpoint_url: 'https://agent.example.com/cord',
      voice_id: 'flux-retired-en',
      status: 'ready',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const call = await savedAgentResolver(stores, { env: 'development' })(
      {} as FastifyRequest,
      'agt_aaaaaaaaaaaaaaaaaaaa',
    );
    expect(call?.voiceId).toBe('flux-haley-en');
  });
});

describe('call history on every end path', () => {
  it('a failing history write never blocks or fails the hang-up, and is logged without secrets', async () => {
    const server = await restServer();
    const failing: CallHistoryRepository = {
      record: () => Promise.reject(new Error(`disk full; token=${TOKEN}`)),
      list: () => Promise.resolve([]),
      usageRollup: () => Promise.resolve([]),
      deleteAllForUser: () => Promise.resolve(0),
    };
    const g = gateway({ history: failing });
    const agent = await saveAgent(g.send, { protocol: 'cord-rest', endpoint_url: server.url });
    const { call_id, transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    const end = await g.send('POST', `/v1/calls/${call_id}/end`);
    expect(end.statusCode).toBe(200);
    await vi.waitFor(() => expect(g.logger.names()).toContain('call_history_failed'));
    expect(JSON.stringify(g.logger.events)).not.toContain(TOKEN);
  });

  it('records a call whose caller never joined', async () => {
    const server = await restServer();
    const g = gateway();
    const agent = await saveAgent(g.send, { protocol: 'cord-rest', endpoint_url: server.url });
    const { call_id, transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    g.scheduler.advance(31_000);
    await vi.waitFor(async () =>
      expect(await historyOf(g.send)).toEqual([
        expect.objectContaining({
          call_id,
          agent_id: agent.id,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
          usage: expect.objectContaining({ agent_turns: 0, gateway_connected_s: 31 }),
        }),
      ]),
    );
  });

  it('graceful shutdown waits for the history of the calls it ends', async () => {
    const server = await restServer();
    const stores = createMemoryStores(KEYS);
    const slow: CallHistoryRepository = {
      record: async (userId, item) => {
        // A file write that takes a moment (fsync, slow disk).
        await new Promise((resolve) => setTimeout(resolve, 50));
        await stores.history.record(userId, item);
      },
      list: (userId, limit) => stores.history.list(userId, limit),
      usageRollup: (userId, sinceDay) => stores.history.usageRollup(userId, sinceDay),
      deleteAllForUser: (userId) => stores.history.deleteAllForUser(userId),
    };
    const g = gateway({ history: slow });
    const agent = await saveAgent(g.send, { protocol: 'cord-rest', endpoint_url: server.url });
    const { call_id, transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    await g.registry.shutdown();
    // main.ts calls process.exit(0) soon after shutdown() resolves.
    expect(await stores.history.list(DEV_USER_ID, 10)).toEqual([
      expect.objectContaining({ call_id, end_reason: 'shutdown' }),
    ]);
  });
});

describe('short normal turns (ADR-017 amendment)', () => {
  it('the configured hold reaches the call: a two-word turn waits, then goes to the agent', async () => {
    const server = await restServer();
    const g = gateway({ shortTurnHoldMs: '800' });
    const agent = await saveAgent(g.send, { protocol: 'cord-rest', endpoint_url: server.url });
    const { transport } = await startCall(g, agent.id);
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    transport.emit({ type: 'caller_joined' });
    g.stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(g.logger.names()).toContain('short_turn_held'));
    expect(g.tts.calls.some((c) => c.startsWith('speak '))).toBe(false);
    g.scheduler.advance(800);
    await vi.waitFor(() => expect(g.tts.calls.at(-1)).toBe('flush gen_1'));
    expect(g.logger.names()).toContain('short_turn_released');
  });
});
