import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import { createDeepgramStt } from './deepgram-stt';
import { createDeepgramTts } from './deepgram-tts';
import { createFailoverTts } from './failover-tts';
import { VoicePipeline } from './pipeline';
import { FakeSttProvider, FakeTtsProvider, fakeSocketFactory } from './testing';
import { VoiceProviderError, type SttProvider, type TtsProvider } from './types';

describe('VoicePipeline first connection', () => {
  const lost = { code: 'connection_lost', recoverable: true } as const;
  function setup(stt: SttProvider, tts: TtsProvider = new FakeTtsProvider()) {
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
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
      onSpeech: () => undefined,
      playFrames: () => undefined,
      stopPlayback: () => 0,
      onFatal: () => undefined,
    });
    return { pipeline, scheduler, logger };
  }

  it('retries a recoverable first STT failure and starts', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = lost;
    const { pipeline, scheduler, logger } = setup(stt);
    const opening = pipeline.start();
    await flushMicrotasks();
    expect(logger.events.find((e) => e.fields.event === 'stt_connect_retry')?.fields.attempt).toBe(
      1,
    );
    scheduler.advance(250);
    await opening;
    expect(stt.opens).toBe(2);
    await pipeline.close();
  });

  it('retries a recoverable first TTS failure and starts', async () => {
    const tts = new FakeTtsProvider();
    tts.failNextOpen = lost;
    const { pipeline, scheduler, logger } = setup(new FakeSttProvider(), tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    expect(logger.events.find((e) => e.fields.event === 'tts_connect_retry')?.fields.attempt).toBe(
      1,
    );
    scheduler.advance(250);
    await opening;
    expect(tts.opens).toBe(2);
    await pipeline.close();
  });

  it('stops after the reconnect schedule and closes the other side', async () => {
    const stt = new FakeSttProvider();
    stt.open = () => {
      stt.opens += 1;
      return Promise.reject(new VoiceProviderError(lost));
    };
    const tts = new FakeTtsProvider();
    const { pipeline, scheduler, logger } = setup(stt, tts);
    const opening = pipeline.start();
    const rejected = expect(opening).rejects.toBeInstanceOf(VoiceProviderError);
    await flushMicrotasks();
    for (const delay of [250, 1000, 3000]) {
      scheduler.advance(delay);
      await flushMicrotasks();
    }
    await rejected;
    expect(stt.opens).toBe(4);
    expect(logger.names().filter((name) => name === 'stt_connect_retry')).toHaveLength(3);
    expect(tts.closed).toBe(1);
  });

  it('throws a non-recoverable first error without scheduling a retry', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = { code: 'auth_failed', recoverable: false };
    const { pipeline, scheduler, logger } = setup(stt);
    await expect(pipeline.start()).rejects.toBeInstanceOf(VoiceProviderError);
    expect(stt.opens).toBe(1);
    expect(logger.names()).not.toContain('stt_connect_retry');
    expect(scheduler.pending).toBe(0);
  });

  it('hang-up cancels a pending retry and closes the opened side', async () => {
    const stt = new FakeSttProvider();
    stt.failNextOpen = lost;
    const tts = new FakeTtsProvider();
    const { pipeline, scheduler } = setup(stt, tts);
    const opening = pipeline.start();
    await flushMicrotasks();
    await pipeline.close();
    await opening;
    scheduler.advance(10_000);
    expect(stt.opens).toBe(1);
    expect(tts.closed).toBe(1);
    expect(scheduler.pending).toBe(0);
  });

  it('reconnects a dropped primary TTS session on the backup', async () => {
    const primary = new FakeTtsProvider();
    const backup = new FakeTtsProvider();
    const tts = createFailoverTts(primary, backup, { onFailover: () => undefined });
    const { pipeline, scheduler } = setup(new FakeSttProvider(), tts);
    await pipeline.start();
    primary.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    scheduler.advance(250);
    await flushMicrotasks();
    expect(backup.opens).toBe(1);
    expect(primary.opens).toBe(1);
    await pipeline.close();
    expect(backup.closed).toBe(1);
  });
});

async function started() {
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const pipeline = new VoicePipeline({
    callId: 'call_aaaaaaaaaaaaaaaaaaaa',
    stt: new FakeSttProvider(),
    tts: new FakeTtsProvider(),
    scheduler,
    logger,
    onUserSpeechStarted: () => undefined,
    onUserSpeechDiscarded: () => undefined,
    onUserTurn: () => undefined,
    onCaption: () => undefined,
    onSpeech: () => undefined,
    playFrames: () => undefined,
    stopPlayback: () => 0,
    onFatal: () => undefined,
  });
  await pipeline.start();
  return { pipeline, scheduler, logger };
}

