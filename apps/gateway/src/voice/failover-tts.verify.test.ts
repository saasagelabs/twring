import { describe, expect, it } from 'vitest';

import { createFailoverTts } from './failover-tts';
import { FakeTtsProvider } from './testing';
import { VoiceProviderError, type TtsEvent, type TtsProvider } from './types';

const lost = { code: 'connection_lost', recoverable: true } as const;

describe('createFailoverTts (verifier)', () => {
  it('closes a primary session and throws when the call is aborted right after it opened', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const controller = new AbortController();
    const realOpen = primary.open.bind(primary);
    primary.open = async (onEvent: (e: TtsEvent) => void) => {
      const session = await realOpen(onEvent);
      controller.abort(new Error('hung up'));
      return session;
    };
    const provider = createFailoverTts(primary, backup, { onFailover: () => undefined });
    await expect(provider.open(() => undefined, controller.signal)).rejects.toThrow('hung up');
    expect(primary.closed).toBe(1);
    expect(backup.opens).toBe(0);
  });

  it('closes the backup session when the call is aborted while the backup opens', async () => {
    const primary = new FakeTtsProvider();
    primary.failNextOpen = lost;
    const backup = new FakeTtsProvider();
    const controller = new AbortController();
    const realOpen = backup.open.bind(backup);
    backup.open = async (onEvent: (e: TtsEvent) => void) => {
      const session = await realOpen(onEvent);
      controller.abort(new Error('hung up'));
      return session;
    };
    const provider = createFailoverTts(primary, backup, { onFailover: () => undefined });
    await expect(provider.open(() => undefined, controller.signal)).rejects.toThrow('hung up');
    expect(backup.closed).toBe(1);
  });

  it('does not loop: a backup open failure is thrown, and later opens use the backup only', async () => {
    const primary = new FakeTtsProvider();
    primary.failNextOpen = lost;
    const backup = new FakeTtsProvider();
    backup.failNextOpen = lost;
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, { onFailover: (r) => reasons.push(r) });
    await expect(
      provider.open(() => undefined, new AbortController().signal),
    ).rejects.toBeInstanceOf(VoiceProviderError);
    await provider.open(() => undefined, new AbortController().signal);
    expect(primary.opens).toBe(1);
    expect(backup.opens).toBe(2);
    expect(reasons).toHaveLength(1);
  });

  it('switches on a non-provider open error using connection_lost', async () => {
    const reasons: string[] = [];
    const primary: TtsProvider = { name: 'p', open: () => Promise.reject(new TypeError('dns')) };
    const backup = new FakeTtsProvider();
    const provider = createFailoverTts(primary, backup, { onFailover: (r) => reasons.push(r) });
    await provider.open(() => undefined, new AbortController().signal);
    expect(reasons).toEqual(['connection_lost']);
  });

  it('closes a primary session that errors before open() resolved', async () => {
    const events: TtsEvent[] = [];
    let closed = 0;
    const primary: TtsProvider = {
      name: 'p',
      open: (onEvent) => {
        onEvent({ type: 'error', error: lost });
        return Promise.resolve({
          speak: () => undefined,
          flush: () => undefined,
          cancel: () => undefined,
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        });
      },
    };
    const provider = createFailoverTts(primary, new FakeTtsProvider(), {
      onFailover: () => undefined,
    });
    const session = await provider.open((e) => events.push(e), new AbortController().signal);
    expect(events).toHaveLength(1);
    // The pipeline closes (or replaces) the session it was handed; nothing may stay open.
    await session.close();
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('a backup error before any switch from a late primary error is not re-marked recoverable', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const provider = createFailoverTts(primary, backup, { onFailover: () => undefined });
    await provider.open(() => undefined, new AbortController().signal);
    primary.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await provider.open((e) => events.push(e), new AbortController().signal);
    backup.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    expect(events).toEqual([{ type: 'error', error: { code: 'auth_failed', recoverable: false } }]);
  });
});
