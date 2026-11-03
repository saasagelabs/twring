import { loadGatewayEnv } from '@twring/config/gateway';
import { FakeAgentAdapter } from '@twring/agent-adapter';
import { type CallHistoryItem, errorResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Writable } from 'node:stream';

import { buildApp } from '../app';
import { createLoggerOptions } from '../logger';
import type { RoomService } from '../livekit/rooms';
import { CARTESIA_VOICES, XAI_VOICES } from '../agents/voices';
import { CredentialDecryptError } from '../store/cipher';
import { StoreCorruptError } from '../store/collection';
import type { SpeechKeyVault } from '../store/speech-keys';
import { createSpeechResolver, type ResolvedSpeech } from '../voice/speech-resolver';
import { FakeSttProvider, FakeTtsProvider } from '../voice/testing';

import type { DailyLimits } from './daily-limits';
import { CallRegistry, type SavedAgentCall } from './registry';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';

const rooms: RoomService = {
  deleteRoom: () => Promise.resolve(),
  removeParticipant: () => Promise.resolve(),
  ping: () => Promise.resolve(),
};

const OWN_DG = 'own-deepgram-secret-key-0001';
const cartesiaId = CARTESIA_VOICES[0]!.id;

function agentFor(userId: string, voiceId = 'flux-aura-en'): SavedAgentCall {
  return {
    userId,
    agentId: `agt_${'a'.repeat(20)}`,
    agentName: 'Agent',
    protocol: 'cord-rest',
    voiceId,
    keyterms: [],
    createAgent: () => Promise.resolve(new FakeAgentAdapter()),
  };
}

function setup(failTokens = false, failSttOpen = false, serverXai = false) {
  const env = loadGatewayEnv(gatewayEnvFixture({}));
  const logger = recordingLogger();
  const transports: FakeTransport[] = [];
  const stts: { speech: ResolvedSpeech | undefined; stt: FakeSttProvider }[] = [];
  const ttss: { speech: ResolvedSpeech | undefined; tts: FakeTtsProvider }[] = [];
  const history: { userId: string; item: CallHistoryItem }[] = [];
  const registry = new CallRegistry({
    env,
    liveKitUrl: 'wss://cord-test.livekit.invalid',
    rooms,
    tokens: {
      caller: () => (failTokens ? Promise.reject(new Error('mint failed')) : Promise.resolve('c')),
      gateway: () => Promise.resolve('g'),
    },
    transports: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    voice: { stt: new FakeSttProvider(), tts: new FakeTtsProvider() },
    sttForKeyterms: (_terms, _name, speech) => {
      const stt = new FakeSttProvider();
      if (failSttOpen) stt.failNextOpen = { code: 'auth_failed', recoverable: false };
      stts.push({ speech, stt });
      return stt;
    },
    ttsForVoice: (_voiceId, speech) => {
      const tts = new FakeTtsProvider();
      ttss.push({ speech, tts });
      return tts;
    },
    history: {
      record: (userId: string, item: CallHistoryItem) => {
        history.push({ userId, item });
        return Promise.resolve();
      },
      list: () => Promise.resolve([]),
    } as never,
    scheduler: new ManualScheduler(),
    logger,
    ...(serverXai && { speaksServerXai: true }),
  });
  return { registry, logger, transports, stts, ttss, history };
}

const own = (apiKey: string): ResolvedSpeech => ({
  deepgram: { apiKey, source: 'own' },
  cartesia: { apiKey: 'twring-ct', source: 'twring' },
});