const loud = new Int16Array(SAMPLES_PER_FRAME).fill(8000); // about -12 dBFS
const quiet = new Int16Array(SAMPLES_PER_FRAME).fill(300); // about -41 dBFS

describe('VoicePipeline caller voice onset (barge-in telemetry)', () => {
  it('records when the caller first gets loud over active speech', async () => {
    const { pipeline, scheduler } = await started();
    pipeline.pushCallerAudio(loud);
    expect(pipeline.callerOnsetAt()).toBeUndefined(); // nothing is being spoken
    scheduler.advance(1000);
    pipeline.beginSpeech(scheduler.now());
    pipeline.pushCallerAudio(quiet);
    expect(pipeline.callerOnsetAt()).toBeUndefined();
    pipeline.pushCallerAudio(loud);
    scheduler.advance(20);
    pipeline.pushCallerAudio(loud);
    expect(pipeline.callerOnsetAt()).toBe(1000);
  });

  it('keeps the onset through short pauses and resets it after about 300 ms of quiet', async () => {
    const { pipeline, scheduler } = await started();
    pipeline.beginSpeech(0);
    pipeline.pushCallerAudio(loud);
    for (let i = 0; i < 14; i += 1) pipeline.pushCallerAudio(quiet); // 280 ms
    expect(pipeline.callerOnsetAt()).toBe(0);
    pipeline.pushCallerAudio(loud); // speech again: the pause does not count
    for (let i = 0; i < 14; i += 1) pipeline.pushCallerAudio(quiet);
    expect(pipeline.callerOnsetAt()).toBe(0);
    pipeline.pushCallerAudio(quiet); // 300 ms of quiet
    expect(pipeline.callerOnsetAt()).toBeUndefined();
    scheduler.advance(500);
    pipeline.pushCallerAudio(loud);
    expect(pipeline.callerOnsetAt()).toBe(500);
  });

  it('forgets the onset when speech is cancelled, and logs why it was', async () => {
    const { pipeline, logger } = await started();
    const id = pipeline.beginSpeech(0);
    pipeline.pushCallerAudio(loud);
    pipeline.cancelSpeech('barge_in');
    expect(pipeline.callerOnsetAt()).toBeUndefined();
    expect(logger.events.map((e) => e.fields)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'tts_cancelled', generation_id: id, reason: 'barge_in' }),
        expect.objectContaining({ event: 'tts_stopped', generation_id: id, dropped_ms: 0 }),
      ]),
    );
  });

  it('logs tts_stopped only for a barge-in', async () => {
    const { pipeline, logger } = await started();
    pipeline.beginSpeech(0);
    pipeline.cancelSpeech('superseded');
    expect(logger.names()).toContain('tts_cancelled');
    expect(logger.names()).not.toContain('tts_stopped');
  });
});

/** A pipeline whose playout the test drives: queued frames and their callbacks are recorded. */
async function recorded(tts: TtsProvider = new FakeTtsProvider()) {
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const stt = new FakeSttProvider();
  const queued: {
    frames: Int16Array[];
    callbacks: { onFirstPublished?: () => void; onDone?: () => void };
  }[] = [];
  const speech: string[] = [];
  let stops = 0;
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
    onSpeech: ({ generationId, state }) => speech.push(`${generationId} ${state}`),
    playFrames: (frames, callbacks) => queued.push({ frames, callbacks }),
    stopPlayback: () => {
      stops += 1;
      const dropped = queued.reduce((n, q) => n + q.frames.length, 0);
      queued.length = 0;
      return dropped;
    },
    onFatal: () => undefined,
  });
  await pipeline.start();
  return { pipeline, scheduler, logger, stt, queued, speech, stops: () => stops };
}

/** 20 ms of 48 kHz linear16 audio. */
const frameBytes = () => new Uint8Array(new Int16Array(SAMPLES_PER_FRAME).fill(1000).buffer);

