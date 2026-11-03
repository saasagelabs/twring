import { describe, expect, it } from 'vitest';

import { READY_CHIME, SAMPLES_PER_FRAME, renderTone } from '../audio/pcm';

import { CALL_TIMEOUTS, ECHO_DELAY_MS } from './limits';
import {
  CALLER_AUDIO_STALL_MS,
  CallRuntime,
  type CallRuntimeOptions,
  type EndReason,
} from './runtime';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';

const CALL_ID = 'call_aaaaaaaaaaaaaaaaaaaa';
const ECHO_FRAMES = ECHO_DELAY_MS / 20;

function setup(overrides: Partial<CallRuntimeOptions> = {}) {
  const transport = new FakeTransport();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const ended: { reason: EndReason; failed: boolean }[] = [];
  let joined = 0;
  const runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'echo',
    maxDurationMs: 60_000,
    scheduler,
    logger,
    onCallerJoined: () => (joined += 1),
    onEnded: ({ reason, failed }) => ended.push({ reason, failed }),
    ...overrides,
  });
  return { runtime, transport, scheduler, logger, ended, joinedCount: () => joined };
}

const loud = () => new Int16Array(SAMPLES_PER_FRAME).fill(8000);
const silent = () => new Int16Array(SAMPLES_PER_FRAME);

describe('CallRuntime lifecycle', () => {
  it('joins, announces readiness, and logs timing telemetry', async () => {
    const { runtime, transport, logger } = setup();
    await runtime.start();
    expect(transport.states).toEqual(['ready']);
    expect(logger.names()).toEqual(['gateway_join_started', 'gateway_joined', 'gateway_ready']);
    expect(logger.events.every((e) => e.fields.call_id === CALL_ID)).toBe(true);
  });

  it('ends as a failure when the gateway cannot join, and releases the transport', async () => {
    const { runtime, transport, ended, scheduler } = setup();
    transport.connectBehavior = 'reject';
    await runtime.start();
    expect(ended).toEqual([{ reason: 'gateway_connect_failed', failed: true }]);
    expect(transport.closeCount).toBe(1);
    expect(transport.states).not.toContain('ready');
    expect(scheduler.pending).toBe(0);
  });

  it('aborts a pending gateway connect when the call ends', () => {
    const { runtime, transport } = setup();
    transport.connectBehavior = 'hang';
    void runtime.start();
    expect(transport.connectSignal?.aborted).toBe(false);
    void runtime.end('hangup');
    expect(transport.connectSignal?.aborted).toBe(true);
  });

  it('ends when the caller never joins', async () => {
    const { runtime, scheduler, ended } = setup();
    await runtime.start();
    scheduler.advance(CALL_TIMEOUTS.callerJoinMs);
    await flushMicrotasks();
    expect(ended).toEqual([{ reason: 'caller_never_joined', failed: false }]);
  });

  it('waits for a rejoin before ending when the caller leaves', async () => {
    const { runtime, transport, scheduler, ended, logger, joinedCount } = setup();
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    transport.emit({ type: 'caller_left' });
    scheduler.advance(CALL_TIMEOUTS.callerRejoinGraceMs - 1);
    transport.emit({ type: 'caller_joined' });
    scheduler.advance(CALL_TIMEOUTS.callerRejoinGraceMs);
    expect(ended).toEqual([]);
    expect(joinedCount()).toBe(1);
    expect(logger.names()).toContain('caller_rejoined');

    transport.emit({ type: 'caller_left' });
    scheduler.advance(CALL_TIMEOUTS.callerRejoinGraceMs);
    await flushMicrotasks();
    expect(ended).toEqual([{ reason: 'caller_left', failed: false }]);
  });

  it('enforces the maximum call duration', async () => {
    const { runtime, transport, scheduler, ended } = setup({ maxDurationMs: 90_000 });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    scheduler.advance(90_000);
    await flushMicrotasks();
    expect(ended).toEqual([{ reason: 'max_duration', failed: false }]);
  });

  it('ends as a failure when the gateway is disconnected from the room', async () => {
    const { runtime, transport, ended } = setup();
    await runtime.start();
    transport.emit({ type: 'disconnected', reason: 'ROOM_DELETED' });
    await flushMicrotasks();
    expect(ended).toEqual([{ reason: 'gateway_disconnected', failed: true }]);
  });

  it('ends exactly once and cleans up every timer', async () => {
    const { runtime, transport, scheduler, ended } = setup();
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    await Promise.all([runtime.end('hangup'), runtime.end('shutdown'), runtime.end('hangup')]);
    expect(ended).toEqual([{ reason: 'hangup', failed: false }]);
    expect(transport.closeCount).toBe(1);
    expect(transport.states).toEqual(['ready', 'ending']);
    expect(scheduler.pending).toBe(0);
  });

  it('ignores media events after the call ended', async () => {
    const { runtime, transport } = setup();
    await runtime.start();
    await runtime.end('hangup');
    transport.frame(loud());
    transport.emit({ type: 'caller_listening' });
    await flushMicrotasks();
    expect(transport.published).toEqual([]);
  });

  it('reports transport loss and recovery as telemetry', async () => {
    const { runtime, transport, logger } = setup();
    await runtime.start();
    transport.emit({ type: 'reconnecting' });
    transport.emit({ type: 'reconnected' });
    expect(logger.names().slice(-2)).toEqual(['transport_lost', 'transport_restored']);
  });
});