describe('calls on the person’s own speech keys', () => {
  it('hands each call its own keys, even two at once', async () => {
    const { registry, stts, ttss } = setup();
    const alice = own('alice-deepgram-key-000');
    const bob = own('bob-deepgram-key-00000');
    await Promise.all([
      registry.create(agentFor('alice'), 'alice', { speech: alice }),
      registry.create(agentFor('bob'), 'bob', { speech: bob }),
    ]);
    expect(stts.map((s) => s.speech)).toEqual([alice, bob]);
    expect(ttss.map((t) => t.speech)).toEqual([alice, bob]);
  });

  it('logs which providers hear and speak the call, and whose key, never the key', async () => {
    const { registry, logger } = setup();
    const call = await registry.create(agentFor('alice', cartesiaId), 'alice', {
      speech: own(OWN_DG),
    });
    const logged = logger.events.find((e) => e.fields.event === 'call_speech');
    expect(logged?.fields).toEqual({
      event: 'call_speech',
      call_id: call.call_id,
      listening: 'fake-stt',
      listening_key: 'own',
      voice: 'fake-tts',
      voice_key: 'twring',
    });
    expect(JSON.stringify(logger.events)).not.toContain(OWN_DG);
  });

  it('keeps no key on the call record once it has started or ended', async () => {
    const { registry } = setup();
    const records = () =>
      JSON.stringify([...(registry as unknown as { calls: Map<string, unknown> }).calls.values()]);
    const call = await registry.create(agentFor('alice'), 'alice', { speech: own(OWN_DG) });
    expect(records()).not.toContain(OWN_DG);
    expect(records()).not.toContain('twring-ct');
    await registry.end(call.call_id);
    await flushMicrotasks();
    expect(records()).not.toContain(OWN_DG);
  });

  it('keeps no key on a call whose tokens could not be minted', async () => {
    const { registry } = setup(true);
    await expect(
      registry.create(agentFor('alice'), 'alice', { speech: own(OWN_DG) }),
    ).rejects.toThrow();
    const records = JSON.stringify([
      ...(registry as unknown as { calls: Map<string, unknown> }).calls.values(),
    ]);
    expect(records).toContain('alice');
    expect(records).not.toContain(OWN_DG);
  });

  it('records which keys a call used, never the keys', async () => {
    const { registry, history } = setup();
    const call = await registry.create(agentFor('alice'), 'alice', { speech: own(OWN_DG) });
    await registry.end(call.call_id);
    await flushMicrotasks();
    expect(history).toHaveLength(1);
    expect(history[0]!.item.speech_source).toEqual({ deepgram: 'own', cartesia: 'twring' });
    expect(JSON.stringify(history)).not.toContain(OWN_DG);
  });

  it('ends with deepgram_key_refused when the own Deepgram key is refused, logging no key', async () => {
    const { registry, transports, stts, logger, history } = setup();
    await registry.create(agentFor('alice'), 'alice', { speech: own(OWN_DG) });
    await vi.waitFor(() => expect(stts[0]!.stt.opens).toBe(1));
    transports[0]!.emit({ type: 'caller_joined' });
    stts[0]!.stt.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('deepgram_key_refused');
    expect(transports[0]!.endReasons).toContain('deepgram_key_refused');
    expect(JSON.stringify(logger.events)).not.toContain(OWN_DG);
  });

  it('an own Cartesia key on a Cartesia voice ends with cartesia_key_refused', async () => {
    const { registry, ttss, history, transports } = setup();
    const speech: ResolvedSpeech = {
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      cartesia: { apiKey: 'own-cartesia-key-000', source: 'own' },
    };
    await registry.create(agentFor('alice', cartesiaId), 'alice', { speech });
    await vi.waitFor(() => expect(ttss[0]!.tts.opens).toBe(1));
    transports[0]!.emit({ type: 'caller_joined' });
    ttss[0]!.tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('cartesia_key_refused');
  });
});