describe('VoicePipeline after a barge-in (verifier)', () => {
  it('late audio and done for the cut generation are dropped, and its markers report nothing', async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, queued, speech } = await recorded(tts);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'Hello there.');
    pipeline.endSpeech(id);
    tts.send({ type: 'audio', generationId: id, bytes: frameBytes() });
    tts.send({ type: 'done', generationId: id });
    // Playout callbacks the transport captured before the cut (a real pump may still run them).
    const callbacks = queued.map((q) => q.callbacks);
    expect(callbacks.some((c) => c.onDone !== undefined)).toBe(true);
    pipeline.cancelSpeech('barge_in');
    for (const c of callbacks) {
      c.onFirstPublished?.();
      c.onDone?.();
    }
    tts.send({ type: 'audio', generationId: id, bytes: frameBytes() });
    tts.send({ type: 'done', generationId: id });
    expect(queued).toEqual([]);
    expect(speech).toEqual([]); // neither 'playing' nor 'finished' for a cancelled generation
  });

  it("a cut generation's in-flight frame never reports playing, and the next one still does", async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, queued, speech } = await recorded(tts);
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'One.');
    tts.send({ type: 'audio', generationId: first, bytes: frameBytes() });
    const inFlight = queued[0]!.callbacks;
    pipeline.cancelSpeech('barge_in');
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Two.');
    inFlight.onFirstPublished?.(); // the old frame lands after the cut
    tts.send({ type: 'audio', generationId: second, bytes: frameBytes() });
    queued.at(-1)!.callbacks.onFirstPublished?.();
    expect(speech).toEqual([`${second} playing`]);
  });

  it('cancelling twice, or with nothing active, logs one cancellation and stops playback once', async () => {
    const { pipeline, logger, stops } = await recorded();
    pipeline.cancelSpeech('barge_in');
    expect(stops()).toBe(0);
    pipeline.beginSpeech(0);
    pipeline.cancelSpeech('barge_in');
    pipeline.cancelSpeech('superseded');
    expect(stops()).toBe(1);
    expect(logger.names().filter((n) => n === 'tts_cancelled')).toHaveLength(1);
  });

  it('dropped_ms is the queued speech audio the barge-in discarded, partial frame included', async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, logger } = await recorded(tts);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'A long answer.');
    const threeAndAHalf = new Int16Array(SAMPLES_PER_FRAME * 3.5).fill(1000);
    tts.send({ type: 'audio', generationId: id, bytes: new Uint8Array(threeAndAHalf.buffer) });
    pipeline.cancelSpeech('barge_in');
    expect(logger.events.find((e) => e.fields.event === 'tts_stopped')?.fields).toMatchObject({
      generation_id: id,
      dropped_ms: 70,
    });
    expect(logger.events.some((e) => 'stop_ms' in e.fields)).toBe(false);
  });
});

