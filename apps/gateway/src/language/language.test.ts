import { errorResponseSchema, SPEAKER_LANGUAGES, type SpeakerLanguage } from '@twring/contracts';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { createTtsRouter } from '../agents/tts-router';
import { CARTESIA_DEFAULT_VOICE_ID, CARTESIA_VOICES, voiceList } from '../agents/voices';
import { MemoryCollection } from '../store/collection';
import { createCallStt } from '../voice/call-stt';
import { createCartesiaTts } from '../voice/cartesia-tts';
import { createPrerecordedTranscriber } from '../voice/deepgram-prerecorded';
import { createSpeechResolver, type ResolvedSpeech } from '../voice/speech-resolver';
import { FakeSttProvider, fakeSocketFactory } from '../voice/testing';
import { transcribeWithXai } from '../voice/xai-rest';
import { createXaiStt } from '../voice/xai-stt';
import { createXaiTts } from '../voice/xai-tts';

import { registerLanguageRoutes } from './routes';
import { LanguageRepository, type LanguageRecord } from './store';

const signal = () => new AbortController().signal;

describe('LanguageRepository', () => {
  it('reads English with no row, keeps one row per person, and deletes it', async () => {
    const rows = new MemoryCollection<LanguageRecord>();
    const store = new LanguageRepository(rows);
    expect(await store.get('alice')).toBe('en');
    await store.put('alice', 'hi');
    await store.put('alice', 'es');
    expect(await store.get('alice')).toBe('es');
    expect(await store.get('bob')).toBe('en');
    expect(await rows.read()).toHaveLength(1);
    expect(await store.deleteAllForUser('alice')).toBe(1);
    expect(await store.get('alice')).toBe('en');
  });

  it('reads a bad stored code as English', async () => {
    const rows = new MemoryCollection<LanguageRecord>();
    await rows.update(() => ({ items: [{ user_id: 'alice', language: 'ta' }], result: 0 }));
    expect(await new LanguageRepository(rows).get('alice')).toBe('en');
  });
});

