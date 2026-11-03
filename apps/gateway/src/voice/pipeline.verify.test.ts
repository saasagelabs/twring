import { describe, expect, it } from 'vitest';

import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import { createFailoverTts } from './failover-tts';
import { VoicePipeline } from './pipeline';
import { FakeSttProvider, FakeTtsProvider } from './testing';
import {
  VoiceProviderError,
  type SttEvent,
  type SttProvider,
  type TtsEvent,
  type TtsProvider,
  type VoiceError,
} from './types';

const lost = { code: 'connection_lost', recoverable: true } as const;
const FRAME_BYTES = 1920; // 960 samples of 48 kHz linear16

function setup(stt: SttProvider, tts: TtsProvider) {
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const speech: string[] = [];
  const played: number[] = [];
  const fatal: VoiceError[] = [];
  const pipeline = new VoicePipeline({
    callId: 'call_aaaaaaaaaaaaaaaaaaaa',
    stt,
    tts,
    scheduler,
    logger,
    onUserSpeechStarted: () => undefined,
    onUserSpeechDiscarded: () => undefined,
    onUserTurn: () => undefined,
    onCaption: () => undefined,
    onSpeech: (s) => speech.push(`${s.generationId}:${s.state}`),
    playFrames: (frames) => played.push(frames.length),
    stopPlayback: () => 0,
    onFatal: (e) => fatal.push(e),
  });
  return { pipeline, scheduler, logger, speech, played, fatal };
}

function failover() {
  const primary = new FakeTtsProvider();
  const backup = new FakeTtsProvider();
  const reasons: string[] = [];
  const tts = createFailoverTts(primary, backup, { onFailover: (r) => reasons.push(r) });
  return { primary, backup, tts, reasons };
}

describe('voice failover: audio continuity (verifier)', () => {
  it('plays the next reply through the backup and reports the broken generation failed once', async () => {
    const { primary, backup, tts, reasons } = failover();
    const { pipeline, scheduler, speech, played } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    const gen1 = pipeline.beginSpeech(0);
    pipeline.appendSpeech(gen1, 'hello');
    primary.send({ type: 'audio', generationId: gen1, bytes: new Uint8Array(FRAME_BYTES) });
    expect(played).toEqual([1]);
    primary.send({ type: 'error', error: { code: 'connection_lost', recoverable: false } });
    expect(speech).toEqual([`${gen1}:failed`]);
    expect(reasons).toEqual(['connection_lost']);
    // Late events from the dead primary session reach nobody.
    primary.send({ type: 'audio', generationId: gen1, bytes: new Uint8Array(FRAME_BYTES) });
    primary.send({ type: 'done', generationId: gen1 });
    primary.send({ type: 'error', error: lost });
    expect(played).toEqual([1]);
    expect(speech).toEqual([`${gen1}:failed`]);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    const gen2 = pipeline.beginSpeech(scheduler.now());
    pipeline.appendSpeech(gen2, 'again');
    pipeline.endSpeech(gen2);
    expect(backup.calls).toEqual([`speak ${gen2} again`, `flush ${gen2}`]);
    expect(primary.calls.filter((c) => c.includes(gen2))).toEqual([]);
    // Primary audio for the new generation is dropped; backup audio plays.
    primary.send({ type: 'audio', generationId: gen2, bytes: new Uint8Array(FRAME_BYTES) });
    expect(played).toEqual([1]);
    backup.send({ type: 'audio', generationId: gen2, bytes: new Uint8Array(FRAME_BYTES) });
    expect(played).toEqual([1, 1]);
    expect(speech.filter((s) => s.startsWith(gen1))).toEqual([`${gen1}:failed`]);
    await pipeline.close();
  });
});