describe('VoicePipeline onset tracking (verifier)', () => {
  it('a new generation starts with no onset carried over from the one that was cut', async () => {
    const { pipeline, scheduler } = await recorded();
    pipeline.beginSpeech(0);
    pipeline.pushCallerAudio(loud);
    pipeline.cancelSpeech('barge_in');
    scheduler.advance(2000);
    pipeline.beginSpeech(scheduler.now());
    expect(pipeline.callerOnsetAt()).toBeUndefined();
    scheduler.advance(40);
    pipeline.pushCallerAudio(loud);
    expect(pipeline.callerOnsetAt()).toBe(2040);
  });

  it('forgets the onset once the generation has finished playing out', async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, queued } = await recorded(tts);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'Hi.');
    pipeline.endSpeech(id);
    pipeline.pushCallerAudio(loud);
    expect(pipeline.callerOnsetAt()).toBe(0);
    tts.send({ type: 'done', generationId: id });
    queued.at(-1)!.callbacks.onDone?.();
    pipeline.pushCallerAudio(loud); // no speech active any more
    expect(pipeline.callerOnsetAt()).toBeUndefined();
  });

  it('the onset is never later than now, so detect_ms is never negative', async () => {
    const { pipeline, scheduler } = await recorded();
    pipeline.beginSpeech(0);
    for (let i = 0; i < 50; i += 1) {
      pipeline.pushCallerAudio(i % 7 < 3 ? loud : quiet);
      scheduler.advance(20);
      const onset = pipeline.callerOnsetAt();
      if (onset !== undefined) {
        expect(Number.isFinite(onset)).toBe(true);
        expect(scheduler.now() - onset).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('a frame exactly at the threshold does not count as voice; one just above does', async () => {
    const { pipeline } = await recorded();
    pipeline.beginSpeech(0);
    // -35 dBFS peak is 32768 * 10^(-35/20), about 582.7.
    pipeline.pushCallerAudio(new Int16Array(SAMPLES_PER_FRAME).fill(582));
    expect(pipeline.callerOnsetAt()).toBeUndefined();
    pipeline.pushCallerAudio(new Int16Array(SAMPLES_PER_FRAME).fill(600));
    expect(pipeline.callerOnsetAt()).toBe(0);
  });
});

describe('VoicePipeline with Deepgram Flux TTS after a barge-in (verifier)', () => {
  async function deepgram() {
    const factory = fakeSocketFactory();
    const tts = createDeepgramTts({
      apiKey: 'test-key',
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
    });
    const ctx = await recorded(tts);
    return { ...ctx, socket: factory.sockets[0]!, factory };
  }
  const played = (queued: { frames: Int16Array[] }[]) =>
    queued.reduce((n, q) => n + q.frames.length, 0);

  it('audio still in flight for the cut generation is dropped; the next answer plays in full', async () => {
    const { pipeline, socket, queued, speech } = await deepgram();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'A long answer.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(frameBytes());
    pipeline.cancelSpeech('barge_in');
    expect(socket.jsonSent()).toContainEqual({ type: 'Interrupt' });
    expect(queued).toEqual([]);
    socket.receive(frameBytes()); // late, from the interrupted turn
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Okay.');
    pipeline.endSpeech(second);
    socket.receive(frameBytes()); // still before the provider confirmed: dropped
    socket.receive({ type: 'SpeechInterrupted', audio_played_ms: 20 });
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(frameBytes());
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(played(queued)).toBe(1);
    queued.at(-1)!.callbacks.onFirstPublished?.();
    queued.at(-1)!.callbacks.onDone?.();
    expect(speech).toEqual([`${second} playing`, `${second} finished`]);
  });

  it('cutting speech the provider already finished sends no Interrupt, so the next answer is not muted', async () => {
    const { pipeline, socket, queued } = await deepgram();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'Short.');
    pipeline.endSpeech(first);
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(frameBytes());
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // all delivered, still playing out
    pipeline.cancelSpeech('barge_in');
    expect(socket.jsonSent()).not.toContainEqual({ type: 'Interrupt' });
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Next.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(frameBytes());
    expect(played(queued)).toBe(1);
  });

  it('a barge-in racing the end of synthesis: the late SpeechMetadata ends the discard', async () => {
    const { pipeline, socket, queued } = await deepgram();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'Short.');
    pipeline.endSpeech(first);
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    pipeline.cancelSpeech('barge_in'); // the provider had already finished: its metadata is in flight
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Next.');
    socket.receive({ type: 'Warning', code: 'NOTHING_TO_INTERRUPT' }); // the no-op Interrupt
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(frameBytes());
    expect(socket.closedWith).toBeUndefined();
    expect(played(queued)).toBe(1);
  });

  // If Flux TTS sends SpeechMetadata for a turn it already reported as SpeechInterrupted, the
  // session matches its speech_id to the interrupted turn rather than taking it as the NEXT
  // generation's completion (which would drop the next answer's audio as stray bytes).
  it('metadata for the interrupted turn is not mistaken for the next answer finishing', async () => {
    const { pipeline, socket, queued } = await deepgram();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'A long answer.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    pipeline.cancelSpeech('barge_in');
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Okay.');
    pipeline.endSpeech(second);
    socket.receive({ type: 'SpeechInterrupted', audio_played_ms: 20 });
    socket.receive({ type: 'SpeechMetadata', speech_id: 's1' }); // for the interrupted turn
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(frameBytes());
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    expect(played(queued)).toBe(1);
  });
});

describe('VoicePipeline STT drop mid-utterance', () => {
  async function withStt() {
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const seen: string[] = [];
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt,
      tts: new FakeTtsProvider(),
      scheduler,
      logger: recordingLogger(),
      onUserSpeechStarted: () => seen.push('started'),
      onUserSpeechDiscarded: () => seen.push('discarded'),
      onUserTurn: () => seen.push('turn'),
      onCaption: () => undefined,
      onSpeech: () => undefined,
      playFrames: () => undefined,
      stopPlayback: () => 0,
      onFatal: () => seen.push('fatal'),
    });
    await pipeline.start();
    return { scheduler, stt, seen };
  }
  const lost = { type: 'error', error: { code: 'connection_lost', recoverable: true } } as const;

  it('reports the utterance in progress as discarded, once, when STT drops', async () => {
    const { scheduler, stt, seen } = await withStt();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send(lost);
    expect(seen).toEqual(['started', 'discarded']);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(stt.opens).toBe(2);
    stt.send(lost); // the caller was not talking this time
    expect(seen).toEqual(['started', 'discarded']);
  });

  it('reports nothing for an utterance already committed, and discards before a fatal error', async () => {
    const { stt, seen } = await withStt();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hi' });
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    expect(seen).toEqual(['started', 'turn', 'started', 'discarded', 'fatal']);
  });
});

