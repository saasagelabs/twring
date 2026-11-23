import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import { createFailoverTts } from './failover-tts';
import { VoicePipeline } from './pipeline';
import { FakeSttProvider, FakeTtsProvider } from './testing';
import type { TtsEvent, TtsProvider } from './types';

const busy = { code: 'provider_error', recoverable: true, providerStatus: 500 } as const;
const quota = { code: 'provider_error', recoverable: true, providerStatus: 429 } as const;
const lost = { code: 'connection_lost', recoverable: true } as const;
const frameBytes = () => new Uint8Array(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);
const audio = (generationId: string): TtsEvent => ({
  type: 'audio',
  generationId,
  bytes: frameBytes(),
});

/** A backup whose open waits until the test lets it through. */
function gated(inner: FakeTtsProvider): { provider: TtsProvider; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    provider: {
      name: inner.name,
      async open(onEvent) {
        await gate;
        return inner.open(onEvent);
      },
    },
    release: () => release(),
  };
}

async function setup(backupProvider?: TtsProvider) {
  const primary = new FakeTtsProvider();
  const backup = new FakeTtsProvider();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const speech: string[] = [];
  const failovers: string[] = [];
  const fatal: string[] = [];
  let queue: { frames: number; callbacks: Record<string, (() => void) | undefined> }[] = [];
  let published = 0;
  const pipeline = new VoicePipeline({
    callId: 'call_aaaaaaaaaaaaaaaaaaaa',
    stt: new FakeSttProvider(),
    tts: createFailoverTts(primary, backupProvider ?? backup, {
      onFailover: (reason) => failovers.push(reason),
    }),
    scheduler,
    logger,
    onUserSpeechStarted: () => undefined,
    onUserSpeechDiscarded: () => undefined,
    onUserTurn: () => undefined,
    onCaption: () => undefined,
    onSpeech: (event) => speech.push(`${event.state}${event.cutOff === true ? ' cutoff' : ''}`),
    playFrames: (frames, callbacks) => queue.push({ frames: frames.length, callbacks }),
    stopPlayback: () => {
      const dropped = queue.reduce((sum, item) => sum + item.frames, 0);
      queue = [];
      return dropped;
    },
    onFatal: (error, which) => fatal.push(`${which} ${error.code}`),
  });
  await pipeline.start();
  const drain = () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.frames > 0) item.callbacks.onFirstPublished?.();
      published += item.frames;
      if (item.frames > 0) item.callbacks.onLastPublished?.();
      item.callbacks.onDone?.();
    }
  };
  return {
    pipeline,
    primary,
    backup,
    scheduler,
    logger,
    speech,
    failovers,
    fatal,
    drain,
    published: () => published,
  };
}

describe('verify: failover barge-in and duplicate speech', () => {
  it('a barge-in while the backup is still opening: nothing is spoken on it, late frames dropped', async () => {
    const backup = new FakeTtsProvider();
    const gate = gated(backup);
    const p = await setup(gate.provider);
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hello.');
    p.pipeline.endSpeech(id);
    p.primary.send({ type: 'generation_error', generationId: id, error: quota });
    expect(p.failovers).toEqual(['generation_429']);
    p.pipeline.cancelSpeech('barge_in');
    gate.release();
    await flushMicrotasks();
    expect(backup.calls.filter((c) => c.startsWith('speak'))).toEqual([]);
    backup.send(audio(id));
    backup.send({ type: 'done', generationId: id });
    p.drain();
    expect(p.published()).toBe(0);
    expect(p.speech).toEqual([]);
  });

  it('an answer that made a sound on the primary is never replayed from its start', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'One. Two. Three.');
    p.pipeline.endSpeech(id);
    p.primary.send(audio(id));
    p.primary.send({ type: 'generation_error', generationId: id, error: busy });
    p.scheduler.advance(20_000);
    await flushMicrotasks();
    p.drain();
    expect(p.backup.opens).toBe(0);
    expect(p.primary.calls.filter((c) => c.startsWith('speak'))).toEqual([
      `speak ${id} One. Two. Three.`,
    ]);
    expect(p.speech).toEqual(['playing', 'failed cutoff']);
  });

  it('a primary that recovers while the backup speaks the answer: its late audio is dropped', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hello.');
    p.pipeline.endSpeech(id);
    p.primary.send({ type: 'generation_error', generationId: id, error: quota });
    await flushMicrotasks();
    p.backup.send(audio(id));
    p.primary.send(audio(id));
    p.primary.send({ type: 'done', generationId: id });
    p.backup.send({ type: 'done', generationId: id });
    p.drain();
    expect(p.published()).toBe(1);
    expect(p.speech).toEqual(['playing', 'finished']);
  });

  it('the retry id never doubles its suffix', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hi.');
    p.pipeline.endSpeech(id);
    p.scheduler.advance(5000 + 250 + 5000 + 5000);
    await flushMicrotasks();
    const ids = [...p.primary.calls, ...p.backup.calls].join(' ');
    expect(ids).not.toContain('_retry_retry');
  });

  it('the backup session closes when the call ends', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hi.');
    p.primary.send({ type: 'generation_error', generationId: id, error: quota });
    await flushMicrotasks();
    await p.pipeline.close();
    expect(p.backup.opens).toBe(1);
    expect(p.backup.closed).toBe(1);
    expect(p.pipeline.retainedState().timers).toBe(0);
  });
});

describe('verify: a primary that drops on every answer', () => {
  it('moves to the backup after 3 drops with no finished answer in between', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const reasons: string[] = [];
    const provider = createFailoverTts(primary, backup, {
      onFailover: (reason) => reasons.push(reason),
    });
    const signal = new AbortController().signal;
    for (let i = 0; i < 6; i += 1) {
      await provider.open(() => undefined, signal);
      primary.send({ type: 'error', error: lost });
    }
    expect(primary.opens).toBe(3);
    expect(reasons).toEqual(['primary_unstable']);
    expect(backup.opens).toBe(3);
  });

  it('a drop after a finished answer starts the count again', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const provider = createFailoverTts(primary, backup, { onFailover: () => undefined });
    const signal = new AbortController().signal;
    for (let i = 0; i < 6; i += 1) {
      const session = await provider.open(() => undefined, signal);
      session.speak(`g${i}`, 'Hi.');
      primary.send({ type: 'done', generationId: `g${i}` });
      primary.send({ type: 'error', error: lost });
    }
    expect(primary.opens).toBe(6);
    expect(backup.opens).toBe(0);
  });
});