describe('voice failover: exactly once (verifier)', () => {
  it('a burst of primary errors gives one switch, one reconnect, and never reopens the primary', async () => {
    const { primary, backup, tts, reasons } = failover();
    const { pipeline, scheduler, logger } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    for (let i = 0; i < 5; i += 1) primary.send({ type: 'error', error: lost });
    expect(reasons).toHaveLength(1);
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    expect(primary.opens).toBe(1);
    expect(primary.closed).toBeGreaterThanOrEqual(1); // wrapper and pipeline both close; idempotent
    expect(logger.names().filter((n) => n === 'tts_reconnected')).toHaveLength(1);
    await pipeline.close();
  });

  it('a primary error arriving after the backup is live does not switch again or reopen anything', async () => {
    const { primary, backup, tts, reasons } = failover();
    const { pipeline, scheduler } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    primary.send({ type: 'error', error: lost });
    scheduler.advance(250);
    await flushMicrotasks();
    primary.send({ type: 'error', error: lost });
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    expect(reasons).toHaveLength(1);
    await pipeline.close();
  });
});

describe('voice failover: give up (verifier)', () => {
  it('backup session errors follow the normal schedule, then fatal; no loop back to primary', async () => {
    const { primary, backup, tts } = failover();
    const { pipeline, scheduler, fatal } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    primary.send({ type: 'error', error: lost });
    for (const delay of [250, 1000, 3000]) {
      expect(fatal).toEqual([]);
      scheduler.advance(delay);
      await flushMicrotasks();
      backup.send({ type: 'error', error: lost });
    }
    expect(fatal).toEqual([{ code: 'connection_lost', recoverable: false }]);
    expect(backup.opens).toBe(3);
    expect(primary.opens).toBe(1);
    scheduler.advance(60_000);
    await flushMicrotasks();
    expect(backup.opens).toBe(3);
    expect(fatal).toHaveLength(1);
    await pipeline.close();
  });

  it('a backup that cannot connect at all gives up after the schedule', async () => {
    const { primary, backup, tts } = failover();
    const { pipeline, scheduler, fatal } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    backup.open = () => {
      backup.opens += 1;
      return Promise.reject(new VoiceProviderError(lost));
    };
    primary.send({ type: 'error', error: lost });
    for (const delay of [250, 1000, 3000]) {
      scheduler.advance(delay);
      await flushMicrotasks();
    }
    expect(fatal).toEqual([{ code: 'connection_lost', recoverable: false }]);
    expect(backup.opens).toBe(3);
    expect(primary.opens).toBe(1);
    scheduler.advance(60_000);
    expect(scheduler.pending).toBe(1); // only the STT keepalive interval
    await pipeline.close();
    expect(scheduler.pending).toBe(0);
  });

  it('primary and backup both failing to open at the start retries on the schedule then throws', async () => {
    const { primary, backup, tts } = failover();
    const reject = (p: FakeTtsProvider) => () => {
      p.opens += 1;
      return Promise.reject(new VoiceProviderError(lost));
    };
    primary.open = reject(primary);
    backup.open = reject(backup);
    const stt = new FakeSttProvider();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    const rejected = expect(opening).rejects.toBeInstanceOf(VoiceProviderError);
    await flushMicrotasks();
    for (const delay of [250, 1000, 3000]) {
      scheduler.advance(delay);
      await flushMicrotasks();
    }
    await rejected;
    expect(primary.opens).toBe(1); // never retried after the switch
    expect(backup.opens).toBe(4);
    expect(stt.closed).toBe(1);
    expect(scheduler.pending).toBe(0);
  });
});

