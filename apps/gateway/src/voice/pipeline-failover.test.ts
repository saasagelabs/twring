import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import { createFailoverTts } from './failover-tts';
import { VoicePipeline } from './pipeline';
import { FakeSttProvider, FakeTtsProvider } from './testing';
import type { TtsEvent } from './types';

const busy = { code: 'provider_error', recoverable: true, providerStatus: 500 } as const;
const frameBytes = () => new Uint8Array(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);
const audio = (generationId: string): TtsEvent => ({
  type: 'audio',
  generationId,
  bytes: frameBytes(),
});

/** A call whose voice has a backup, with playout the test drives by hand. */
async function setup() {
  const primary = new FakeTtsProvider();
  const backup = new FakeTtsProvider();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const fatal: string[] = [];
  const speech: string[] = [];
  const failovers: string[] = [];
  let queue: { frames: number; callbacks: Record<string, (() => void) | undefined> }[] = [];
  let published = 0;
  let stops = 0;
  const pipeline = new VoicePipeline({
    callId: 'call_aaaaaaaaaaaaaaaaaaaa',
    stt: new FakeSttProvider(),
    tts: createFailoverTts(primary, backup, { onFailover: (reason) => failovers.push(reason) }),
    scheduler,
    logger,
    onUserSpeechStarted: () => undefined,
    onUserSpeechDiscarded: () => undefined,
    onUserTurn: () => undefined,
    onCaption: () => undefined,
    onSpeech: (event) => speech.push(event.state),
    playFrames: (frames, callbacks) => queue.push({ frames: frames.length, callbacks }),
    stopPlayback: () => {
      stops += 1;
      const dropped = queue.reduce((sum, item) => sum + item.frames, 0);
      queue = [];
      return dropped;
    },
    onFatal: (error, which) => fatal.push(`${which} ${error.code}`),
  });
  await pipeline.start();
  /** Publishes everything queued, in order, as the room would. */
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
    fatal,
    speech,
    failovers,
    drain,
    published: () => published,
    stops: () => stops,
  };
}