describe('calls on the person’s own xAI key', () => {
  const OWN_XAI = 'own-xai-secret-key-0001';
  const grokId = XAI_VOICES[0]!.id;
  const xaiSpeech = (listening: 'deepgram' | 'xai'): ResolvedSpeech => ({
    deepgram: { apiKey: 'twring-dg', source: 'twring' },
    xai: { apiKey: OWN_XAI, source: 'own' },
    listening,
  });

  it('ends with xai_key_refused when own xAI listening is refused on open, logging no key', async () => {
    const { registry, stts, history, transports, logger } = setup(false, true);
    await registry.create(agentFor('alice'), 'alice', { speech: xaiSpeech('xai') });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(stts[0]!.speech?.listening).toBe('xai');
    expect(history[0]!.item.end_reason).toBe('xai_key_refused');
    expect(transports[0]!.endReasons).toContain('xai_key_refused');
    expect(history[0]!.item.speech_source).toEqual({ deepgram: 'twring', xai: 'own' });
    expect(JSON.stringify(logger.events)).not.toContain(OWN_XAI);
    expect(JSON.stringify(history)).not.toContain(OWN_XAI);
  });

  it('ends with xai_key_refused when a Grok voice is refused mid-call', async () => {
    const { registry, ttss, history, transports } = setup();
    await registry.create(agentFor('alice', grokId), 'alice', { speech: xaiSpeech('deepgram') });
    await vi.waitFor(() => expect(ttss[0]!.tts.opens).toBe(1));
    transports[0]!.emit({ type: 'caller_joined' });
    ttss[0]!.tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('xai_key_refused');
  });

  it('a refused Deepgram STT on Twring listening is not blamed on the xAI key', async () => {
    const { registry, history, stts, transports } = setup(false, true);
    await registry.create(agentFor('alice', grokId), 'alice', { speech: xaiSpeech('deepgram') });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('voice_unavailable');
  });

  it('keeps two people on their own listening providers', async () => {
    const { registry, stts } = setup();
    await registry.create(agentFor('alice'), 'alice', { speech: xaiSpeech('xai') });
    await registry.create(agentFor('bob'), 'bob', { speech: own(OWN_DG) });
    await vi.waitFor(() => expect(stts).toHaveLength(2));
    expect(stts[0]!.speech?.listening).toBe('xai');
    expect(stts[0]!.speech?.xai?.apiKey).toBe(OWN_XAI);
    expect(stts[1]!.speech?.xai).toBeUndefined();
    expect(stts[1]!.speech?.deepgram?.apiKey).toBe(OWN_DG);
  });
});

describe('calls on a self-hosted server’s own xAI key', () => {
  const OWN_XAI = 'own-xai-secret-key-0002';
  // An own Deepgram key the call does not use: xAI listening and a Grok voice on the server key.
  const ownDeepgram: ResolvedSpeech = {
    deepgram: { apiKey: OWN_DG, source: 'own' },
    xai: { apiKey: 'server-xai-key', source: 'twring' },
    listening: 'xai',
  };

  it('a refused server key on open is not blamed on the person’s Deepgram key', async () => {
    const { registry, history, stts, transports } = setup(false, true, true);
    await registry.create(agentFor('alice', 'xai-rex-en'), 'alice', { speech: ownDeepgram });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('voice_unavailable');
  });

  it('a refused server voice mid-call is not blamed on the person’s Deepgram key', async () => {
    const { registry, ttss, history, transports } = setup(false, false, true);
    await registry.create(agentFor('alice', 'xai-rex-en'), 'alice', { speech: ownDeepgram });
    await vi.waitFor(() => expect(ttss[0]!.tts.opens).toBe(1));
    transports[0]!.emit({ type: 'caller_joined' });
    ttss[0]!.tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('voice_failed');
  });

  it('own xAI listening refused still ends as the person’s xAI key', async () => {
    const { registry, history, stts, transports } = setup(false, true, true);
    await registry.create(agentFor('alice', 'flux-haley-en'), 'alice', {
      speech: { xai: { apiKey: OWN_XAI, source: 'own' }, listening: 'xai' },
    });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('xai_key_refused');
  });

  it('an own xAI key with Deepgram listening: a refused listener is the server’s', async () => {
    const { registry, history, stts, transports } = setup(false, true, true);
    await registry.create(agentFor('alice', 'flux-haley-en'), 'alice', {
      speech: { xai: { apiKey: OWN_XAI, source: 'own' }, listening: 'deepgram' },
    });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('voice_unavailable');
  });
});

