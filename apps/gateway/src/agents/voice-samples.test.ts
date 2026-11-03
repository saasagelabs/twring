import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import { errorResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { StoreCorruptError } from '../store/collection';
import { createDeepgramTts } from '../voice/deepgram-tts';
import { serverXaiSampleRouter } from '../voice/server-xai-voice';
import { SpeechKeyUnreadableError, type SpeechResolver } from '../voice/speech-resolver';
import { fakeSocketFactory } from '../voice/testing';
import { VoiceProviderError, type TtsEvent, type TtsProvider } from '../voice/types';

import { createTtsRouter } from './tts-router';
import { voiceList } from './voices';

import {
  MAX_SAMPLE_BYTES,
  VoiceSampleCache,
  createOwnKeySample,
  sampleSynthesizer,
  sampleText,
  synthesizeSample,
  wav,
} from './voice-samples';

const env = loadGatewayEnv(gatewayEnvFixture());
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cord-samples-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A TTS provider whose one turn answers with `script` once flushed. */
function fakeTts(script: (emit: (event: TtsEvent) => void) => void): TtsProvider & {
  spoken: string[];
  closed: number;
} {
  const provider = {
    name: 'fake',
    spoken: [] as string[],
    closed: 0,
    open(onEvent: (event: TtsEvent) => void) {
      return Promise.resolve({
        speak: (_id: string, text: string) => provider.spoken.push(text),
        flush: () => queueMicrotask(() => script(onEvent)),
        cancel: () => undefined,
        close: () => {
          provider.closed += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return provider;
}

function makeApp(samples: VoiceSampleCache, ratePerMinute?: number) {
  return buildApp({
    env,
    onError: () => undefined,
    voiceSamples: { samples, ...(ratePerMinute !== undefined && { ratePerMinute }) },
  });
}

describe('sample synthesis', () => {
  it('speaks the voice introduction and collects its audio', async () => {
    const tts = fakeTts((emit) => {
      emit({ type: 'audio', generationId: 'sample', bytes: new Uint8Array([1, 2]) });
      emit({ type: 'audio', generationId: 'sample', bytes: new Uint8Array([3, 4]) });
      emit({ type: 'done', generationId: 'sample' });
    });
    const pcm = await synthesizeSample(tts, sampleText('Kit · British'));
    expect([...pcm]).toEqual([1, 2, 3, 4]);
    expect(tts.spoken).toEqual(["Hi, I'm Kit. This is how I'll sound on your calls."]);
    expect(tts.closed).toBe(1);
  });

  it('fails on provider error, silence, oversize, and timeout, closing the session each time', async () => {
    const failing = fakeTts((emit) =>
      emit({ type: 'error', error: { code: 'provider_error', recoverable: true } }),
    );
    await expect(synthesizeSample(failing, 'x')).rejects.toThrow(/provider_error/);
    expect(failing.closed).toBe(1);

    const silent = fakeTts((emit) => emit({ type: 'done', generationId: 'sample' }));
    await expect(synthesizeSample(silent, 'x')).rejects.toThrow(/no audio/);

    const huge = fakeTts((emit) =>
      emit({ type: 'audio', generationId: 'sample', bytes: new Uint8Array(MAX_SAMPLE_BYTES + 2) }),
    );
    await expect(synthesizeSample(huge, 'x')).rejects.toThrow(/too long/);

    const stuck = fakeTts(() => undefined);
    await expect(synthesizeSample(stuck, 'x', 20)).rejects.toThrow(/timed out/);
    expect(stuck.closed).toBe(1);
  });

  it('wraps PCM in a playable WAV header', () => {
    const file = wav(new Uint8Array([0, 0, 1, 0]), 48_000);
    expect(file.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(file.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(file.readUInt32LE(24)).toBe(48_000);
    expect(file.readUInt32LE(40)).toBe(4);
    expect(file.byteLength).toBe(48);
  });
});

describe('GET /v1/voices/:id/sample', () => {
  it('synthesizes once, caches on disk, and serves the cache afterwards', async () => {
    const calls: string[] = [];
    const samples = new VoiceSampleCache(join(dir, 'voice-samples'), (voiceId) => {
      calls.push(voiceId);
      return Promise.resolve(new Uint8Array([9, 9]));
    });
    const app = makeApp(samples);
    const [first, second] = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/voices/flux-kit-en/sample' }),
      app.inject({ method: 'GET', url: '/v1/voices/flux-kit-en/sample' }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('audio/wav');
    expect(first.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(second.rawPayload).toEqual(first.rawPayload);
    expect(calls).toEqual(['flux-kit-en']);
    expect(await readdir(join(dir, 'voice-samples'))).toEqual(['flux-kit-en.wav']);

    // A fresh process (new cache object) reads the file instead of synthesizing again.
    const restarted = makeApp(
      new VoiceSampleCache(join(dir, 'voice-samples'), () => Promise.reject(new Error('no'))),
    );
    const cached = await restarted.inject({ method: 'GET', url: '/v1/voices/flux-kit-en/sample' });
    expect(cached.statusCode).toBe(200);
    expect(cached.rawPayload).toEqual(first.rawPayload);
    await Promise.all([app.close(), restarted.close()]);
  });

  it('refuses voices that are not on the allow-list without synthesizing or touching disk', async () => {
    const calls: string[] = [];
    const samples = new VoiceSampleCache(dir, (voiceId) => {
      calls.push(voiceId);
      return Promise.resolve(new Uint8Array([1]));
    });
    const app = makeApp(samples);
    for (const id of ['aura-evil', '..%2F..%2Fetc%2Fpasswd', 'flux-kit-en.wav']) {
      const res = await app.inject({ method: 'GET', url: `/v1/voices/${id}/sample` });
      expect(res.statusCode).toBe(404);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('not_found');
    }
    expect(calls).toEqual([]);
    await expect(samples.get('aura-evil')).rejects.toThrow(/not allowed/);
    await app.close();
  });

  it('rate-limits per client', async () => {
    await writeFile(join(dir, 'flux-kit-en.wav'), wav(new Uint8Array([1, 1])));
    const app = makeApp(new VoiceSampleCache(dir, () => Promise.reject(new Error('unused'))), 2);
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push(
        (await app.inject({ method: 'GET', url: '/v1/voices/flux-kit-en/sample' })).statusCode,
      );
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  it('answers 503 when synthesis fails, and caches nothing so a retry can succeed', async () => {
    let fail = true;
    const app = makeApp(
      new VoiceSampleCache(dir, () =>
        fail ? Promise.reject(new Error('deepgram down')) : Promise.resolve(new Uint8Array([2, 2])),
      ),
    );
    const failed = await app.inject({ method: 'GET', url: '/v1/voices/flux-miles-en/sample' });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toMatch(/deepgram/i);
    expect(await readdir(dir)).toEqual([]);
    fail = false;
    const retried = await app.inject({ method: 'GET', url: '/v1/voices/flux-miles-en/sample' });
    expect(retried.statusCode).toBe(200);
    await app.close();
  });
});

describe('voice samples (milestone 9 verifier)', () => {
  const flux = (factory: ReturnType<typeof fakeSocketFactory>) =>
    createDeepgramTts({ apiKey: 'k', model: 'flux-kit-en', socketFactory: factory });
  const SAMPLE_URL = '/v1/voices/flux-kit-en/sample';

  it('synthesizes through real Flux TTS framing and closes the socket afterwards', async () => {
    const factory = fakeSocketFactory();
    const pending = synthesizeSample(flux(factory), 'hello');
    await vi.waitFor(() => expect(factory.sockets[0]?.jsonSent()).toHaveLength(2));
    const socket = factory.sockets[0]!;
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(new Uint8Array(4));
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    expect((await pending).byteLength).toBe(4);
    expect(socket.closedWith).toBe(1000);
  });

  it('a synthesis timeout closes the provider socket, whether or not it ever opened', async () => {
    const opened = fakeSocketFactory();
    await expect(synthesizeSample(flux(opened), 'x', 30)).rejects.toThrow(/timed out/);
    expect(opened.sockets[0]!.closedWith).toBe(1000);

    const never = fakeSocketFactory(false);
    await expect(synthesizeSample(flux(never), 'x', 30)).rejects.toThrow();
    expect(never.sockets[0]!.closedWith).toBeDefined();
  });

  it('refuses an oversize Flux stream and closes the socket at once', async () => {
    const factory = fakeSocketFactory();
    const pending = synthesizeSample(flux(factory), 'hello');
    await vi.waitFor(() => expect(factory.sockets[0]?.jsonSent()).toHaveLength(2));
    const socket = factory.sockets[0]!;
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(new Uint8Array(MAX_SAMPLE_BYTES));
    socket.receive(new Uint8Array(2));
    await expect(pending).rejects.toThrow(/too long/);
    expect(socket.closedWith).toBe(1000);
  });

  it('concurrent first requests share one failing synthesis, all get 503, then a retry synthesizes again', async () => {
    let calls = 0;
    let fail: ((error: Error) => void) | undefined;
    const samples = new VoiceSampleCache(dir, () => {
      calls += 1;
      if (calls === 1) return new Promise<Uint8Array>((_, reject) => (fail = reject));
      return Promise.resolve(new Uint8Array([4, 4]));
    });
    const app = makeApp(samples);
    const all = Promise.all([
      app.inject({ method: 'GET', url: SAMPLE_URL }),
      app.inject({ method: 'GET', url: SAMPLE_URL }),
      app.inject({ method: 'GET', url: SAMPLE_URL }),
    ]);
    await vi.waitFor(() => expect(fail).toBeDefined());
    fail!(new Error('deepgram down'));
    expect((await all).map((res) => res.statusCode)).toEqual([503, 503, 503]);
    expect(calls).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    const retried = await app.inject({ method: 'GET', url: SAMPLE_URL });
    expect(retried.statusCode).toBe(200);
    expect(calls).toBe(2);
    await app.close();
  });

  it('does not serve an empty, corrupt, or truncated cached file; it synthesizes a fresh one', async () => {
    const good = wav(new Uint8Array([7, 7, 7, 7]));
    let calls = 0;
    const samples = new VoiceSampleCache(dir, () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([7, 7, 7, 7]));
    });
    const app = makeApp(samples);
    for (const broken of [Buffer.alloc(0), Buffer.from('not a wav at all'), good.subarray(0, 46)]) {
      await writeFile(join(dir, 'flux-kit-en.wav'), broken);
      const res = await app.inject({ method: 'GET', url: SAMPLE_URL });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload).toEqual(good);
      expect(await readFile(join(dir, 'flux-kit-en.wav'))).toEqual(good);
    }
    expect(calls).toBe(3);
    await app.close();
  });

  it('still serves a sample, synthesized once, when the data directory cannot be written', async () => {
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x');
    let calls = 0;
    const samples = new VoiceSampleCache(join(blocker, 'voice-samples'), () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([3, 3]));
    });
    const app = makeApp(samples);
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'GET', url: SAMPLE_URL });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    }
    expect(calls).toBe(1);
    await app.close();
  });

  it('leaves no temporary file behind when the cache write fails part-way', async () => {
    const samples = new VoiceSampleCache(dir, () => Promise.resolve(new Uint8Array([1, 1])));
    // A directory where the sample file should go makes the final rename fail.
    await mkdir(join(dir, 'flux-kit-en.wav'));
    const app = makeApp(samples);
    const res = await app.inject({ method: 'GET', url: SAMPLE_URL });
    expect(res.statusCode).toBe(200);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await app.close();
  });

  it('keys the rate limit on the socket address, not a spoofed X-Forwarded-For', async () => {
    await writeFile(join(dir, 'flux-kit-en.wav'), wav(new Uint8Array([1, 1])));
    const app = makeApp(new VoiceSampleCache(dir, () => Promise.reject(new Error('unused'))), 2);
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: SAMPLE_URL,
        headers: { 'x-forwarded-for': `198.51.100.${i}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  it('refuses encoded traversal and case variants of a real id', async () => {
    const app = makeApp(new VoiceSampleCache(dir, () => Promise.reject(new Error('unused'))));
    for (const id of ['..%2Fflux-kit-en', 'FLUX-KIT-EN', 'flux-kit-en%00', '%2e%2e', 'x%2F..']) {
      const res = await app.inject({ method: 'GET', url: `/v1/voices/${id}/sample` });
      expect(res.statusCode, id).toBe(404);
    }
    await app.close();
  });
});

describe('voice samples with a person’s own key', () => {
  function ownApp(
    ownKeySample: (userId: string, voiceId: string) => Promise<Uint8Array | undefined>,
  ) {
    const cached: string[] = [];
    const samples = new VoiceSampleCache(join(dir, 'voice-samples'), (voiceId) => {
      cached.push(voiceId);
      return Promise.resolve(new Uint8Array([7, 7]));
    });
    const own = vi.fn(ownKeySample);
    const onError = vi.fn();
    const app = buildApp({
      env,
      onError,
      userFor: (request) => String(request.headers['x-user'] ?? 'alice'),
      voiceSamples: {
        samples,
        // The server has Deepgram but no Cartesia key.
        offered: (voiceId) => !voiceId.startsWith('cartesia-'),
        ownKeySample: own,
      },
    });
    const get = (voiceId: string, user = 'alice') =>
      app.inject({
        method: 'GET',
        url: `/v1/voices/${voiceId}/sample`,
        headers: { 'x-user': user },
      });
    return { app, get, cached, own, onError };
  }

  it('a voice the server makes uses the shared cache and Twring’s key, own key or not', async () => {
    const { app, get, cached, own } = ownApp(() => Promise.resolve(new Uint8Array([1, 1])));
    const res = await get('flux-kit-en');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(cached).toEqual(['flux-kit-en']);
    expect(own).not.toHaveBeenCalled();
    await app.close();
  });

  it('a Cartesia voice with only Alice’s own key is made per request and never cached', async () => {
    const { app, get, cached, own } = ownApp((userId) =>
      Promise.resolve(userId === 'alice' ? new Uint8Array([5, 5]) : undefined),
    );
    const res = await get('cartesia-janvi-en');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(own).toHaveBeenCalledWith('alice', 'cartesia-janvi-en', expect.any(String));
    expect(cached).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    // Bob has no Cartesia key: the voice does not exist for him.
    expect((await get('cartesia-janvi-en', 'bob')).statusCode).toBe(404);
    await app.close();
  });

  it('an unreadable saved key gives 409; an unreadable store gives 503 and alerts', async () => {
    const unreadable = ownApp(() => Promise.reject(new SpeechKeyUnreadableError('cartesia')));
    const res = await unreadable.get('cartesia-janvi-en');
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_unreadable',
      message: "Couldn't read your saved Cartesia key. Add it again in Settings.",
    });
    await unreadable.app.close();
    const corrupt = ownApp(() => Promise.reject(new StoreCorruptError('speech-keys.json')));
    const down = await corrupt.get('cartesia-janvi-en');
    expect(down.statusCode).toBe(503);
    expect(errorResponseSchema.parse(down.json()).error.message).toBe(
      'Voice is briefly unavailable. Try again in a moment.',
    );
    expect(corrupt.onError).toHaveBeenCalledTimes(1);
    await corrupt.app.close();
  });

  it('without the own-key hook (switch off) a voice the server lacks stays 404', async () => {
    const samples = new VoiceSampleCache(dir, () => Promise.reject(new Error('unused')));
    const app = buildApp({
      env,
      onError: () => undefined,
      voiceSamples: { samples, offered: (voiceId) => !voiceId.startsWith('cartesia-') },
    });
    expect(
      (await app.inject({ method: 'GET', url: '/v1/voices/cartesia-janvi-en/sample' })).statusCode,
    ).toBe(404);
    await app.close();
  });
});

describe('own-key samples through the real wiring', () => {
  function refusingApp(how: 'open' | 'stream') {
    const lines: string[] = [];
    const router = createTtsRouter({
      deepgram: { apiKey: 'server-dg', ttsModel: 'flux-haley-en' },
      cartesiaDefaults: { ttsModel: 'sonic-3' },
      createCartesia: () =>
        how === 'open'
          ? {
              name: 'cartesia',
              open: () =>
                Promise.reject(new VoiceProviderError({ code: 'auth_failed', recoverable: false })),
            }
          : fakeTts((emit) =>
              emit({ type: 'error', error: { code: 'auth_failed', recoverable: false } }),
            ),
    });
    const app = buildApp({
      env,
      onError: () => undefined,
      userFor: () => 'alice',
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
      voiceSamples: {
        samples: new VoiceSampleCache(dir, () => Promise.reject(new Error('unused'))),
        offered: (voiceId) => !voiceId.startsWith('cartesia-'),
        ownKeySample: createOwnKeySample(
          {
            resolve: () =>
              Promise.resolve({
                cartesia: { apiKey: 'own-cartesia-secret', source: 'own' as const },
              }),
          },
          router,
        ),
      },
    });
    return { app, lines };
  }

  it.each(['open', 'stream'] as const)(
    'a refused own key (%s) gives 409 speech_key_refused',
    async (how) => {
      const { app, lines } = refusingApp(how);
      const res = await app.inject({ method: 'GET', url: '/v1/voices/cartesia-janvi-en/sample' });
      expect(res.statusCode).toBe(409);
      expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
        code: 'speech_key_refused',
        message: 'Your Cartesia key was refused. Update it in Settings.',
      });
      expect(lines.join('\n')).not.toContain('own-cartesia-secret');
      await app.close();
    },
  );
});

describe('Grok voice previews', () => {
  type Resolved = Awaited<ReturnType<Parameters<typeof createOwnKeySample>[0]['resolve']>>;
  function grokApp(resolved: Resolved, script: (emit: (event: TtsEvent) => void) => void) {
    const lines: string[] = [];
    const xaiOpened = vi.fn();
    const synthesize = vi.fn(() => Promise.reject(new Error('unused')));
    const router = createTtsRouter({
      deepgram: { apiKey: 'server-dg', ttsModel: 'flux-haley-en' },
      createDeepgram: () => fakeTts((emit) => emit({ type: 'done', generationId: 'sample' })),
      createXai: (options) => {
        xaiOpened(options.voice);
        return fakeTts(script);
      },
    });
    const app = buildApp({
      env,
      onError: () => undefined,
      userFor: () => 'alice',
      logger: { level: 'debug', stream: { write: (line: string) => lines.push(line) } },
      voiceSamples: {
        samples: new VoiceSampleCache(dir, synthesize),
        offered: (voiceId) => !voiceId.startsWith('xai-'),
        ownKeySample: createOwnKeySample({ resolve: () => Promise.resolve(resolved) }, router),
      },
    });
    return { app, lines, xaiOpened, synthesize };
  }
  const speaks = (emit: (event: TtsEvent) => void) => {
    emit({ type: 'audio', generationId: 'sample', bytes: new Uint8Array([1, 2]) });
    emit({ type: 'done', generationId: 'sample' });
  };
  const refuses = (emit: (event: TtsEvent) => void) =>
    emit({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
  const xai = { apiKey: 'own-xai-secret', source: 'own' as const };

  it('own Deepgram and a refused own xAI key: 409 naming xAI, not Deepgram', async () => {
    const { app, lines } = grokApp(
      { deepgram: { apiKey: 'own-dg-secret', source: 'own' }, xai },
      refuses,
    );
    const res = await app.inject({ method: 'GET', url: '/v1/voices/xai-eve-en/sample' });
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'speech_key_refused',
      message: 'Your xAI key was refused. Update it in Settings.',
    });
    expect(lines.join('\n')).not.toContain('own-xai-secret');
    await app.close();
  });

  it('a person whose only own key is xAI previews a Grok voice, private and never cached', async () => {
    const { app, xaiOpened, synthesize } = grokApp(
      { deepgram: { apiKey: 'server-dg', source: 'twring' }, xai },
      speaks,
    );
    const res = await app.inject({ method: 'GET', url: '/v1/voices/xai-eve-en/sample' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(xaiOpened).toHaveBeenCalledWith('eve');
    expect(synthesize).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
    expect(res.body).not.toContain('own-xai-secret');
    await app.close();
  });

  it('without an xAI key a Grok preview is not listed (404) and xAI is never asked', async () => {
    const { app, xaiOpened } = grokApp(
      { deepgram: { apiKey: 'own-dg-secret', source: 'own' } },
      speaks,
    );
    const res = await app.inject({ method: 'GET', url: '/v1/voices/xai-eve-en/sample' });
    expect(res.statusCode).toBe(404);
    expect(xaiOpened).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('voice samples on a self-hosted server with only its own xAI key', () => {
  const speaking = () =>
    fakeTts((emit) => {
      emit({ type: 'audio', generationId: 'sample', bytes: new Uint8Array([5, 6]) });
      emit({ type: 'done', generationId: 'sample' });
    });
  function xaiServerApp(resolved: Awaited<ReturnType<SpeechResolver['resolve']>>) {
    const made: { kind: string; apiKey: string; voice: string }[] = [];
    const ownRouter = createTtsRouter({
      deepgram: { apiKey: '', ttsModel: 'flux-haley-en' },
      createDeepgram: (options) => {
        made.push({ kind: 'deepgram', apiKey: options.apiKey, voice: options.model });
        return speaking();
      },
    });
    const router = serverXaiSampleRouter('server-xai-key', ownRouter, (options) => {
      made.push({ kind: 'xai', apiKey: options.apiKey, voice: options.voice });
      return speaking();
    });
    const app = buildApp({
      env,
      onError: () => undefined,
      voiceSamples: {
        samples: new VoiceSampleCache(dir, sampleSynthesizer(router)),
        offered: (voiceId) =>
          voiceList({ cartesia: false, xaiServer: true }).voices.some((v) => v.id === voiceId),
        ownKeySample: createOwnKeySample({ resolve: () => Promise.resolve(resolved) }, router),
      },
    });
    return { app, made };
  }
  const server = { xai: { apiKey: 'server-xai-key', source: 'twring' as const } };

  it('serves a Grok voice as a WAV from the server key, cached for everyone', async () => {
    const { app, made } = xaiServerApp(server);
    const res = await app.inject({ method: 'GET', url: '/v1/voices/xai-rex-en/sample' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');
    expect(res.rawPayload.equals(wav(new Uint8Array([5, 6])))).toBe(true);
    expect(made).toEqual([{ kind: 'xai', apiKey: 'server-xai-key', voice: 'rex' }]);
    expect(await readdir(dir)).toHaveLength(1);
    await app.close();
  });

  it('a Deepgram voice is 404 without the person’s own key', async () => {
    const { app, made } = xaiServerApp(server);
    const res = await app.inject({ method: 'GET', url: '/v1/voices/flux-haley-en/sample' });
    expect(res.statusCode).toBe(404);
    expect(made).toEqual([]);
    await app.close();
  });

  it('a Deepgram voice speaks on the person’s own key, never cached', async () => {
    const { app, made } = xaiServerApp({
      ...server,
      deepgram: { apiKey: 'own-dg-secret', source: 'own' },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/voices/flux-haley-en/sample' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(made).toEqual([{ kind: 'deepgram', apiKey: 'own-dg-secret', voice: 'flux-haley-en' }]);
    expect(await readdir(dir)).toHaveLength(0);
    await app.close();
  });
});
