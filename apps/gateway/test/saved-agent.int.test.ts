import { startFakeNativeServer } from '@twring/agent-adapter/fake-native-server';
import { startFakeRestServer } from '@twring/agent-adapter/fake-rest-server';
import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentSchema,
  callHistoryResponseSchema,
  createCallResponseSchema,
  type AgentProtocol,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { savedAgentResolver } from '../src/agents/routes';
import { buildApp } from '../src/app';
import { CallRegistry } from '../src/calls/registry';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { mintCallerToken, mintGatewayToken } from '../src/livekit/tokens';
import { createMemoryStores } from '../src/store/repositories';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// POST /v1/calls with agent_id: the saved agent's endpoint and encrypted credential drive a real
// adapter (SSRF guard included) against the reference agents on 127.0.0.1; media and speech are fakes.
const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'APIfaketestkey',
  apiSecret: 'fake-secret-value-for-tests-0123456789',
};
const TOKEN = 'saved-agent-secret-token';
const KEYS = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 5).toString('base64')]]) };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const noRooms = {
  deleteRoom: () => Promise.resolve(),
  removeParticipant: () => Promise.resolve(),
  ping: () => Promise.resolve(),
};

function gateway() {
  const env = loadGatewayEnv(
    // A manual clock: send short turns at once instead of holding them (ADR-017 amendment).
    gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'echo', SHORT_TURN_HOLD_MS: '0' }),
  );
  const stores = createMemoryStores(KEYS);
  const policy = { env: 'development' as const };
  const stt = new FakeSttProvider();
  const voices: string[] = [];
  const keyterms: (readonly string[])[] = [];
  const tts = new FakeTtsProvider();
  const transports: FakeTransport[] = [];
  const logger = recordingLogger();
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
    sttForKeyterms: (terms) => {
      keyterms.push(terms);
      return stt;
    },
    ttsForVoice: (voiceId) => {
      voices.push(voiceId);
      return tts;
    },
    history: stores.history,
    scheduler: new ManualScheduler(),
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
  const send = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    app.inject({ method, url, ...(payload && { payload }) });
  return { send, stt, tts, voices, keyterms, transports, logger, stores };
}

async function startServer(protocol: AgentProtocol): Promise<string> {
  const server =
    protocol === 'cord-native'
      ? await startFakeNativeServer({ token: TOKEN, mode: 'instant' })
      : await startFakeRestServer({ token: TOKEN, mode: 'instant' });
  cleanups.push(() => server.close());
  return server.url;
}