describe('CallRuntime audio path', () => {
  it('reports caller audio level once per interval, only while the caller is present', async () => {
    const { runtime, transport, scheduler } = setup();
    await runtime.start();
    transport.frame(loud());
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(transport.statuses).toEqual([]); // no caller yet

    transport.emit({ type: 'caller_joined' });
    for (let i = 0; i < 49; i += 1) transport.frame(i === 10 ? loud() : silent());
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(transport.statuses).toEqual([
      {
        v: 1,
        type: 'audio_stats',
        call_id: CALL_ID,
        window_ms: 1000,
        frames_received: 49,
        peak_dbfs: -12.2,
      },
    ]);

    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(transport.statuses[1]).toMatchObject({ frames_received: 0, peak_dbfs: -120 });
  });

  it('logs once when the caller’s audio stops arriving mid-call, and how long it was gone', async () => {
    const { runtime, transport, scheduler, logger } = setup({ maxDurationMs: 600_000 });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    const second = () => {
      for (let i = 0; i < 50; i += 1) transport.frame(silent());
      scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    };
    second();
    const names = () => logger.names().filter((n) => n.startsWith('caller_audio_st'));
    scheduler.advance(CALLER_AUDIO_STALL_MS - CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(names()).toEqual([]);
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(names()).toEqual(['caller_audio_stalled']);
    scheduler.advance(20_000);
    expect(names()).toEqual(['caller_audio_stalled']);
    second();
    expect(
      logger.events.find((e) => e.fields.event === 'caller_audio_resumed')?.fields,
    ).toMatchObject({
      stalled_ms: CALLER_AUDIO_STALL_MS + 20_000 + CALL_TIMEOUTS.audioStatsIntervalMs,
    });
  });

  it('silence while the caller is muted is not a stall', async () => {
    const { runtime, transport, scheduler, logger } = setup({ maxDurationMs: 600_000 });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    for (let i = 0; i < 50; i += 1) transport.frame(silent());
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    transport.emit({ type: 'caller_muted' });
    scheduler.advance(CALLER_AUDIO_STALL_MS * 4);
    expect(logger.names()).not.toContain('caller_audio_stalled');
    // Unmuted and still nothing arrives: that is a stall again, counted from the unmute.
    transport.emit({ type: 'caller_unmuted' });
    scheduler.advance(CALLER_AUDIO_STALL_MS - CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(logger.names()).not.toContain('caller_audio_stalled');
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(logger.names()).toContain('caller_audio_stalled');
  });

  it('no stall is counted while the gateway itself reconnects, or across a caller rejoin', async () => {
    const { runtime, transport, scheduler, logger } = setup({ maxDurationMs: 600_000 });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    for (let i = 0; i < 50; i += 1) transport.frame(silent());
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    transport.emit({ type: 'reconnecting' });
    scheduler.advance(CALLER_AUDIO_STALL_MS * 3);
    expect(logger.names()).not.toContain('caller_audio_stalled');
    transport.emit({ type: 'reconnected' });
    scheduler.advance(CALLER_AUDIO_STALL_MS - CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(logger.names()).not.toContain('caller_audio_stalled');
    // The caller drops and comes back: the silence before is not carried over.
    transport.emit({ type: 'caller_left' });
    scheduler.advance(3_000);
    transport.emit({ type: 'caller_joined' });
    scheduler.advance(CALLER_AUDIO_STALL_MS - CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(logger.names()).not.toContain('caller_audio_stalled');
    scheduler.advance(CALL_TIMEOUTS.audioStatsIntervalMs);
    expect(
      logger.events.find((e) => e.fields.event === 'caller_audio_stalled')?.fields,
    ).toMatchObject({ silent_ms: CALLER_AUDIO_STALL_MS });
  });

  it('a caller who never sent audio, or has left, is not a stall', async () => {
    const { runtime, transport, scheduler, logger } = setup({ maxDurationMs: 600_000 });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    scheduler.advance(CALLER_AUDIO_STALL_MS * 3);
    expect(logger.names()).not.toContain('caller_audio_stalled');
  });

  it('echoes caller audio back after the echo delay, in order', async () => {
    const { runtime, transport } = setup();
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    const frames = Array.from({ length: ECHO_FRAMES + 3 }, (_, i) =>
      new Int16Array(SAMPLES_PER_FRAME).fill(i + 1),
    );
    for (const frame of frames) transport.frame(frame);
    await flushMicrotasks();
    expect(transport.published).toEqual(frames.slice(0, 3));
  });

  it('plays the ready chime when the caller can hear us, without echo on top', async () => {
    const { runtime, transport } = setup();
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    transport.emit({ type: 'caller_listening' });
    for (let i = 0; i < ECHO_FRAMES + 5; i += 1) transport.frame(loud());
    await flushMicrotasks();
    expect(transport.published).toEqual(renderTone(READY_CHIME));
  });

  it('stays silent in off mode and does not echo in tone mode', async () => {
    for (const audioMode of ['off', 'tone'] as const) {
      const { runtime, transport } = setup({ audioMode });
      await runtime.start();
      transport.emit({ type: 'caller_joined' });
      for (let i = 0; i < ECHO_FRAMES + 5; i += 1) transport.frame(loud());
      await flushMicrotasks();
      expect(transport.published).toEqual([]);
      transport.emit({ type: 'caller_listening' });
      await flushMicrotasks();
      expect(transport.published.length).toBe(
        audioMode === 'tone' ? renderTone(READY_CHIME).length : 0,
      );
    }
  });

  it('keeps the call alive when publishing audio fails', async () => {
    const { runtime, transport, logger, ended } = setup();
    await runtime.start();
    transport.publishFrame = () => Promise.reject(new Error('track closed'));
    transport.emit({ type: 'caller_listening' });
    await flushMicrotasks();
    expect(logger.names()).toContain('audio_publish_failed');
    expect(ended).toEqual([]);
  });
});
