import { describe, expect, it } from 'vitest';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { ManualScheduler, flushMicrotasks, recordingLogger } from '../calls/testing';

import { VoicePipeline } from './pipeline';
import { SttBacklog } from './stt-backlog';
import { FakeSttProvider, FakeTtsProvider } from './testing';

const lost = { code: 'connection_lost', recoverable: true } as const;
/** One 20 ms, 48 kHz frame becomes 320 samples at 16 kHz. */
const SAMPLES_16K_PER_FRAME = 320;

async function started() {
  const stt = new FakeSttProvider();
  const scheduler = new ManualScheduler();
  const pipeline = new VoicePipeline({
    callId: 'call_aaaaaaaaaaaaaaaaaaaa',
    stt,
    tts: new FakeTtsProvider(),
    scheduler,
    logger: recordingLogger(),
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
  const frames = (count: number) => {
    for (let i = 0; i < count; i += 1) pipeline.pushCallerAudio(new Int16Array(SAMPLES_PER_FRAME));
  };
  return { stt, scheduler, pipeline, frames };
}

describe('caller audio while the hearing socket reconnects', () => {
  it('is held and sent first on the new session, nothing dropped under 2 s', async () => {
    const { stt, scheduler, pipeline, frames } = await started();
    frames(10);
    const before = stt.samplesReceived;
    stt.send({ type: 'error', error: lost });
    frames(50); // 1 s of caller speech while the socket is down
    expect(stt.samplesReceived).toBe(before);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(stt.opens).toBe(2);
    expect(stt.samplesReceived - before).toBe(50 * SAMPLES_16K_PER_FRAME);
    expect(pipeline.usage().sttAudioDroppedMs).toBe(0);
    await pipeline.close();
  });

  it('keeps only the newest 2 s and counts the older audio as dropped', async () => {
    const { stt, scheduler, pipeline, frames } = await started();
    const before = stt.samplesReceived;
    stt.send({ type: 'error', error: lost });
    frames(150); // 3 s
    scheduler.advance(250);
    await flushMicrotasks();
    expect(stt.samplesReceived - before).toBe(32_000);
    expect(pipeline.usage().sttAudioDroppedMs).toBe(1000);
    await pipeline.close();
  });

  it('nothing held from one drop is sent again after a later one', async () => {
    const { stt, scheduler, pipeline, frames } = await started();
    stt.send({ type: 'error', error: lost });
    frames(20);
    scheduler.advance(250);
    await flushMicrotasks();
    scheduler.advance(20_000);
    const afterFirst = stt.samplesReceived;
    stt.send({ type: 'error', error: lost });
    scheduler.advance(250);
    await flushMicrotasks();
    // The 20 frames held during the first drop are not replayed on the second session.
    expect(stt.samplesReceived - afterFirst).toBe(0);
    await pipeline.close();
  });

  it('hanging up during the reconnect releases the held audio', async () => {
    const { stt, pipeline, frames } = await started();
    stt.send({ type: 'error', error: lost });
    frames(20);
    expect(pipeline.retainedState().sttBacklog).toBe(20 * SAMPLES_16K_PER_FRAME);
    await pipeline.close();
    expect(pipeline.retainedState().sttBacklog).toBe(0);
  });
});

describe('SttBacklog', () => {
  it('drains oldest first across the wrap', () => {
    const backlog = new SttBacklog(4);
    backlog.push(Int16Array.from([1, 2, 3]));
    backlog.push(Int16Array.from([4, 5, 6]));
    expect(backlog.size).toBe(4);
    expect(backlog.droppedSamples).toBe(2);
    const out: number[] = [];
    backlog.drain((chunk) => out.push(...chunk));
    expect(out).toEqual([3, 4, 5, 6]);
    expect(backlog.size).toBe(0);
  });

  it('a push larger than capacity keeps its tail', () => {
    const backlog = new SttBacklog(3);
    backlog.push(Int16Array.from([1, 2, 3, 4, 5]));
    const out: number[] = [];
    backlog.drain((chunk) => out.push(...chunk));
    expect(out).toEqual([3, 4, 5]);
    expect(backlog.droppedSamples).toBe(2);
  });
});

describe('words pushed during a call', () => {
  it('reach the live session, and again the session after a reconnect', async () => {
    const { stt, scheduler, pipeline } = await started();
    expect(pipeline.updateKeyterms(['Twring', 'SaaSage'])).toBe(true);
    expect(stt.keytermUpdates).toEqual([['Twring', 'SaaSage']]);
    stt.send({ type: 'error', error: lost });
    expect(pipeline.updateKeyterms(['Twring', 'SaaSage', 'Rishflips'])).toBe(false);
    scheduler.advance(250);
    await flushMicrotasks();
    expect(stt.keytermUpdates.at(-1)).toEqual(['Twring', 'SaaSage', 'Rishflips']);
    await pipeline.close();
    expect(pipeline.updateKeyterms(['x'])).toBe(false);
  });
});

describe('reconnect edge cases (verify)', () => {
  it('a hang-up while the new session opens sends it no held audio', async () => {
    const { stt, scheduler, pipeline, frames } = await started();
    stt.send({ type: 'error', error: lost });
    frames(20);
    const before = stt.samplesReceived;
    scheduler.advance(250);
    void pipeline.close();
    await flushMicrotasks();
    expect(stt.samplesReceived).toBe(before);
    expect(pipeline.retainedState().sttBacklog).toBe(0);
  });

  it('a failed reopen keeps holding, and the next success sends it once', async () => {
    const { stt, scheduler, pipeline, frames } = await started();
    const before = stt.samplesReceived;
    stt.failNextOpen = lost;
    stt.send({ type: 'error', error: lost });
    frames(10);
    scheduler.advance(250);
    await flushMicrotasks();
    frames(10);
    scheduler.advance(5_000);
    await flushMicrotasks();
    expect(stt.opens).toBe(3);
    expect(stt.samplesReceived - before).toBe(20 * SAMPLES_16K_PER_FRAME);
    expect(pipeline.retainedState().sttBacklog).toBe(0);
    await pipeline.close();
  });
});