describe('VoicePipeline STT drop mid-utterance, second pass (verifier)', () => {
  async function withDeepgramStt() {
    const scheduler = new ManualScheduler();
    const factory = fakeSocketFactory();
    const seen: string[] = [];
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt: createDeepgramStt({ apiKey: 'k', model: 'flux-general-en', socketFactory: factory }),
      tts: new FakeTtsProvider(),
      scheduler,
      logger: recordingLogger(),
      onUserSpeechStarted: () => seen.push('started'),
      onUserSpeechDiscarded: () => seen.push('discarded'),
      onUserTurn: (text) => seen.push(`turn ${text}`),
      onCaption: () => undefined,
      onSpeech: () => undefined,
      playFrames: () => undefined,
      stopPlayback: () => 0,
      onFatal: () => seen.push('fatal'),
    });
    await pipeline.start();
    return { pipeline, scheduler, factory, seen };
  }
  const info = (event: string, transcript = '') => ({
    type: 'TurnInfo',
    event,
    turn_index: 0,
    transcript,
  });

  it('a provider Error then the socket close report the utterance discarded once', async () => {
    const { factory, seen } = await withDeepgramStt();
    const socket = factory.sockets[0]!;
    socket.receive(info('StartOfTurn'));
    socket.receive({ type: 'Error', description: 'x' });
    socket.drop(1011);
    expect(seen).toEqual(['started', 'discarded']);
  });

  it('a TTS error while the caller is mid-utterance discards nothing', async () => {
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    const seen: string[] = [];
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt,
      tts,
      scheduler,
      logger: recordingLogger(),
      onUserSpeechStarted: () => seen.push('started'),
      onUserSpeechDiscarded: () => seen.push('discarded'),
      onUserTurn: () => seen.push('turn'),
      onCaption: () => undefined,
      onSpeech: () => undefined,
      playFrames: () => undefined,
      stopPlayback: () => 0,
      onFatal: () => undefined,
    });
    await pipeline.start();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    tts.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    expect(seen).toEqual(['started']);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hi' });
    expect(seen).toEqual(['started', 'turn']);
  });

  it('after the discard, a drop of the reconnected session with nobody talking reports nothing', async () => {
    const { factory, scheduler, seen } = await withDeepgramStt();
    factory.sockets[0]!.receive(info('StartOfTurn'));
    factory.sockets[0]!.drop(1006);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(factory.sockets).toHaveLength(2);
    factory.sockets[1]!.drop(1006); // nobody talking on the new session
    expect(seen).toEqual(['started', 'discarded']);
  });

  // A Deepgram STT "error" from a malformed or Error message leaves that socket OPEN; the pipeline
  // drops its reference and reconnects without closing it. The stale session keeps delivering
  // events: the utterance just reported discarded is then committed anyway (discard, then commit,
  // for one utterance), and the stale socket's eventual close tears down the healthy new session.
  it('after an STT protocol error, the stale session is closed and cannot commit the discarded utterance', async () => {
    const { factory, scheduler, seen } = await withDeepgramStt();
    const stale = factory.sockets[0]!;
    stale.receive(info('StartOfTurn'));
    stale.receive('{not json');
    expect(seen).toEqual(['started', 'discarded']);
    expect.soft(stale.closedWith).toBeDefined();
    stale.receive(info('EndOfTurn', 'book it'));
    expect.soft(seen).toEqual(['started', 'discarded']);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(factory.sockets).toHaveLength(2);
    stale.drop(1006); // the forgotten socket finally closes
    await flushMicrotasks();
    scheduler.advance(5000);
    await flushMicrotasks();
    expect(factory.sockets).toHaveLength(2); // the healthy session was not replaced
  });
});