describe('/v1/me/language', () => {
  async function app() {
    const server = Fastify();
    registerLanguageRoutes(server, {
      store: new LanguageRepository(new MemoryCollection()),
      writeRatePerMinute: 100,
      userFor: (request) => String(request.headers['x-user']),
    });
    await server.ready();
    return server;
  }

  it('answers English by default and saves a language per person', async () => {
    const server = await app();
    const get = (user: string) =>
      server.inject({ method: 'GET', url: '/v1/me/language', headers: { 'x-user': user } });
    expect((await get('alice')).json()).toEqual({ language: 'en' });
    const put = await server.inject({
      method: 'PUT',
      url: '/v1/me/language',
      headers: { 'x-user': 'alice' },
      payload: { language: 'hi' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ language: 'hi' });
    expect((await get('alice')).json()).toEqual({ language: 'hi' });
    expect((await get('bob')).json()).toEqual({ language: 'en' });
  });

  it('answers 400 bad_request on an unknown or missing language', async () => {
    const server = await app();
    for (const payload of [{ language: 'ta' }, {}, { language: 7 }]) {
      const response = await server.inject({
        method: 'PUT',
        url: '/v1/me/language',
        headers: { 'x-user': 'alice' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error.code).toBe('bad_request');
    }
  });

  it('rate limits writes', async () => {
    const server = Fastify();
    registerLanguageRoutes(server, {
      store: new LanguageRepository(new MemoryCollection()),
      writeRatePerMinute: 1,
    });
    const put = () =>
      server.inject({ method: 'PUT', url: '/v1/me/language', payload: { language: 'fr' } });
    expect((await put()).statusCode).toBe(200);
    expect((await put()).statusCode).toBe(429);
  });
});

describe('speech resolver language', () => {
  const resolve = (languageFor?: (userId: string) => Promise<SpeakerLanguage>) =>
    createSpeechResolver({
      enabled: false,
      deepgram: { apiKey: 'dg' },
      ...(languageFor && { languageFor }),
    }).resolve('alice');

  it('sets the language only when it is not English', async () => {
    expect(await resolve(() => Promise.resolve('hi'))).toMatchObject({ language: 'hi' });
    expect('language' in (await resolve(() => Promise.resolve('en')))).toBe(false);
    expect('language' in (await resolve())).toBe(false);
  });

  it('reads as English when the language read fails: never a failed call', async () => {
    const resolved = await resolve(() => Promise.reject(new Error('disk')));
    expect(resolved).toEqual({
      deepgram: { apiKey: 'dg', source: 'twring' },
      listening: 'deepgram',
    });
  });
});

describe('call STT language', () => {
  const DEEPGRAM = {
    apiKey: 'dg',
    sttModel: 'flux-general-en',
    sttLanguageHints: ['en'],
  };
  function build() {
    const made: Record<string, unknown>[] = [];
    const sttFor = createCallStt({
      deepgram: DEEPGRAM,
      xai: { endpointingMs: 400 },
      keyterms: (terms) => [...terms],
      createDeepgram: (options) => {
        made.push({ ...options });
        return new FakeSttProvider();
      },
      createXai: (options) => {
        made.push({ ...options });
        return new FakeSttProvider();
      },
    });
    return { sttFor, made };
  }

  it('English keeps the configured model and hints', () => {
    const { sttFor, made } = build();
    sttFor([], undefined, { deepgram: { apiKey: 'dg', source: 'twring' } });
    sttFor([], undefined, undefined);
    for (const options of made) {
      expect(options['model']).toBe('flux-general-en');
      expect(options['languageHints']).toEqual(['en']);
    }
  });

  it('another language listens on flux-general-multi with that hint', () => {
    const { sttFor, made } = build();
    sttFor([], undefined, { deepgram: { apiKey: 'own', source: 'own' }, language: 'hi' });
    expect(made[0]).toMatchObject({
      apiKey: 'own',
      model: 'flux-general-multi',
      languageHints: ['hi'],
    });
  });

  it('xAI gets the language only when it is not English', () => {
    const { sttFor, made } = build();
    const xai: ResolvedSpeech = { xai: { apiKey: 'x', source: 'own' }, listening: 'xai' };
    sttFor([], undefined, xai);
    sttFor([], undefined, { ...xai, language: 'es' });
    expect('language' in made[0]!).toBe(false);
    expect(made[1]).toMatchObject({ language: 'es' });
  });
});

describe('xAI streaming language', () => {
  it('STT and TTS send the language, English by default', async () => {
    for (const language of [undefined, 'fr'] as const) {
      const factory = fakeSocketFactory();
      const stt = createXaiStt({
        apiKey: 'k',
        socketFactory: factory,
        setTimeout: () => () => {},
        ...(language && { language }),
      });
      await stt.open(() => {}, signal());
      const tts = createXaiTts({
        apiKey: 'k',
        voice: 'eve',
        socketFactory: factory,
        ...(language && { language }),
      });
      await tts.open(() => {}, signal());
      for (const socket of factory.sockets)
        expect(new URL(socket.url).searchParams.get('language')).toBe(language ?? 'en');
    }
  });
});

describe('Cartesia language', () => {
  async function firstRequest(language?: SpeakerLanguage) {
    const factory = fakeSocketFactory();
    const tts = createCartesiaTts({
      apiKey: 'k',
      model: 'sonic-3.6',
      voice: { voiceUuid: 'v', locale: 'en-IN' },
      socketFactory: factory,
      setInterval: () => () => {},
      ...(language && { language }),
    });
    const session = await tts.open(() => {}, signal());
    session.speak('g1', 'Hi.');
    return (factory.sockets[0]!.jsonSent() as Record<string, unknown>[])[0]!;
  }

  it('English sends the voice locale exactly as before', async () => {
    for (const request of [await firstRequest(), await firstRequest('en')]) {
      expect(request['locale']).toBe('en-IN');
      expect('language' in request).toBe(false);
    }
  });

  it('another language sends language and never locale (only one may be sent)', async () => {
    const request = await firstRequest('hi');
    expect(request['language']).toBe('hi');
    expect('locale' in request).toBe(false);
  });
});

describe('TTS router language', () => {
  const DEEPGRAM = { apiKey: 'dg', ttsModel: 'flux-haley-en' };
  const CARTESIA = { apiKey: 'ct', ttsModel: 'sonic-3.6' };
  function router(cartesia?: typeof CARTESIA) {
    const made: string[] = [];
    const unused = (name: string) => ({ name, open: () => Promise.reject(new Error('unused')) });
    const r = createTtsRouter({
      deepgram: DEEPGRAM,
      cartesia,
      createDeepgram: (o) => {
        made.push(`deepgram ${o.model}`);
        return unused('dg');
      },
      createCartesia: (o) => {
        made.push(`cartesia ${o.voice.voiceUuid} ${o.language ?? '-'}`);
        return unused('ct');
      },
      createXai: (o) => {
        made.push(`xai ${o.voice} ${o.language ?? '-'}`);
        return unused('xai');
      },
    });
    return { r, made };
  }
  const defaultUuid = CARTESIA_VOICES.find((v) => v.id === CARTESIA_DEFAULT_VOICE_ID)!.voiceUuid;

  it('a Deepgram voice becomes the default Cartesia voice for a non-English speaker', () => {
    const { r, made } = router(CARTESIA);
    r.forCall('flux-gemma-en', { language: 'hi' });
    expect(made).toEqual([`cartesia ${defaultUuid} hi`]);
  });

  it('keeps the Deepgram voice when there is no Cartesia key', () => {
    const { r, made } = router();
    r.forCall('flux-gemma-en', { language: 'hi' });
    expect(made).toEqual(['deepgram flux-gemma-en']);
  });

  it('English is unchanged: the Deepgram voice, and Cartesia without a language', () => {
    const { r, made } = router(CARTESIA);
    r.forCall('flux-gemma-en', {});
    r.forCall(CARTESIA_VOICES[1]!.id);
    expect(made).toEqual(['deepgram flux-gemma-en', `cartesia ${CARTESIA_VOICES[1]!.voiceUuid} -`]);
  });

  it('Cartesia and Grok voices get the language; samples stay English', () => {
    const { r, made } = router(CARTESIA);
    const speech: ResolvedSpeech = { xai: { apiKey: 'x', source: 'own' }, language: 'de' };
    r.forCall(CARTESIA_VOICES[1]!.id, speech);
    r.forCall('xai-eve-en', speech);
    r.forSample(CARTESIA_VOICES[1]!.id, speech);
    expect(made).toEqual([
      `cartesia ${CARTESIA_VOICES[1]!.voiceUuid} de`,
      'xai eve de',
      `cartesia ${CARTESIA_VOICES[1]!.voiceUuid} -`,
    ]);
  });
});

describe('voice note language', () => {
  const answer = () =>
    new Response(
      JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'hola' }] }] } }),
    );

  it('Deepgram nova-3 hears the given language, English by default', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(answer()));
    const transcribe = createPrerecordedTranscriber('k', fetcher);
    await transcribe(new Uint8Array([1]), 'audio/mp4');
    await transcribe(new Uint8Array([1]), 'audio/mp4', undefined, [], undefined, 'es');
    expect(
      fetcher.mock.calls.map(([url]) => new URL(url as string).searchParams.get('language')),
    ).toEqual(['en', 'es']);
  });

  it('xAI hears the given language', async () => {
    let form: FormData | undefined;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return Promise.resolve(Response.json({ text: 'hola' }));
    }) as unknown as typeof fetch;
    await transcribeWithXai('k', new Uint8Array([1]), 'audio/mp4', [], {
      fetch: fetchImpl,
      language: 'es',
    });
    expect(form?.get('language')).toBe('es');
  });
});

describe('voice list languages', () => {
  it('Deepgram voices speak English; Cartesia and Grok voices speak every language', () => {
    const { voices } = voiceList({ cartesia: true, xai: true });
    for (const voice of voices) {
      expect(voice.languages).toEqual(
        voice.id.startsWith('flux-') ? ['en'] : [...SPEAKER_LANGUAGES],
      );
    }
  });
});
