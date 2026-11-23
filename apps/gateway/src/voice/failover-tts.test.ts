import { describe, expect, it } from 'vitest';

import { flushMicrotasks } from '../calls/testing';

import { FakeTtsProvider } from './testing';
import { createFailoverTts } from './failover-tts';
import { VoiceProviderError, type TtsEvent, type VoiceError } from './types';

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

describe('a dropped primary is reopened first', () => {
  const signal = () => new AbortController().signal;

  it.each([
    ['a lost connection', lost],
    // Deepgram's Interrupt that is never confirmed (a barge-in can trigger it).
    ['an unconfirmed interrupt', { code: 'provider_error', recoverable: true } as const],
  ])('%s: error passed unchanged, the next session is the primary', async (_name, error) => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    await provider.open((event) => events.push(event), signal());
    primary.send({ type: 'error', error });
    expect(events).toEqual([{ type: 'error', error }]);
    expect(primary.closed).toBe(1);
    await provider.open(() => undefined, signal());
    expect(provider.name).toBe('fake-tts');
    expect(primary.opens).toBe(2);
    expect(backup.opens).toBe(0);
    expect(reasons).toEqual([]);
  });

  it('a primary error reconnecting cannot cure still moves to the backup', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    await provider.open((event) => events.push(event), signal());
    primary.send({ type: 'error', error: auth });
    expect(events).toEqual([{ type: 'error', error: { ...auth, recoverable: true } }]);
    expect(reasons).toEqual(['auth_failed']);
    await provider.open(() => undefined, signal());
    expect(backup.opens).toBe(1);
  });

  it('a primary that cannot be reopened moves to the backup', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    await provider.open(() => undefined, signal());
    primary.send({ type: 'error', error: lost });
    primary.failNextOpen = lost;
    await provider.open(() => undefined, signal());
    expect(backup.opens).toBe(1);
    expect(reasons).toEqual(['connection_lost']);
  });
});

describe('one answer the primary cannot speak goes to the backup', () => {
  const signal = () => new AbortController().signal;
  const busy = { code: 'provider_error', recoverable: true, providerStatus: 500 } as const;
  const quota = { code: 'provider_error', recoverable: true, providerStatus: 429 } as const;
  const audio = (generationId: string): TtsEvent => ({
    type: 'audio',
    generationId,
    bytes: new Uint8Array(4),
  });

  async function setup(failsOver?: (error: VoiceError) => boolean) {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const events: TtsEvent[] = [];
    const reasons: string[] = [];
    let restored = 0;
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
      onRestored: () => (restored += 1),
      ...(failsOver && { failsOver }),
    });
    const session = await provider.open((event) => events.push(event), signal());
    return { primary, backup, events, reasons, session, provider, restored: () => restored };
  }

  it('the first failure is left to the one retry; the failed retry is spoken on the backup', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello ');
    p.session.speak('g1', 'there.');
    p.session.flush('g1');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: busy });
    expect(p.events).toEqual([{ type: 'generation_error', generationId: 'g1', error: busy }]);
    p.events.length = 0;
    p.session.speak('g1_retry', 'Hello there.');
    p.session.flush('g1_retry');
    p.primary.send({ type: 'generation_error', generationId: 'g1_retry', error: busy });
    await flushMicrotasks();
    expect(p.events).toEqual([]);
    expect(p.reasons).toEqual(['generation_500']);
    expect(p.backup.calls).toEqual(['speak g1_retry Hello there.', 'flush g1_retry']);
    p.backup.send(audio('g1_retry'));
    p.backup.send({ type: 'done', generationId: 'g1_retry' });
    expect(p.events.map((e) => e.type)).toEqual(['audio', 'done']);
    expect(p.provider.name).toBe('fake-tts');
    // The next answer is the primary's again.
    p.session.speak('g2', 'Next.');
    expect(p.primary.calls.at(-1)).toBe('speak g2 Next.');
    expect(p.backup.calls).toHaveLength(2);
    expect(p.restored()).toBe(0);
    p.primary.send(audio('g2'));
    expect(p.restored()).toBe(1);
  });

  it('a 429 is not retried: it goes to the backup at once, text that arrives later too', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello ');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    p.session.speak('g1', 'there.');
    p.session.flush('g1');
    await flushMicrotasks();
    expect(p.events).toEqual([]);
    expect(p.reasons).toEqual(['generation_429']);
    expect(p.backup.calls).toEqual(['speak g1 Hello ', 'speak g1 there.', 'flush g1']);
    expect(p.primary.calls).toContain('cancel g1');
  });

  it('the backup failing the answer too is reported as a failed answer', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello.');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    await flushMicrotasks();
    p.backup.send({ type: 'generation_error', generationId: 'g1', error: busy });
    expect(p.events).toEqual([{ type: 'generation_error', generationId: 'g1', error: busy }]);
  });

  it('a backup that cannot open fails the answer', async () => {
    const p = await setup();
    p.backup.failNextOpen = lost;
    p.session.speak('g1', 'Hello.');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    await flushMicrotasks();
    expect(p.events).toEqual([
      { type: 'generation_error', generationId: 'g1', error: { ...lost, recoverable: false } },
    ]);
  });

  it('an answer that already made a sound stays on the primary', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello.');
    p.primary.send(audio('g1'));
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    await flushMicrotasks();
    expect(p.events.at(-1)).toEqual({ type: 'generation_error', generationId: 'g1', error: quota });
    expect(p.backup.opens).toBe(0);
  });

  it("keeps a refused own key's answer failure", async () => {
    const p = await setup((error) => error.code !== 'auth_failed');
    p.session.speak('g1', 'Hello.');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: auth });
    await flushMicrotasks();
    expect(p.events).toEqual([{ type: 'generation_error', generationId: 'g1', error: auth }]);
    expect(p.backup.opens).toBe(0);
  });

  it('a stalled answer is left to the retry first, then spoken on the backup', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello.');
    p.session.flush('g1');
    expect(p.session.stalled?.('g1')).toBe(false);
    p.session.speak('g1_retry', 'Hello.');
    p.session.flush('g1_retry');
    expect(p.session.stalled?.('g1_retry')).toBe(true);
    await flushMicrotasks();
    expect(p.reasons).toEqual(['stalled']);
    expect(p.primary.calls).toContain('cancel g1_retry');
    expect(p.backup.calls).toEqual(['speak g1_retry Hello.', 'flush g1_retry']);
    // Stalled on the backup as well: nothing left to try.
    expect(p.session.stalled?.('g1_retry')).toBe(false);
  });

  it('a cancel (barge-in) of an answer on the backup stops the backup, late audio dropped', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello.');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    await flushMicrotasks();
    p.backup.send(audio('g1'));
    p.session.cancel('g1');
    await flushMicrotasks();
    expect(p.backup.calls.at(-1)).toBe('cancel g1');
    p.backup.send(audio('g1'));
    p.primary.send(audio('g1'));
    expect(p.events.filter((e) => e.type === 'audio')).toHaveLength(1);
  });

  it('closing the session closes the backup it opened', async () => {
    const p = await setup();
    p.session.speak('g1', 'Hello.');
    p.primary.send({ type: 'generation_error', generationId: 'g1', error: quota });
    await flushMicrotasks();
    await p.session.close();
    expect(p.primary.closed).toBe(1);
    expect(p.backup.closed).toBe(1);
  });
});