describe('VoicePipeline session sequencing with Deepgram sockets, third pass (verifier)', () => {
  async function both(opts: { autoTts?: boolean } = {}) {
    const scheduler = new ManualScheduler();
    const sttFactory = fakeSocketFactory();
    const ttsFactory = fakeSocketFactory(opts.autoTts ?? true);
    const ackTimers: { fire: () => void; cleared: boolean }[] = [];
    const queued: {
      frames: Int16Array[];
      callbacks: { onFirstPublished?: () => void; onDone?: () => void };
    }[] = [];
    const seen: string[] = [];
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt: createDeepgramStt({ apiKey: 'k', model: 'flux-general-en', socketFactory: sttFactory }),
      tts: createDeepgramTts({
        apiKey: 'k',
        model: 'flux-haley-en',
        socketFactory: ttsFactory,
        setInterval: () => () => undefined,
        setTimeout: (callback) => {
          const timer = {
            cleared: false,
            fire: () => {
              if (timer.cleared) return;
              timer.cleared = true;
              callback();
            },
          };
          ackTimers.push(timer);
          return () => {
            timer.cleared = true;
          };
        },
      }),
      scheduler,
      logger: recordingLogger(),
      onUserSpeechStarted: () => seen.push('started'),
      onUserSpeechDiscarded: () => seen.push('discarded'),
      onUserTurn: (text) => seen.push(`turn ${text}`),
      onCaption: () => undefined,
      onSpeech: ({ generationId, state }) => seen.push(`${generationId} ${state}`),
      playFrames: (frames, callbacks) => queued.push({ frames, callbacks }),
      stopPlayback: () => {
        const dropped = queued.reduce((n, q) => n + q.frames.length, 0);
        queued.length = 0;
        return dropped;
      },
      onFatal: (error) => seen.push(`fatal ${error.code}`),
    });
    const starting = pipeline.start();
    await flushMicrotasks();
    if (opts.autoTts === false) ttsFactory.sockets[0]!.acceptConnection();
    await starting;
    const liveAck = () => ackTimers.filter((t) => !t.cleared);
    /** Plays out everything queued so far. */
    const playOut = () => {
      for (const q of queued.splice(0)) {
        q.callbacks.onFirstPublished?.();
        q.callbacks.onDone?.();
      }
    };
    return { pipeline, scheduler, sttFactory, ttsFactory, seen, queued, liveAck, playOut };
  }
  const info = (event: string, transcript = '') => ({
    type: 'TurnInfo',
    event,
    turn_index: 0,
    transcript,
  });

  it("after a TTS reconnect the new session's audio and done reach the next generation", async () => {
    const { pipeline, scheduler, ttsFactory, seen, queued, playOut } = await both();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'Hello.');
    ttsFactory.sockets[0]!.drop(1006);
    expect(seen).toEqual([`${first} failed`]);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(2);
    const fresh = ttsFactory.sockets[1]!;
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Again.');
    pipeline.endSpeech(second);
    expect(fresh.jsonSent()).toEqual([{ type: 'Speak', text: 'Again.' }, { type: 'Flush' }]);
    fresh.receive({ type: 'SpeechStarted', speech_id: 's1' });
    fresh.receive(frameBytes());
    fresh.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    expect(queued.reduce((n, q) => n + q.frames.length, 0)).toBe(1);
    playOut();
    expect(seen).toEqual([`${first} failed`, `${second} playing`, `${second} finished`]);
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(2);
  });

  it('a TTS reconnect that fails once, then succeeds: the third session is live, nothing doubled', async () => {
    const { pipeline, scheduler, ttsFactory, seen, queued } = await both({ autoTts: false });
    ttsFactory.sockets[0]!.drop(1006);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(2);
    ttsFactory.sockets[1]!.rejectConnection('refused');
    await flushMicrotasks();
    expect(scheduler.pending).toBe(2); // the STT keepalive, and exactly one reconnect scheduled
    scheduler.advance(1000);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(3);
    ttsFactory.sockets[2]!.acceptConnection();
    await flushMicrotasks();
    // Late noise from the two dead sockets changes nothing.
    ttsFactory.sockets[0]!.receive({ type: 'Error' });
    ttsFactory.sockets[1]!.receive({ type: 'Error' });
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'Back.');
    pipeline.endSpeech(id);
    const live = ttsFactory.sockets[2]!;
    live.receive({ type: 'SpeechStarted', speech_id: 's1' });
    live.receive(frameBytes());
    live.receive({ type: 'SpeechMetadata', speech_id: 's1' });
    expect(queued.reduce((n, q) => n + q.frames.length, 0)).toBe(1);
    expect(seen.filter((s) => s.startsWith('fatal'))).toEqual([]);
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(3);
  });

  it('after an STT reconnect the stale session cannot commit, and the new one does', async () => {
    const { scheduler, sttFactory, seen } = await both();
    const stale = sttFactory.sockets[0]!;
    stale.drop(1006);
    scheduler.advance(250);
    await flushMicrotasks();
    const fresh = sttFactory.sockets[1]!;
    stale.receive(info('StartOfTurn'));
    stale.receive(info('EndOfTurn', 'stale words'));
    fresh.receive(info('StartOfTurn'));
    fresh.receive(info('EndOfTurn', 'fresh words'));
    expect(seen).toEqual(['started', 'turn fresh words']);
  });

  it('a stale TTS session closed by the pipeline reports no error that would restart a reconnect', async () => {
    const { pipeline, scheduler, ttsFactory } = await both();
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'Hi.');
    ttsFactory.sockets[0]!.receive('{not json'); // fail(): closes 1011 and reports once
    expect(ttsFactory.sockets[0]!.closedWith).toBe(1011);
    expect(scheduler.pending).toBe(2); // the STT keepalive and the reconnect
    scheduler.advance(250);
    await flushMicrotasks();
    ttsFactory.sockets[0]!.drop(1006); // the old socket's close event, again
    expect(scheduler.pending).toBe(1); // only the STT keepalive
    expect(ttsFactory.sockets).toHaveLength(2);
  });

  it('the ack timeout drops the session, fails the waiting answer, and the next answer plays', async () => {
    const { pipeline, scheduler, ttsFactory, seen, queued, liveAck } = await both();
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'Long answer.');
    pipeline.cancelSpeech('barge_in');
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Okay.');
    pipeline.endSpeech(second);
    expect(liveAck()).toHaveLength(1);
    liveAck()[0]!.fire(); // Flux never answered the Interrupt
    expect(seen).toEqual([`${second} failed`]);
    expect(ttsFactory.sockets[0]!.closedWith).toBe(1011);
    scheduler.advance(250);
    await flushMicrotasks();
    const third = pipeline.beginSpeech(0);
    pipeline.appendSpeech(third, 'Retry.');
    pipeline.endSpeech(third);
    ttsFactory.sockets[1]!.receive({ type: 'SpeechStarted', speech_id: 's9' });
    ttsFactory.sockets[1]!.receive(frameBytes());
    ttsFactory.sockets[1]!.receive({ type: 'SpeechMetadata', speech_id: 's9' });
    expect(queued.reduce((n, q) => n + q.frames.length, 0)).toBe(1);
    expect(liveAck()).toEqual([]);
  });

  // Pipeline-level consequence of the unacknowledged-Interrupt bug in the TTS session: the next
  // answer's own turn is taken as the acknowledgement, its audio is dropped, and the pipeline never
  // hears 'finished' or 'failed' for it. The conversation's turn then never completes.
  it('an Interrupt Flux never answers does not leave the next answer neither finished nor failed', async () => {
    const { pipeline, ttsFactory, seen, liveAck, playOut } = await both();
    const socket = ttsFactory.sockets[0]!;
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'Long answer.');
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    pipeline.cancelSpeech('barge_in');
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Okay.');
    pipeline.endSpeech(second);
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(frameBytes());
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    playOut();
    for (const timer of liveAck()) timer.fire();
    expect(seen.includes(`${second} finished`) || seen.includes(`${second} failed`)).toBe(true);
  });

  it('closing the pipeline during a pending reconnect opens nothing afterwards', async () => {
    const { pipeline, scheduler, ttsFactory, sttFactory } = await both();
    ttsFactory.sockets[0]!.drop(1006);
    sttFactory.sockets[0]!.drop(1006);
    await pipeline.close();
    scheduler.advance(10_000);
    await flushMicrotasks();
    expect(ttsFactory.sockets).toHaveLength(1);
    expect(sttFactory.sockets).toHaveLength(1);
  });
});