describe('calls on a self-hosted server’s own xAI key with the person’s own keys', () => {
  const ownDeepgram: ResolvedSpeech = {
    deepgram: { apiKey: OWN_DG, source: 'own' },
    xai: { apiKey: 'server-xai-key', source: 'twring' },
    listening: 'deepgram',
  };

  it('an own Deepgram listener refused ends as deepgram_key_refused', async () => {
    const { registry, history, stts, transports } = setup(false, true, true);
    await registry.create(agentFor('alice', 'xai-rex-en'), 'alice', { speech: ownDeepgram });
    await vi.waitFor(() => expect(stts).toHaveLength(1));
    transports[0]!.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('deepgram_key_refused');
  });

  it('an own Cartesia voice refused mid-call ends as cartesia_key_refused', async () => {
    const { registry, ttss, history, transports } = setup(false, false, true);
    await registry.create(agentFor('alice', cartesiaId), 'alice', {
      speech: {
        cartesia: { apiKey: 'own-ct', source: 'own' },
        xai: { apiKey: 'server-xai-key', source: 'twring' },
        listening: 'xai',
      },
    });
    await vi.waitFor(() => expect(ttss[0]!.tts.opens).toBe(1));
    transports[0]!.emit({ type: 'caller_joined' });
    ttss[0]!.tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await vi.waitFor(() => expect(history).toHaveLength(1));
    expect(history[0]!.item.end_reason).toBe('cartesia_key_refused');
  });
});

describe('POST /v1/calls with an unreadable saved key', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function postWith(get: SpeechKeyVault['get']) {
    const env = loadGatewayEnv(gatewayEnvFixture({ LOG_LEVEL: 'info' }));
    const { registry } = setup();
    const create = vi.spyOn(registry, 'create');
    const admit = vi.fn();
    const vault: SpeechKeyVault = {
      put: () => Promise.resolve(),
      get,
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      deleteAllForUser: () => Promise.resolve(0),
      getListening: () => Promise.resolve('deepgram'),
      setListening: () => Promise.resolve(),
    };
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const onError = vi.fn();
    const app = buildApp({
      env,
      logger: { ...createLoggerOptions(env), stream: sink },
      onError,
      userFor: () => 'alice',
      calls: {
        registry,
        createRatePerMinute: 100,
        dailyLimits: { admit, refund: vi.fn() } as unknown as DailyLimits,
        resolveAgent: () => Promise.resolve(agentFor('alice')),
        speech: createSpeechResolver({
          enabled: true,
          vault,
          deepgram: { apiKey: 'twring-dg' },
        }),
      },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload: { agent_id: `agt_${'a'.repeat(20)}` },
    });
    return { response, create, admit, lines, onError };
  }

  it('answers 409 speech_key_unreadable, creates no call and charges no allowance', async () => {
    const { response, create, admit } = await postWith((_u, provider) =>
      provider === 'deepgram'
        ? Promise.reject(new CredentialDecryptError())
        : Promise.resolve(undefined),
    );
    expect(response.statusCode).toBe(409);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('speech_key_unreadable');
    expect(body.error.message).toBe(
      "Couldn't read your saved Deepgram key. Add it again in Settings.",
    );
    expect(create).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });

  it('answers 503 when the key store is unreadable, fail-closed, with no call or charge', async () => {
    const { response, create, admit, lines, onError } = await postWith(() =>
      Promise.reject(new StoreCorruptError('/data/speech-keys.json')),
    );
    const logged = lines.map((line) => JSON.parse(line) as { level: number; event?: string });
    expect(
      logged.filter((l) => l.event === 'speech_keys_unavailable' && l.level >= 50),
    ).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = JSON.stringify([
      lines,
      onError.mock.calls,
      String(onError.mock.calls[0]?.[0]),
    ]);
    expect(reported).not.toContain('speech-keys.json');
    expect(reported).not.toContain('twring-dg');
    expect(response.statusCode).toBe(503);
    const body = errorResponseSchema.parse(response.json());
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.message).toBe('Calls are briefly unavailable. Try again in a moment.');
    expect(create).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
});
