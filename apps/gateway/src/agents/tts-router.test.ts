import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import { errorResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { createCartesiaTts, type CartesiaTtsOptions } from '../voice/cartesia-tts';
import { FakeTtsProvider } from '../voice/testing';
import { fakeSocketFactory, type FakeSocket } from '../voice/testing';

import { createTtsRouter } from './tts-router';
import { VoiceSampleCache, synthesizeSample } from './voice-samples';
import {
  CARTESIA_VOICES,
  DEEPGRAM_VOICES,
  defaultVoiceId,
  cartesiaVoice,
  isAllowedVoice,
  voiceList,
  XAI_VOICES,
} from './voices';

const DEEPGRAM = { apiKey: 'dg-key', ttsModel: 'flux-haley-en' };
const CARTESIA = { apiKey: 'ct-key', ttsModel: 'sonic-3.6' };
const cartesiaId = CARTESIA_VOICES[0]!.id;
const indianId = CARTESIA_VOICES.find((v) => v.label.endsWith('· Indian'))!.id;

function router(cartesia?: typeof CARTESIA) {
  const made: string[] = [];
  const fallbacks: string[] = [];
  const r = createTtsRouter({
    deepgram: DEEPGRAM,
    cartesia,
    onCartesiaFallback: (id) => fallbacks.push(id),
    createDeepgram: (o) => {
      made.push(`deepgram ${o.model}`);
      return { name: 'dg', open: () => Promise.reject(new Error('unused')) };
    },
    createCartesia: (o) => {
      made.push(`cartesia ${o.model} ${o.voice.voiceUuid} ${o.voice.locale}`);
      return { name: 'ct', open: () => Promise.reject(new Error('unused')) };
    },
  });
  return { r, made, fallbacks };
}

describe('voices', () => {
  it('defaults to Janvi with Cartesia, Haley without, and gates every provider', () => {
    expect(defaultVoiceId()).toBe('flux-haley-en');
    expect(defaultVoiceId({ cartesia: false })).toBe('flux-haley-en');
    expect(defaultVoiceId({ cartesia: true })).toBe('cartesia-janvi-en');
    expect(isAllowedVoice('flux-priya-en')).toBe(true);
    expect(isAllowedVoice(cartesiaId)).toBe(true);
    expect(isAllowedVoice('cartesia-nobody-en')).toBe(false);
    expect(cartesiaVoice('flux-haley-en')).toBeUndefined();
  });

  it('offers Indian, American, and British Cartesia voices with provider-free labels', () => {
    const labels = CARTESIA_VOICES.map((v) => v.label);
    expect(labels.some((l) => l.endsWith('· Indian'))).toBe(true);
    expect(labels.filter((l) => /· (American|British)$/.test(l)).length).toBeGreaterThanOrEqual(2);
    for (const voice of CARTESIA_VOICES) {
      expect(voice.id).toMatch(/^cartesia-[a-z-]+-en$/);
      expect(voice.label).not.toMatch(/cartesia/i);
      expect(voice.voiceUuid).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('hides Cartesia voices unless Cartesia is configured, and never exposes UUIDs', () => {
    const plain = voiceList();
    expect(plain.voices.map((v) => v.id)).toEqual(DEEPGRAM_VOICES.map((v) => v.id));
    const withCartesia = voiceList({ cartesia: true });
    expect(withCartesia.voices.map((v) => v.id)).toContain(cartesiaId);
    expect(plain.default_voice_id).toBe('flux-haley-en');
    expect(withCartesia.default_voice_id).toBe('cartesia-janvi-en');
    expect(withCartesia.voices.map((v) => v.id)).toContain(withCartesia.default_voice_id);
    expect(JSON.stringify(withCartesia)).not.toContain(CARTESIA_VOICES[0]!.voiceUuid);
  });
});

describe('TTS routing by voice id', () => {
  it('uses the opposite default provider after a call voice fails, while samples stay exact', async () => {
    const made: string[] = [];
    const logged: Record<string, unknown>[] = [];
    const r = createTtsRouter({
      deepgram: DEEPGRAM,
      cartesia: CARTESIA,
      logger: { info: () => undefined, warn: (fields) => logged.push(fields) },
      createDeepgram: (options) => {
        made.push(`dg ${options.model}`);
        const provider = new FakeTtsProvider();
        provider.failNextOpen = { code: 'connection_lost', recoverable: true };
        return provider;
      },
      createCartesia: (options) => {
        made.push(`ct ${options.voice.voiceUuid}`);
        const provider = new FakeTtsProvider();
        provider.failNextOpen = { code: 'connection_lost', recoverable: true };
        return provider;
      },
    });
    await expect(
      r.forCall(cartesiaId).open(() => undefined, new AbortController().signal),
    ).rejects.toThrow();
    expect(made).toEqual([`ct ${cartesiaVoice(cartesiaId)!.voiceUuid}`, `dg ${DEEPGRAM.ttsModel}`]);
    made.length = 0;
    await expect(
      r.forCall('flux-kit-en').open(() => undefined, new AbortController().signal),
    ).rejects.toThrow();
    expect(made).toEqual(['dg flux-kit-en', `ct ${cartesiaVoice('cartesia-janvi-en')!.voiceUuid}`]);
    expect(logged.map((fields) => fields.event)).toEqual(['tts_failover', 'tts_failover']);
    made.length = 0;
    expect(r.forSample(cartesiaId)?.name).toBe('fake-tts');
    expect(made).toEqual([`ct ${cartesiaVoice(cartesiaId)!.voiceUuid}`]);
  });

  it('leaves a Deepgram call unwrapped when Cartesia is absent', async () => {
    const { r, made } = router();
    await expect(
      r.forCall('flux-kit-en').open(() => undefined, new AbortController().signal),
    ).rejects.toThrow('unused');
    expect(made).toEqual(['deepgram flux-kit-en']);
  });
  it('sends Deepgram voices to Deepgram and Cartesia voices to Cartesia', () => {
    const { r, made } = router(CARTESIA);
    r.forCall('flux-kit-en');
    r.forCall(indianId);
    const voice = cartesiaVoice(indianId)!;
    expect(made).toEqual(['deepgram flux-kit-en', `cartesia sonic-3.6 ${voice.voiceUuid} en-IN`]);
  });

  it('falls back to the default Deepgram voice when Cartesia is not configured, logging once', () => {
    const { r, made, fallbacks } = router();
    r.forCall(cartesiaId);
    r.forCall(indianId);
    expect(made).toEqual(['deepgram flux-haley-en', 'deepgram flux-haley-en']);
    expect(fallbacks).toEqual([cartesiaId]);
  });

  it('falls back for an unknown voice without logging a Cartesia fallback', () => {
    const { r, made, fallbacks } = router(CARTESIA);
    r.forCall('retired-voice');
    expect(made).toEqual(['deepgram flux-haley-en']);
    expect(fallbacks).toEqual([]);
  });

  function failingRouter(cartesia?: typeof CARTESIA) {
    const made: string[] = [];
    const failing = () => {
      const provider = new FakeTtsProvider();
      provider.failNextOpen = { code: 'auth_failed', recoverable: false };
      return provider;
    };
    const r = createTtsRouter({
      deepgram: DEEPGRAM,
      cartesia,
      cartesiaDefaults: { ttsModel: 'sonic-3.6' },
      createDeepgram: (o) => {
        made.push(`dg ${o.apiKey} ${o.model}`);
        return failing();
      },
      createCartesia: (o) => {
        made.push(`ct ${o.apiKey} ${o.model}`);
        return failing();
      },
    });
    return { r, made };
  }
  const open = (provider: { open: (e: () => void, s: AbortSignal) => Promise<unknown> }) =>
    provider.open(() => undefined, new AbortController().signal);

  it("never fails over from a person's own key", async () => {
    const { r, made } = failingRouter(CARTESIA);
    await expect(
      open(r.forCall(cartesiaId, { cartesia: { apiKey: 'own-ct', source: 'own' } })),
    ).rejects.toThrow();
    expect(made).toEqual(['ct own-ct sonic-3.6']);
    made.length = 0;
    await expect(
      open(r.forCall('flux-kit-en', { deepgram: { apiKey: 'own-dg', source: 'own' } })),
    ).rejects.toThrow();
    expect(made).toEqual(['dg own-dg flux-kit-en']);
  });

  it("still fails over on Twring's keys", async () => {
    const { r, made } = failingRouter(CARTESIA);
    await expect(
      open(
        r.forCall(cartesiaId, {
          deepgram: { apiKey: 'own-dg', source: 'own' },
          cartesia: { apiKey: 'ct-key', source: 'twring' },
        }),
      ),
    ).rejects.toThrow();
    expect(made).toEqual(['ct ct-key sonic-3.6', `dg own-dg ${DEEPGRAM.ttsModel}`]);
  });

  it('speaks a Cartesia voice with only an own Cartesia key', () => {
    const { r, made } = failingRouter();
    r.forCall(cartesiaId, { cartesia: { apiKey: 'own-ct', source: 'own' } });
    expect(made).toEqual(['ct own-ct sonic-3.6']);
  });

  it('samples only the exact voice: none for Cartesia when it is not configured', () => {
    expect(router().r.forSample(cartesiaId)).toBeUndefined();
    expect(router().r.forSample('nope')).toBeUndefined();
    expect(router(CARTESIA).r.forSample(cartesiaId)?.name).toBe('ct');
  });

  it('samples a Cartesia voice with an own key when the server has none', () => {
    const { r, made } = failingRouter();
    r.forSample(cartesiaId, { cartesia: { apiKey: 'own-ct', source: 'own' } });
    expect(made).toEqual(['ct own-ct sonic-3.6']);
  });
});

describe('Cartesia voice samples', () => {
  it('synthesizes and caches a sample through the real Cartesia provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-cartesia-samples-'));
    try {
      const factory = fakeSocketFactory();
      const r = createTtsRouter({
        deepgram: DEEPGRAM,
        cartesia: CARTESIA,
        createCartesia: (o) =>
          createCartesiaWith(o, factory, (socket) => {
            // Answer the final input: two chunks, then done.
            const messages = socket.jsonSent() as Record<string, unknown>[];
            const context = messages[0]!['context_id'] as string;
            socket.receive({ type: 'chunk', data: 'AQI=', context_id: context });
            socket.receive({ type: 'chunk', data: 'AwQ=', context_id: context });
            socket.receive({ type: 'done', done: true, context_id: context });
          }),
      });
      const cache = new VoiceSampleCache(dir, (voiceId, text) =>
        synthesizeSample(r.forSample(voiceId)!, text),
      );
      const file = await cache.get(indianId);
      expect([...file.subarray(44)]).toEqual([1, 2, 3, 4]);
      const spoken = factory.sockets[0]!.jsonSent() as Record<string, unknown>[];
      expect(spoken[0]!['transcript']).toMatch(/^Hi, I'm .+\. This is how I'll sound/);
      expect(factory.sockets[0]!.closedWith).toBe(1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Cartesia voice samples without a Cartesia key (verifier)', () => {
  it('answers 404 not_found, like any voice this server does not offer, and synthesizes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-cartesia-off-'));
    const r = createTtsRouter({ deepgram: DEEPGRAM, cartesia: undefined });
    const attempts: string[] = [];
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      onError: () => undefined,
      voiceSamples: {
        samples: new VoiceSampleCache(dir, (voiceId, text) => {
          attempts.push(voiceId);
          const provider = r.forSample(voiceId);
          if (provider === undefined) return Promise.reject(new Error('voice not configured'));
          return synthesizeSample(provider, text);
        }),
        ratePerMinute: 1,
        offered: (voiceId) => voiceList({ cartesia: false }).voices.some((v) => v.id === voiceId),
      },
    });
    try {
      // Retrying never helps, so this is not a 503 "try again"; and it spends no rate budget.
      for (let i = 0; i < 2; i += 1) {
        const res = await app.inject({ method: 'GET', url: `/v1/voices/${indianId}/sample` });
        expect(res.statusCode).toBe(404);
        expect(errorResponseSchema.parse(res.json()).error.code).toBe('not_found');
      }
      expect(attempts).toEqual([]);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A real Cartesia provider on a fake socket that runs `answer` once the context is flushed. */
function createCartesiaWith(
  options: CartesiaTtsOptions,
  factory: ReturnType<typeof fakeSocketFactory>,
  answer: (socket: FakeSocket) => void,
) {
  const provider = createCartesiaTts({ ...options, socketFactory: factory });
  return {
    name: provider.name,
    async open(...args: Parameters<typeof provider.open>) {
      const session = await provider.open(...args);
      const socket = factory.sockets.at(-1)!;
      return {
        speak: session.speak.bind(session),
        flush: (id: string) => {
          session.flush(id);
          queueMicrotask(() => answer(socket));
        },
        cancel: session.cancel.bind(session),
        close: session.close.bind(session),
      };
    },
  };
}

describe('Grok voices', () => {
  function xaiRouter() {
    const made: string[] = [];
    const failing = () => {
      const provider = new FakeTtsProvider();
      provider.failNextOpen = { code: 'auth_failed', recoverable: false };
      return provider;
    };
    const r = createTtsRouter({
      deepgram: DEEPGRAM,
      cartesia: CARTESIA,
      createDeepgram: (o) => {
        made.push(`dg ${o.apiKey} ${o.model}`);
        return failing();
      },
      createCartesia: (o) => {
        made.push(`ct ${o.apiKey}`);
        return failing();
      },
      createXai: (o) => {
        made.push(`xai ${o.apiKey} ${o.voice}`);
        return failing();
      },
    });
    return { r, made };
  }
  const grokId = XAI_VOICES[0]!.id;

  it('passes the server xAI latency setting to every Grok voice', () => {
    const seen: (number | undefined)[] = [];
    const r = createTtsRouter({
      deepgram: DEEPGRAM,
      xaiDefaults: { optimizeStreamingLatency: 2 },
      createXai: (o) => {
        seen.push(o.optimizeStreamingLatency);
        return new FakeTtsProvider();
      },
    });
    r.forCall(grokId, {
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      xai: { apiKey: 'own-xai', source: 'own' },
    });
    expect(seen).toEqual([2]);
  });

  it('speaks a Grok voice on the own xAI key and never fails over', async () => {
    const { r, made } = xaiRouter();
    const tts = r.forCall(grokId, {
      deepgram: { apiKey: 'twring-dg', source: 'twring' },
      xai: { apiKey: 'own-xai', source: 'own' },
    });
    await expect(tts.open(() => undefined, new AbortController().signal)).rejects.toThrow();
    expect(made).toEqual(['xai own-xai eve']);
  });

  it("speaks Twring's default voice for a Grok voice without an xAI key, with no xAI request", () => {
    const { r, made } = xaiRouter();
    r.forCall(grokId, { deepgram: { apiKey: 'twring-dg', source: 'twring' } });
    r.forCall(grokId);
    expect(made).toEqual([`dg twring-dg ${DEEPGRAM.ttsModel}`, `dg dg-key ${DEEPGRAM.ttsModel}`]);
  });

  it('lists Grok voices only for a caller with an own xAI key', () => {
    expect(voiceList({ cartesia: true }).voices.map((v) => v.id)).not.toContain(grokId);
    const ids = voiceList({ cartesia: false, xai: true }).voices.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(XAI_VOICES.map((v) => v.id)));
    expect(isAllowedVoice(grokId)).toBe(true);
    for (const voice of XAI_VOICES) expect(voice.label).toMatch(/· Grok$/);
  });
});