describe('VoicePipeline playout position for the echo window (verifier)', () => {
  type Callbacks = {
    onFirstPublished?: () => void;
    onLastPublished?: () => void;
    onDone?: () => void;
  };
  const frames = (n: number) =>
    new Uint8Array(new Int16Array(SAMPLES_PER_FRAME * n).fill(1000).buffer);

  it('a chunk counts as played when its last frame is published; total is known only after done', async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, queued } = await recorded(tts);
    const id = pipeline.beginSpeech(0);
    pipeline.appendSpeech(id, 'Hello there.');
    tts.send({ type: 'audio', generationId: id, bytes: frames(3) });
    tts.send({ type: 'audio', generationId: id, bytes: frames(1) }); // one-frame chunk
    expect(pipeline.playedMs(id)).toBe(0);
    expect(pipeline.totalAudioMs(id)).toBeUndefined();
    const cb = (i: number) => queued[i]!.callbacks as Callbacks;
    cb(0).onFirstPublished?.();
    expect(pipeline.playedMs(id)).toBe(0); // first frame of three: not counted yet
    cb(0).onLastPublished?.();
    expect(pipeline.playedMs(id)).toBe(60);
    cb(1).onLastPublished?.();
    expect(pipeline.playedMs(id)).toBe(80);
    // Half a frame left in the assembler is padded into one more frame by done.
    tts.send({ type: 'audio', generationId: id, bytes: frames(0.5) });
    pipeline.endSpeech(id);
    tts.send({ type: 'done', generationId: id });
    expect(pipeline.totalAudioMs(id)).toBe(100);
    cb(queued.length - 1).onLastPublished?.();
    expect(pipeline.playedMs(id)).toBe(100);
  });

  it('a cut freezes the position: dropped chunks never count; other generations are separate', async () => {
    const tts = new FakeTtsProvider();
    const { pipeline, queued } = await recorded(tts);
    const first = pipeline.beginSpeech(0);
    pipeline.appendSpeech(first, 'One.');
    tts.send({ type: 'audio', generationId: first, bytes: frames(2) });
    (queued[0]!.callbacks as Callbacks).onLastPublished?.();
    tts.send({ type: 'audio', generationId: first, bytes: frames(5) });
    pipeline.cancelSpeech('barge_in'); // clears the queue: the 5-frame chunk never publishes
    expect(pipeline.playedMs(first)).toBe(40);
    expect(pipeline.totalAudioMs(first)).toBeUndefined();
    const second = pipeline.beginSpeech(0);
    pipeline.appendSpeech(second, 'Two.');
    tts.send({ type: 'audio', generationId: second, bytes: frames(1) });
    (queued.at(-1)!.callbacks as Callbacks).onLastPublished?.();
    expect(pipeline.playedMs(first)).toBe(40);
    expect(pipeline.playedMs(second)).toBe(20);
  });

  it('forgets playout after 8 newer generations (0, undefined), never throws', async () => {
    const { pipeline } = await recorded();
    const first = pipeline.beginSpeech(0);
    for (let i = 0; i < 8; i += 1) pipeline.beginSpeech(0);
    expect(pipeline.playedMs(first)).toBe(0);
    expect(pipeline.totalAudioMs(first)).toBeUndefined();
    expect(pipeline.playedMs('gen_unknown')).toBe(0);
  });
});