describe('start-of-call retries (verifier)', () => {
  it('STT failing recoverably twice then succeeding starts the call', async () => {
    const stt = new FakeSttProvider();
    let fails = 2;
    const real = stt.open.bind(stt);
    stt.open = (onEvent: (e: SttEvent) => void) => {
      if (fails-- > 0) {
        stt.opens += 1;
        return Promise.reject(new VoiceProviderError(lost));
      }
      return real(onEvent);
    };
    const { pipeline, scheduler } = setup(stt, new FakeTtsProvider());
    const opening = pipeline.start();
    await flushMicrotasks();
    scheduler.advance(250);
    await flushMicrotasks();
    scheduler.advance(1000);
    await opening;
    expect(stt.opens).toBe(3);
    await pipeline.close();
    expect(scheduler.pending).toBe(0);
  });

  it('exhausted retries throw the original error object', async () => {
    const stt = new FakeSttProvider();
    const original = new VoiceProviderError(lost);
    stt.open = () => Promise.reject(original);
    const { pipeline, scheduler } = setup(stt, new FakeTtsProvider());
    const opening = pipeline.start();
    const settled = opening.then(
      () => undefined,
      (e: unknown) => e,
    );
    await flushMicrotasks();
    for (const delay of [250, 1000, 3000]) {
      scheduler.advance(delay);
      await flushMicrotasks();
    }
    expect(await settled).toBe(original);
  });

  it('a non-VoiceProviderError is not retried', async () => {
    const stt = new FakeSttProvider();
    stt.open = () => {
      stt.opens += 1;
      return Promise.reject(new Error('boom'));
    };
    const { pipeline, scheduler } = setup(stt, new FakeTtsProvider());
    await expect(pipeline.start()).rejects.toThrow('boom');
    expect(stt.opens).toBe(1);
    expect(scheduler.pending).toBe(0);
  });

  it('hang-up during a retry wait settles promptly with nothing open and no timers', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = lost;
    const tts = new FakeTtsProvider();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    expect(scheduler.pending).toBe(1);
    await pipeline.close();
    await opening;
    expect(scheduler.pending).toBe(0);
    expect(tts.closed).toBe(1);
    expect(stt.opens).toBe(1);
  });

  it('STT retrying while TTS is open: TTS is opened once, stays open and is used', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = lost;
    const tts = new FakeTtsProvider();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    expect(tts.closed).toBe(0);
    scheduler.advance(250);
    await opening;
    expect(tts.opens).toBe(1);
    expect(tts.closed).toBe(0);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'hi');
    expect(tts.calls).toEqual([`speak ${id} hi`]);
    await pipeline.close();
    expect(tts.closed).toBe(1);
  });

  it('a TTS session that breaks while STT is still retrying is replaced, not kept dead', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = lost;
    const { primary, backup, tts } = failover();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    primary.send({ type: 'error', error: lost }); // reconnect due at 250 ms
    scheduler.advance(250); // STT retry and TTS reconnect both fire
    await flushMicrotasks();
    await opening;
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'hi');
    expect(backup.calls).toEqual([`speak ${id} hi`]);
    expect(primary.calls).toEqual([]);
    await pipeline.close();
    expect(backup.closed).toBe(1);
  });

  it('a TTS reconnect that finishes before a slow STT retry is not overwritten by the dead session', async () => {
    const stt = new FakeSttProvider();
    let fails = 2;
    const real = stt.open.bind(stt);
    stt.open = (onEvent: (e: SttEvent) => void) =>
      fails-- > 0 ? Promise.reject(new VoiceProviderError(lost)) : real(onEvent);
    const { primary, backup, tts } = failover();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    primary.send({ type: 'error', error: lost });
    scheduler.advance(250); // TTS reconnected on the backup; STT still retrying
    await flushMicrotasks();
    scheduler.advance(1000);
    await opening;
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'hi');
    expect(backup.calls).toEqual([`speak ${id} hi`]);
    expect(primary.calls).toEqual([]);
    await pipeline.close();
  });
});

describe('abort during backup open (verifier)', () => {
  it('closes the backup session when the call ends while it opens', async () => {
    const primary = new FakeTtsProvider();
    primary.failNextOpen = lost;
    let release: (() => void) | undefined;
    const backup = new FakeTtsProvider();
    const realOpen = backup.open.bind(backup);
    backup.open = (onEvent: (e: TtsEvent) => void) =>
      new Promise((resolve, reject) => {
        release = () => {
          realOpen(onEvent).then(resolve, reject);
        };
      });
    const tts = createFailoverTts(primary, backup, { onFailover: () => undefined });
    const { pipeline, scheduler } = setup(new FakeSttProvider(), tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    await pipeline.close();
    release?.();
    await opening;
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    expect(backup.closed).toBe(1);
    expect(scheduler.pending).toBe(0);
  });
});