describe.each(['cord-native', 'cord-rest'] as const)('a call to a saved %s agent', (protocol) => {
  it('talks to that agent in its voice and records a summary when it ends', async () => {
    const url = await startServer(protocol);
    const { send, stt, tts, voices, keyterms, transports, logger } = gateway();
    const agent = agentSchema.parse(
      (
        await send('POST', '/v1/agents', {
          name: 'Operator',
          protocol,
          endpoint_url: url,
          voice_id: 'flux-kit-en',
          keyterms: ['Chennai', ' Priya '],
          credential: TOKEN,
        })
      ).json(),
    );

    const res = await send('POST', '/v1/calls', { agent_id: agent.id });
    expect(res.statusCode, res.body).toBe(201);
    const { call_id } = createCallResponseSchema.parse(res.json());
    expect(voices).toEqual(['flux-kit-en']);
    expect(keyterms).toEqual([['Chennai', 'Priya']]);

    const transport = transports[0]!;
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    transport.emit({ type: 'caller_joined' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true);

    await send('POST', `/v1/calls/${call_id}/end`);
    await vi.waitFor(async () => {
      const history = callHistoryResponseSchema.parse(
        (await send('GET', '/v1/calls/history')).json(),
      );
      expect(history.calls).toEqual([
        expect.objectContaining({
          call_id,
          agent_id: agent.id,
          agent_name: 'Operator',
          outcome: 'completed',
          end_reason: 'hangup',
        }),
      ]);
    });
    expect(JSON.stringify(logger.events)).not.toContain(TOKEN);
  });

  it('an edit to the words mid-call keeps the call going on the words it started with (m9 verifier)', async () => {
    const url = await startServer(protocol);
    const { send, stt, tts, keyterms, transports } = gateway();
    const agent = agentSchema.parse(
      (
        await send('POST', '/v1/agents', {
          name: 'Operator',
          protocol,
          endpoint_url: url,
          keyterms: ['Chennai'],
          credential: TOKEN,
        })
      ).json(),
    );
    const res = await send('POST', '/v1/calls', { agent_id: agent.id });
    expect(res.statusCode, res.body).toBe(201);
    const transport = transports[0]!;
    await vi.waitFor(() => expect(transport.states).toEqual(['ready']));
    transport.emit({ type: 'caller_joined' });

    const edit = await send('PATCH', `/v1/agents/${agent.id}`, { keyterms: ['Madurai'] });
    expect(edit.statusCode, edit.body).toBe(200);

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(transport.endReasons).toEqual([]);
    // The STT session was opened once, with the words the call started with.
    expect(keyterms).toEqual([['Chennai']]);
    // The next call (after this one ends: one call at a time) picks up the edit.
    const callId = createCallResponseSchema.parse(res.json()).call_id;
    await send('POST', `/v1/calls/${callId}/end`);
    expect((await send('POST', '/v1/calls', { agent_id: agent.id })).statusCode).toBe(201);
    expect(keyterms).toEqual([['Chennai'], ['Madurai']]);
  });

  it('a wrong saved credential ends the call as agent_unavailable and records a failure', async () => {
    const url = await startServer(protocol);
    const { send, stt, transports } = gateway();
    const agent = agentSchema.parse(
      (
        await send('POST', '/v1/agents', {
          name: 'Operator',
          protocol,
          endpoint_url: url,
          credential: 'not-the-right-token',
        })
      ).json(),
    );
    const res = await send('POST', '/v1/calls', { agent_id: agent.id });
    expect(res.statusCode).toBe(201);
    const transport = transports[0]!;
    await vi.waitFor(() => expect(transport.states.length).toBeGreaterThan(0));
    transport.emit({ type: 'caller_joined' });
    // REST touches the agent on the first turn; native already failed at connect.
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(transport.endReasons).toEqual(['agent_unavailable']));
    await vi.waitFor(async () => {
      const history = callHistoryResponseSchema.parse(
        (await send('GET', '/v1/calls/history')).json(),
      );
      expect(history.calls[0]).toMatchObject({
        outcome: 'failed',
        end_reason: 'agent_unavailable',
      });
    });
  });
});

describe('a call to a saved OpenAI-compatible agent', () => {
  it('streams the saved agent reply to speech with its stable user key', async () => {
    let user = '';
    const server = createServer((req, res) => {
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          user: string;
          messages: { content: string }[];
        };
        user = body.user;
        expect(body.messages[1]?.content).toBe('hello there');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"Hello there."}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No server address');
    const { send, stt, tts, transports } = gateway();
    const agent = agentSchema.parse(
      (
        await send('POST', '/v1/agents', {
          name: 'OpenClaw',
          protocol: 'openai-chat',
          endpoint_url: `http://127.0.0.1:${address.port}/v1`,
          credential: TOKEN,
        })
      ).json(),
    );
    const result = await send('POST', '/v1/calls', { agent_id: agent.id });
    expect(result.statusCode, result.body).toBe(201);
    await vi.waitFor(() => expect(transports[0]?.states).toEqual(['ready']));
    transports[0]!.emit({ type: 'caller_joined' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(user).toMatch(/^twring-[0-9a-f]+$/);
    await send('POST', `/v1/calls/${createCallResponseSchema.parse(result.json()).call_id}/end`);
  });
});

describe('POST /v1/calls agent_id', () => {
  it('answers 404 for an unknown agent and 400 for a malformed id', async () => {
    const { send, transports } = gateway();
    const unknown = await send('POST', '/v1/calls', { agent_id: 'agt_zzzzzzzzzzzzzzzzzzzz' });
    expect(unknown.statusCode).toBe(404);
    const malformed = await send('POST', '/v1/calls', { agent_id: '../x' });
    expect(malformed.statusCode).toBe(400);
    expect(transports).toEqual([]);
  });

  it('without agent_id keeps the configured development mode', async () => {
    const { send, voices, keyterms, transports } = gateway();
    const res = await send('POST', '/v1/calls', {});
    expect(res.statusCode).toBe(201);
    expect(voices).toEqual([]);
    expect(keyterms).toEqual([]);
    await vi.waitFor(() => expect(transports[0]?.states).toEqual(['ready']));
  });
});
import { createServer } from 'node:http';