describe('VoicePipeline turn timing (how long the owner spoke, how long Twring waited)', () => {
  async function withStt() {
    const stt = new FakeSttProvider();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const pipeline = new VoicePipeline({
      callId: 'call_aaaaaaaaaaaaaaaaaaaa',
      stt,
      tts: new FakeTtsProvider(),
      scheduler,
      logger,
      onUserSpeechStarted: () => undefined,
      onUserSpeechDiscarded: () => undefined,
      onUserTurn: () => undefined,
      onCaption: () => undefined,
      onSpeech: () => undefined,
      playFrames: () => undefined,
      stopPlayback: () => 0,
      onFatal: () => undefined,
    });
    await pipeline.start();
    const committed = () =>
      logger.events.filter((e) => e.fields.event === 'turn_committed').map((e) => e.fields);
    return { stt, scheduler, committed };
  }

  it('logs how long the owner spoke and how quiet it was before the turn was committed', async () => {
    const { stt, scheduler, committed } = await withStt();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    scheduler.advance(1_000);
    stt.send({ type: 'partial', turnIndex: 0, text: 'check the' });
    scheduler.advance(2_000);
    stt.send({ type: 'partial', turnIndex: 0, text: 'check the build please' });
    scheduler.advance(1_200);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'check the build please' });
    expect(committed()).toEqual([
      expect.objectContaining({ speech_ms: 4_200, quiet_ms: 1_200, words: 4 }),
    ]);
  });

  it('discarded speech leaves no timing behind for a later turn', async () => {
    const { stt, scheduler, committed } = await withStt();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send({ type: 'partial', turnIndex: 0, text: 'um' });
    scheduler.advance(2_000);
    stt.send({ type: 'speech_discarded', turnIndex: 0 });
    scheduler.advance(5_000);
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'hello there' });
    expect(committed()[0]).not.toHaveProperty('speech_ms');
    expect(committed()[0]).not.toHaveProperty('quiet_ms');
  });

  it('each turn is timed on its own', async () => {
    const { stt, scheduler, committed } = await withStt();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    scheduler.advance(500);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'yes' });
    scheduler.advance(10_000);
    stt.send({ type: 'speech_started', turnIndex: 1 });
    scheduler.advance(300);
    stt.send({ type: 'partial', turnIndex: 1, text: 'no' });
    scheduler.advance(700);
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'no' });
    expect(committed()).toEqual([
      expect.objectContaining({ speech_ms: 500, words: 1 }),
      expect.objectContaining({ speech_ms: 1_000, quiet_ms: 700, words: 1 }),
    ]);
    expect(committed()[0]).not.toHaveProperty('quiet_ms');
  });
});
