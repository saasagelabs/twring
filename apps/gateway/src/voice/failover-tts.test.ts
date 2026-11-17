import { describe, expect, it } from 'vitest';

import { FakeTtsProvider } from './testing';
import { createFailoverTts } from './failover-tts';
import { VoiceProviderError, type TtsEvent } from './types';

const lost = { code: 'connection_lost', recoverable: true } as const;
const auth = { code: 'auth_failed', recoverable: false } as const;

describe('per-call TTS failover', () => {
  it('uses the backup after a primary open failure and switches only once', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    primary.failNextOpen = auth;
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    const first = await provider.open(() => undefined, new AbortController().signal);
    expect(provider.name).toBe('fake-tts→fake-tts');
    expect(reasons).toEqual(['auth_failed']);
    await first.close();
    const second = await provider.open(() => undefined, new AbortController().signal);
    expect(primary.opens).toBe(1);
    expect(backup.opens).toBe(2);
    await second.close();
    expect(backup.closed).toBe(2);
  });

  it('makes a primary session error recoverable, closes it, and passes backup errors unchanged', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    await provider.open((event) => events.push(event), new AbortController().signal);
    primary.send({ type: 'error', error: auth });
    primary.send({ type: 'error', error: lost });
    expect(events).toEqual([{ type: 'error', error: { ...auth, recoverable: true } }]);
    expect(reasons).toEqual(['auth_failed']);
    expect(primary.closed).toBe(1);
    const session = await provider.open(
      (event) => events.push(event),
      new AbortController().signal,
    );
    backup.send({ type: 'error', error: auth });
    expect(events.at(-1)).toEqual({ type: 'error', error: auth });
    expect(primary.opens).toBe(1);
    expect(backup.closed).toBe(1);
    await session.close();
  });

  it('does not open the backup after aborting a pending primary open', async () => {
    const controller = new AbortController();
    const backup = new FakeTtsProvider();
    const reasons: string[] = [];
    const provider = createFailoverTts(
      {
        name: 'pending',
        open: (_onEvent, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new VoiceProviderError(lost)), {
              once: true,
            });
          }),
      },
      backup,
      { onFailover: (reason) => reasons.push(reason) },
    );
    const opening = provider.open(() => undefined, controller.signal);
    controller.abort();
    await expect(opening).rejects.toBeInstanceOf(VoiceProviderError);
    expect(backup.opens).toBe(0);
    expect(reasons).toEqual([]);
  });
});

describe("failover that keeps some failures (a person's own key)", () => {
  const keepRefusals = (error: { code: string }) => error.code !== 'auth_failed';

  it('keeps a refused key: no backup on open, and a session refusal passes unchanged', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    primary.failNextOpen = auth;
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
      failsOver: keepRefusals,
    });
    await expect(provider.open(() => undefined, new AbortController().signal)).rejects.toThrow();
    expect(backup.opens).toBe(0);

    const events: TtsEvent[] = [];
    await provider.open((event) => events.push(event), new AbortController().signal);
    primary.send({ type: 'error', error: auth });
    expect(events).toEqual([{ type: 'error', error: auth }]);
    expect(reasons).toEqual([]);
  });

  it('still fails over on a lost connection', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    primary.failNextOpen = lost;
    const provider = createFailoverTts(primary, backup, {
      onFailover: () => undefined,
      failsOver: keepRefusals,
    });
    await provider.open(() => undefined, new AbortController().signal);
    expect(backup.opens).toBe(1);
  });
});

describe('failover on a voice the provider cannot find', () => {
  const notFound = { code: 'provider_error', recoverable: true, providerStatus: 404 } as const;

  it('turns a 404 answer into a recoverable session error and uses the backup next', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    await provider.open((event) => events.push(event), new AbortController().signal);
    primary.send({ type: 'generation_error', generationId: 'g1', error: notFound });
    expect(events).toEqual([{ type: 'error', generationId: 'g1', error: notFound }]);
    expect(reasons).toEqual(['voice_not_found']);
    expect(primary.closed).toBe(1);
    await provider.open(() => undefined, new AbortController().signal);
    expect(backup.opens).toBe(1);
  });

  it('passes other failed answers through, and a 404 from the backup too', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const provider = createFailoverTts(primary, backup, { onFailover: () => undefined });
    await provider.open((event) => events.push(event), new AbortController().signal);
    const busy = { code: 'provider_error', recoverable: true, providerStatus: 500 } as const;
    primary.send({ type: 'generation_error', generationId: 'g1', error: busy });
    expect(events).toEqual([{ type: 'generation_error', generationId: 'g1', error: busy }]);
    expect(primary.closed).toBe(0);

    primary.send({ type: 'generation_error', generationId: 'g2', error: notFound });
    events.length = 0;
    await provider.open((event) => events.push(event), new AbortController().signal);
    backup.send({ type: 'generation_error', generationId: 'g3', error: notFound });
    expect(events).toEqual([{ type: 'generation_error', generationId: 'g3', error: notFound }]);
  });
});

describe('failover that reopens a dropped primary first (a non-English speaker)', () => {
  const signal = () => new AbortController().signal;

  it('a dropped primary session is reopened on the primary, error passed unchanged', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
      reopensPrimaryOnDrop: true,
    });
    await provider.open((event) => events.push(event), signal());
    primary.send({ type: 'error', error: lost });
    expect(events).toEqual([{ type: 'error', error: lost }]);
    expect(primary.closed).toBe(1);
    await provider.open(() => undefined, signal());
    expect(primary.opens).toBe(2);
    expect(backup.opens).toBe(0);
    expect(reasons).toEqual([]);
  });

  it('a primary that cannot be reopened moves to the backup', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
      reopensPrimaryOnDrop: true,
    });
    await provider.open(() => undefined, signal());
    primary.send({ type: 'error', error: lost });
    primary.failNextOpen = lost;
    await provider.open(() => undefined, signal());
    expect(backup.opens).toBe(1);
    expect(reasons).toEqual(['connection_lost']);
  });
});