describe('VoicePipeline with a backup voice', () => {
  it('an answer the primary fails twice (500) is spoken on the backup; the call goes on', async () => {
    const p = await setup();
    for (const turn of [1, 2]) {
      const id = p.pipeline.beginSpeech(0);
      p.pipeline.appendSpeech(id, `Answer ${turn}.`);
      p.pipeline.endSpeech(id);
      p.primary.send({ type: 'generation_error', generationId: id, error: busy });
      p.scheduler.advance(250);
      p.primary.send({ type: 'generation_error', generationId: `${id}_retry`, error: busy });
      await flushMicrotasks();
      expect(p.backup.calls.slice(-2)).toEqual([
        `speak ${id}_retry Answer ${turn}.`,
        `flush ${id}_retry`,
      ]);
      p.backup.send(audio(`${id}_retry`));
      p.backup.send({ type: 'done', generationId: `${id}_retry` });
      p.drain();
    }
    expect(p.speech).toEqual(['playing', 'finished', 'playing', 'finished']);
    expect(p.fatal).toEqual([]);
    expect(p.failovers).toEqual(['generation_500', 'generation_500']);
    // Only one backup session for the whole call.
    expect(p.backup.opens).toBe(1);
    await p.pipeline.close();
    expect(p.backup.closed).toBe(1);
  });

  it('an answer that makes no sound is retried by the watchdog, then spoken on the backup', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hello.');
    p.pipeline.endSpeech(id);
    p.scheduler.advance(4999);
    expect(p.logger.names()).not.toContain('tts_watchdog');
    p.scheduler.advance(1);
    expect(p.logger.names().filter((name) => name === 'tts_watchdog')).toHaveLength(1);
    expect(p.primary.calls).toContain(`cancel ${id}`);
    p.scheduler.advance(250);
    expect(p.primary.calls.slice(-2)).toEqual([`speak ${id}_retry Hello.`, `flush ${id}_retry`]);
    p.scheduler.advance(5000);
    await flushMicrotasks();
    expect(p.failovers).toEqual(['stalled']);
    expect(p.backup.calls).toEqual([`speak ${id}_retry Hello.`, `flush ${id}_retry`]);
    p.backup.send(audio(`${id}_retry`));
    p.backup.send({ type: 'done', generationId: `${id}_retry` });
    p.drain();
    expect(p.speech).toEqual(['playing', 'finished']);
    expect(p.fatal).toEqual([]);
  });

  it('a backup that stays silent too fails the answer, not the call', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hello.');
    p.pipeline.endSpeech(id);
    p.scheduler.advance(5000 + 250 + 5000);
    await flushMicrotasks();
    p.scheduler.advance(5000);
    expect(p.speech).toEqual(['failed']);
    expect(p.fatal).toEqual([]);
  });

  it('the watchdog waits for the end of the text, and stands down once audio arrives', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Let me check that.');
    p.scheduler.advance(20_000);
    p.pipeline.endSpeech(id);
    p.scheduler.advance(1000);
    p.primary.send(audio(id));
    p.scheduler.advance(20_000);
    expect(p.logger.names()).not.toContain('tts_watchdog');
  });

  it('a generation error after audio plays out what arrived, then reports the answer failed', async () => {
    const p = await setup();
    const id = p.pipeline.beginSpeech(0);
    p.pipeline.appendSpeech(id, 'Hello there. More words.');
    p.pipeline.endSpeech(id);
    p.primary.send(audio(id));
    p.primary.send(audio(id));
    p.primary.send({ type: 'generation_error', generationId: id, error: busy });
    expect(p.stops()).toBe(0);
    expect(p.speech).toEqual([]);
    p.drain();
    expect(p.published()).toBe(2);
    expect(p.speech).toEqual(['playing', 'failed']);
    // Late audio of the failed answer is not played.
    p.primary.send(audio(id));
    p.drain();
    expect(p.published()).toBe(2);
    expect(p.fatal).toEqual([]);
  });

  describe('a barge-in still stops the audio', () => {
    it('of an answer spoken on the backup', async () => {
      const p = await setup();
      const id = p.pipeline.beginSpeech(0);
      p.pipeline.appendSpeech(id, 'Hello.');
      p.primary.send({
        type: 'generation_error',
        generationId: id,
        error: { ...busy, providerStatus: 429 },
      });
      await flushMicrotasks();
      p.backup.send(audio(id));
      p.pipeline.cancelSpeech('barge_in');
      await flushMicrotasks();
      expect(p.stops()).toBe(1);
      expect(p.backup.calls.at(-1)).toBe(`cancel ${id}`);
      p.backup.send(audio(id));
      p.drain();
      expect(p.published()).toBe(0);
    });

    it('while the watchdog waits: no retry, no failover', async () => {
      const p = await setup();
      const id = p.pipeline.beginSpeech(0);
      p.pipeline.appendSpeech(id, 'Hello.');
      p.pipeline.endSpeech(id);
      p.scheduler.advance(3000);
      p.pipeline.cancelSpeech('barge_in');
      p.scheduler.advance(20_000);
      await flushMicrotasks();
      expect(p.logger.names()).not.toContain('tts_watchdog');
      expect(p.primary.calls.filter((c) => c.startsWith('speak'))).toHaveLength(1);
      expect(p.backup.opens).toBe(0);
    });

    it('of what plays out after a late generation error', async () => {
      const p = await setup();
      const id = p.pipeline.beginSpeech(0);
      p.pipeline.appendSpeech(id, 'Hello there.');
      p.pipeline.endSpeech(id);
      p.primary.send(audio(id));
      p.primary.send({ type: 'generation_error', generationId: id, error: busy });
      p.pipeline.cancelSpeech('barge_in');
      expect(p.stops()).toBe(1);
      p.drain();
      expect(p.published()).toBe(0);
      expect(p.speech).toEqual([]);
    });
  });
});
