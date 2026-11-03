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
