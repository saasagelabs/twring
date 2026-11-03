import { describe, expect, it } from 'vitest';

import { FakeTtsProvider } from '../voice/testing';

import { createTtsRouter } from './tts-router';
import { CARTESIA_VOICES } from './voices';

const DEEPGRAM = { apiKey: 'dg-key', ttsModel: 'flux-haley-en' };
const CARTESIA = { apiKey: 'ct-key', ttsModel: 'sonic-3.6' };
const cartesiaId = CARTESIA_VOICES[0]!.id;
const signal = () => new AbortController().signal;

function build(cartesia?: typeof CARTESIA) {
  const made: string[] = [];
  const providers: FakeTtsProvider[] = [];
  const logged: Record<string, unknown>[] = [];
  const fallbacks: string[] = [];
  const router = createTtsRouter({
    deepgram: DEEPGRAM,
    cartesia,
    logger: { info: () => undefined, warn: (f) => logged.push(f) },
    onCartesiaFallback: (id) => fallbacks.push(id),
    createDeepgram: (o) => {
      made.push(`dg ${o.model}`);
      const p = new FakeTtsProvider();
      providers.push(p);
      return p;
    },
    createCartesia: (o) => {
      made.push(`ct ${o.voice.voiceUuid}`);
      const p = new FakeTtsProvider();
      providers.push(p);
      return p;
    },
  });
  return { router, made, providers, logged, fallbacks };
}

describe('tts router failover (verifier)', () => {
  it('creates no backup provider until the primary fails', async () => {
    const { router, made } = build(CARTESIA);
    const tts = router.forCall(cartesiaId);
    expect(made).toHaveLength(1);
    await (await tts.open(() => undefined, signal())).close();
    expect(made).toHaveLength(1);
    router.forCall('flux-kit-en');
    expect(made).toHaveLength(2);
  });

  it('a mid-call Cartesia error makes the next open use Deepgram and logs one tts_failover', async () => {
    const { router, providers, logged, made } = build(CARTESIA);
    const tts = router.forCall(cartesiaId);
    const events: unknown[] = [];
    await tts.open((e) => events.push(e), signal());
    providers[0]!.send({ type: 'error', error: { code: 'connection_lost', recoverable: false } });
    providers[0]!.send({ type: 'error', error: { code: 'connection_lost', recoverable: false } });
    await tts.open(() => undefined, signal());
    expect(made).toEqual([expect.stringMatching(/^ct /), 'dg flux-haley-en']);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: 'tts_failover', reason_code: 'connection_lost' });
    expect(providers[0]!.opens).toBe(1);
    expect(providers[1]!.opens).toBe(1);
  });

  it('forSample is never wrapped: the raw provider is returned', () => {
    const { router, providers } = build(CARTESIA);
    const sample = router.forSample(cartesiaId);
    expect(sample).toBe(providers[0]);
    expect(router.forSample('flux-kit-en')).toBe(providers[1]);
  });

  it('a Deepgram voice without Cartesia and an unknown voice are not wrapped', () => {
    const none = build();
    expect(none.router.forCall('flux-kit-en')).toBe(none.providers[0]);
    const withCartesia = build(CARTESIA);
    expect(withCartesia.router.forCall('retired-voice')).toBe(withCartesia.providers[0]);
  });

  it('a Cartesia voice without Cartesia configured is plain Deepgram, with the fallback logged once', () => {
    const { router, providers, made, fallbacks } = build();
    expect(router.forCall(cartesiaId)).toBe(providers[0]);
    router.forCall(cartesiaId);
    expect(made).toEqual(['dg flux-haley-en', 'dg flux-haley-en']);
    expect(fallbacks).toEqual([cartesiaId]);
  });
});
