import type { CallState, CreateCallResponse, FloorMessage, StatusMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type TwringApi } from '../api/client';

import { CallApiError, type CallApi } from './api';
import { approvalCountdown, approvalPhrase } from './approval';
import {
  CallController,
  MAX_MIC_RESTARTS,
  MIC_STALL_REPORTS,
  type CallTelemetryEvent,
} from './controller';
import { feedbackFor } from './feedback';
import { CALL_TIMEOUTS, type Timers } from './timers';
import {
  MicrophoneError,
  type CallBackgroundService,
  type CallTransport,
  type MicrophonePermission,
  type TransportEvent,
} from './transport';

const CALL_ID = 'call_abcdefghij0123456789';
const SESSION: CreateCallResponse = {
  call_id: CALL_ID,
  session_id: 'sess_abcdefghij0123456789',
  livekit: { url: 'wss://cord-test.livekit.invalid', token: 'jwt', room: 'cord-call-x' },
  expires_at: '2026-09-25T10:00:00.000Z',
};

class ManualTimers implements Timers {
  time = 0;
  private timers: { at: number; callback: () => void; id: number }[] = [];
  private nextId = 0;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, callback, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  get pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = target;
  }
}

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeTransport implements CallTransport {
  onEvent: ((event: TransportEvent) => void) | undefined;
  signal: AbortSignal | undefined;
  connected = deferred<void>();
  disconnects = 0;

  connect(
    _params: unknown,
    onEvent: (event: TransportEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.onEvent = onEvent;
    this.signal = signal;
    signal.addEventListener('abort', () => this.connected.reject(new Error('aborted')));
    return this.connected.promise;
  }

  muteCalls: boolean[] = [];
  failMute = false;
  /** Holds every mute change until it settles, to queue work behind one. */
  muteGate: Promise<void> = Promise.resolve();

  setMicrophoneMuted(muted: boolean): Promise<void> {
    this.muteCalls.push(muted);
    return this.failMute
      ? Promise.reject(new Error('mute failed'))
      : this.muteGate.then(() => undefined);
  }

  micRestarts = 0;
  restartResult: () => Promise<void> = () => Promise.resolve();
  restartMicrophone(): Promise<void> {
    this.micRestarts += 1;
    return this.restartResult();
  }

  disconnect(): Promise<void> {
    this.disconnects += 1;
    this.onEvent?.({ type: 'disconnected', cause: 'client' });
    return Promise.resolve();
  }

  emit(event: TransportEvent): void {
    this.onEvent?.(event);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Records background-service calls; `start` can be held open or made to fail. */
class FakeBackground implements CallBackgroundService {
  log: string[] = [];
  startResult: Promise<void> = Promise.resolve();
  prepare(): Promise<void> {
    this.log.push('prepare');
    return Promise.resolve();
  }
  start(info: { agentName: string }): Promise<void> {
    this.log.push(`start:${info.agentName}`);
    return this.startResult.then(() => {
      this.log.push('started');
    });
  }
  stop(): Promise<void> {
    this.log.push('stop');
    return Promise.resolve();
  }
  setCallScreen(_active: boolean): void {}
}

function setup(
  options: {
    permission?: MicrophonePermission;
    create?: CallApi['create'];
    background?: FakeBackground;
    decideApproval?: TwringApi['decideApproval'];
  } = {},
) {
  const timers = new ManualTimers();
  const transport = new FakeTransport();
  const create = deferred<CreateCallResponse>();
  const ended: string[] = [];
  const telemetry: CallTelemetryEvent[] = [];
  const invalid: string[] = [];
  const api: CallApi = {
    create: options.create ?? (() => create.promise),
    end: (callId) => {
      ended.push(callId);
      return Promise.resolve();
    },
  };
  const controller = new CallController({
    api,
    approvalApi: { decideApproval: options.decideApproval ?? (() => Promise.resolve()) },
    createTransport: () => transport,
    microphone: { request: () => Promise.resolve(options.permission ?? 'granted') },
    ...(options.background !== undefined && { background: options.background }),
    timers,
    telemetry: (event) => telemetry.push(event),
    onInvalidTransition: (state, event) => invalid.push(`${state.status}+${event.type}`),
  });
  const statuses: CallState['status'][] = [];
  controller.subscribe(() => {
    const status = controller.getView().call.status;
    if (statuses.at(-1) !== status) statuses.push(status);
  });
  return { controller, timers, transport, create, ended, telemetry, invalid, statuses };
}

/** Drives a call to LISTENING. */
async function connect(ctx: ReturnType<typeof setup>) {
  void ctx.controller.start();
  await settle();
  ctx.create.resolve(SESSION);
  await settle();
  ctx.transport.connected.resolve();
  await settle();
  ctx.transport.emit({ type: 'gateway_ready' });
}

const approvalMessage = (approvalId = 'approval_1'): StatusMessage => ({
  v: 1,
  type: 'approval',
  call_id: CALL_ID,
  approval_id: approvalId,
  agent_name: 'Ada',
  action: 'edit_files',
  title: 'Update config',
  description: 'Change one setting',
  expires_at: '2026-10-06T12:00:00.000Z',
});

describe('call approvals', () => {
  it('sets, replaces, and clears only the matching approval; call end clears it too', async () => {
    const ctx = setup();
    await connect(ctx);
    const emit = (message: StatusMessage) => ctx.transport.emit({ type: 'status', message });
    emit(approvalMessage());
    expect(ctx.controller.getView().approval).toEqual({
      id: 'approval_1',
      agentName: 'Ada',
      action: 'edit_files',
      title: 'Update config',
      description: 'Change one setting',
      expiresAt: Date.parse('2026-10-06T12:00:00.000Z'),
    });
    emit(approvalMessage('approval_2'));
    emit({
      v: 1,
      type: 'approval_resolved',
      call_id: CALL_ID,
      approval_id: 'approval_1',
      decision: 'deny',
      by: 'voice',
    });
    expect(ctx.controller.getView().approval?.id).toBe('approval_2');
    emit({
      v: 1,
      type: 'approval_resolved',
      call_id: CALL_ID,
      approval_id: 'approval_2',
      decision: 'approve',
      by: 'tap',
    });
    expect(ctx.controller.getView().approval).toBeUndefined();
    emit(approvalMessage('approval_3'));
    await ctx.controller.hangUp();
    expect(ctx.controller.getView().approval).toBeUndefined();
  });

  it('clears on 204, 404 or 409 and keeps the card with an error after network failure', async () => {
    const decideApproval = vi
      .fn<TwringApi['decideApproval']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new ApiError('http', undefined, undefined, undefined, 404))
      .mockRejectedValueOnce(
        new ApiError('http', 'approval_already_decided', undefined, undefined, 409),
      )
      .mockRejectedValueOnce(new ApiError('network'));
    const ctx = setup({ decideApproval });
    await connect(ctx);
    for (const id of ['one', 'two', 'three', 'four']) {
      ctx.transport.emit({ type: 'status', message: approvalMessage(id) });
      await ctx.controller.decideApproval('approve');
      expect(ctx.controller.getView().approval?.id).toBe(id === 'four' ? id : undefined);
    }
    expect(ctx.controller.getView().approvalError).toBe(true);
    expect(decideApproval).toHaveBeenCalledTimes(4);
    expect(decideApproval).toHaveBeenCalledWith(CALL_ID, 'one', 'approve', expect.any(AbortSignal));
  });

  it('ignores a second tap while the decision is in flight', async () => {
    const pending = deferred<void>();
    const decideApproval = vi.fn<TwringApi['decideApproval']>(() => pending.promise);
    const ctx = setup({ decideApproval });
    await connect(ctx);
    ctx.transport.emit({ type: 'status', message: approvalMessage() });
    const first = ctx.controller.decideApproval('deny');
    await ctx.controller.decideApproval('approve');
    expect(decideApproval).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
    expect(ctx.controller.getView().approval).toBeUndefined();
  });
});

describe('approval copy', () => {
  it.each([
    ['edit_files', 'change files'],
    ['delete_files', 'delete files'],
    ['run_command', 'run a command'],
    ['read_files', 'read files'],
    ['fetch_web', 'open a web page'],
    ['other', 'do something that needs your OK'],
  ] as const)('phrases %s', (action, phrase) => {
    expect(approvalPhrase(action)).toBe(phrase);
  });

  it('formats the remaining time in whole seconds', () => {
    expect(approvalCountdown(105_000, 0)).toBe('1:45');
    expect(approvalCountdown(105_000, 4_100)).toBe('1:41');
    expect(approvalCountdown(105_000, 106_000)).toBe('0:00');
  });
});

describe('CallController happy path', () => {
  it('goes PREPARING → CONNECTING → LISTENING only once media and gateway are both ready', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('CONNECTING');
    ctx.timers.advance(1200);
    ctx.transport.connected.resolve();
    await settle();
    expect(ctx.statuses).toEqual(['PREPARING', 'CONNECTING', 'LISTENING']);
    expect(ctx.controller.getView().connectedAt).toBe(1200);
    expect(ctx.telemetry).toContainEqual({
      event: 'call_connected',
      call_id: CALL_ID,
      duration_ms: 1200,
      t_ms: 1200,
    });
    expect(ctx.invalid).toEqual([]);
  });

  it('shows the gateway hearing the caller', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({
      type: 'status',
      message: {
        v: 1,
        type: 'audio_stats',
        call_id: CALL_ID,
        window_ms: 1000,
        frames_received: 50,
        peak_dbfs: -18,
      },
    });
    expect(ctx.controller.getView().inbound).toEqual({
      peakDbfs: -18,
      framesReceived: 50,
      at: 0,
    });
  });

  describe('a microphone that stops reaching Twring', () => {
    const stats = (ctx: ReturnType<typeof setup>, frames: number) =>
      ctx.transport.emit({
        type: 'status',
        message: {
          v: 1,
          type: 'audio_stats',
          call_id: CALL_ID,
          window_ms: 1000,
          frames_received: frames,
          peak_dbfs: frames > 0 ? -40 : -120,
        },
      });

    const silence = (ctx: ReturnType<typeof setup>, reports = MIC_STALL_REPORTS) => {
      for (let i = 0; i < reports; i += 1) stats(ctx, 0);
    };
    const events = (ctx: ReturnType<typeof setup>) =>
      ctx.telemetry.filter((e) => e.event.startsWith('mic_restart') || e.event === 'mic_recovered');

    it('is restarted after a few seconds with nothing arriving, and reported', async () => {
      const ctx = setup();
      await connect(ctx);
      stats(ctx, 50);
      silence(ctx, MIC_STALL_REPORTS - 1);
      expect(ctx.transport.micRestarts).toBe(0);
      stats(ctx, 0);
      await settle();
      expect(ctx.transport.micRestarts).toBe(1);
      expect(ctx.telemetry).toContainEqual(
        expect.objectContaining({ event: 'mic_restarted', call_id: CALL_ID, detail: 'attempt 1' }),
      );
      // Whether it worked shows in the next report with audio in it.
      stats(ctx, 50);
      stats(ctx, 50);
      expect(events(ctx).map((e) => [e.event, e.detail])).toEqual([
        ['mic_restarted', 'attempt 1'],
        ['mic_recovered', 'attempt 1'],
      ]);
    });

    it('waits for the first audio of the call before counting silence', async () => {
      const ctx = setup();
      await connect(ctx);
      silence(ctx, MIC_STALL_REPORTS * 2);
      await settle();
      expect(ctx.transport.micRestarts).toBe(0);
    });

    it('starts counting again after a reconnect, once audio is back', async () => {
      const ctx = setup();
      await connect(ctx);
      stats(ctx, 50);
      silence(ctx, MIC_STALL_REPORTS - 1);
      // No reports arrive while the phone reconnects.
      ctx.transport.emit({ type: 'reconnecting' });
      ctx.transport.emit({ type: 'reconnected' });
      await settle();
      // The windows right after a reconnect are empty while audio flows again.
      silence(ctx, MIC_STALL_REPORTS - 1);
      await settle();
      expect(ctx.transport.micRestarts).toBe(0);
      stats(ctx, 50);
      silence(ctx);
      await settle();
      expect(ctx.transport.micRestarts).toBe(1);
    });

    it('reports a restart that fails or hangs, and the mute button still works', async () => {
      const ctx = setup();
      await connect(ctx);
      ctx.transport.restartResult = () => Promise.reject(new TypeError('no mic'));
      stats(ctx, 50);
      silence(ctx);
      await settle();
      ctx.transport.restartResult = () => new Promise(() => undefined);
      stats(ctx, 50);
      silence(ctx);
      await settle();
      ctx.timers.advance(CALL_TIMEOUTS.muteMs);
      await settle();
      expect(events(ctx).map((e) => [e.event, e.detail])).toEqual([
        ['mic_restart_failed', 'TypeError'],
        ['mic_restart_failed', 'TimeoutError'],
      ]);
      expect(ctx.controller.getView().muted).toBe(false);
      await ctx.controller.setMuted(true);
      expect(ctx.transport.muteCalls).toEqual([true]);
      expect(ctx.controller.getView().muted).toBe(true);
    });

    it('is skipped when the caller mutes before a queued restart runs', async () => {
      const ctx = setup();
      await connect(ctx);
      stats(ctx, 50);
      const gate = deferred<void>();
      ctx.transport.muteGate = gate.promise;
      void ctx.controller.setMuted(true);
      void ctx.controller.setMuted(false);
      silence(ctx);
      void ctx.controller.setMuted(true);
      gate.resolve();
      await settle();
      await settle();
      expect(ctx.transport.muteCalls).toEqual([true, false, true]);
      expect(ctx.transport.micRestarts).toBe(0);
    });

    it('is skipped when the call ends before a queued restart runs', async () => {
      const ctx = setup();
      await connect(ctx);
      stats(ctx, 50);
      const gate = deferred<void>();
      ctx.transport.muteGate = gate.promise;
      void ctx.controller.setMuted(true);
      void ctx.controller.setMuted(false);
      silence(ctx);
      const hangUp = ctx.controller.hangUp();
      gate.resolve();
      await hangUp;
      await settle();
      expect(ctx.transport.micRestarts).toBe(0);
    });

    it('is left alone while muted', async () => {
      const ctx = setup();
      await connect(ctx);
      await ctx.controller.setMuted(true);
      for (let i = 0; i < MIC_STALL_REPORTS * 3; i += 1) stats(ctx, 0);
      await settle();
      expect(ctx.transport.micRestarts).toBe(0);
    });

    it('counts again once audio is back, and stops trying after a few attempts', async () => {
      const ctx = setup();
      await connect(ctx);
      for (let round = 0; round < MAX_MIC_RESTARTS + 2; round += 1) {
        stats(ctx, 50);
        for (let i = 0; i < MIC_STALL_REPORTS; i += 1) stats(ctx, 0);
        await settle();
      }
      expect(ctx.transport.micRestarts).toBe(MAX_MIC_RESTARTS);
    });
  });

  it('shows live captions and never lets an older turn overwrite a newer one', async () => {
    const ctx = setup();
    await connect(ctx);
    const caption = (turn_index: number, text: string, final: boolean) =>
      ctx.transport.emit({
        type: 'status',
        message: { v: 1, type: 'caption', call_id: CALL_ID, turn_index, text, final },
      });
    caption(0, 'hel', false);
    caption(0, 'hello', true);
    expect(ctx.controller.getView().caption).toEqual({ turnIndex: 0, text: 'hello', final: true });
    caption(1, 'next', false);
    caption(0, 'late packet', false);
    expect(ctx.controller.getView().caption).toEqual({ turnIndex: 1, text: 'next', final: false });
  });

  it('mirrors the gateway floor through a whole turn, ignoring stale updates', async () => {
    const ctx = setup();
    await connect(ctx);
    const floor = (seq: number, value: FloorMessage['floor'], extra: Partial<FloorMessage> = {}) =>
      ctx.transport.emit({
        type: 'status',
        message: { v: 1, type: 'floor', call_id: CALL_ID, seq, floor: value, ...extra },
      });
    floor(1, 'user_speaking');
    floor(2, 'agent_working', { turn_id: 'turn_1', activity: 'Checking calendar…' });
    expect(ctx.controller.getView().call).toEqual({
      status: 'AGENT_WORKING',
      callId: CALL_ID,
      turnId: 'turn_1',
      activity: 'Checking calendar…',
    });
    floor(3, 'agent_speaking', { turn_id: 'turn_1' });
    floor(2, 'agent_working', { turn_id: 'turn_1' }); // late duplicate: ignored
    expect(ctx.controller.getView().call.status).toBe('AGENT_SPEAKING');
    floor(4, 'listening');
    expect(ctx.statuses.slice(-4)).toEqual([
      'USER_SPEAKING',
      'AGENT_WORKING',
      'AGENT_SPEAKING',
      'LISTENING',
    ]);
    expect(ctx.invalid).toEqual([]);
  });

  it('catches up with the floor after reconnecting', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'reconnecting' });
    ctx.transport.emit({
      type: 'status',
      message: {
        v: 1,
        type: 'floor',
        call_id: CALL_ID,
        seq: 1,
        floor: 'agent_speaking',
        turn_id: 'turn_1',
      },
    });
    expect(ctx.controller.getView().call.status).toBe('RECONNECTING');
    ctx.transport.emit({ type: 'reconnected' });
    expect(ctx.controller.getView().call.status).toBe('AGENT_SPEAKING');
    expect(ctx.invalid).toEqual([]);
  });

  it('shows the streamed reply and a notice, and clears both when the caller speaks again', async () => {
    const ctx = setup();
    await connect(ctx);
    const emit = (message: StatusMessage) => ctx.transport.emit({ type: 'status', message });
    emit({
      v: 1,
      type: 'floor',
      call_id: CALL_ID,
      seq: 1,
      floor: 'agent_working',
      turn_id: 'turn_1',
    });
    emit({
      v: 1,
      type: 'agent_text',
      call_id: CALL_ID,
      turn_id: 'turn_1',
      text: 'Hel',
      final: false,
    });
    expect(ctx.controller.getView().reply).toEqual({ turnId: 'turn_1', text: 'Hel', final: false });
    emit({ v: 1, type: 'notice', call_id: CALL_ID, code: 'agent_timeout' });
    expect(ctx.controller.getView().notice).toBe('agent_timeout');
    emit({ v: 1, type: 'floor', call_id: CALL_ID, seq: 2, floor: 'user_speaking' });
    expect(ctx.controller.getView().reply).toBeUndefined();
    expect(ctx.controller.getView().notice).toBeUndefined();
    expect(ctx.controller.getView().call.status).toBe('USER_SPEAKING');
  });

  it('shows the not-streaming notice alongside the reply without replacing it', async () => {
    const ctx = setup();
    await connect(ctx);
    const emit = (message: StatusMessage) => ctx.transport.emit({ type: 'status', message });
    emit({
      v: 1,
      type: 'floor',
      call_id: CALL_ID,
      seq: 1,
      floor: 'agent_working',
      turn_id: 'turn_1',
    });
    emit({ v: 1, type: 'notice', call_id: CALL_ID, code: 'agent_not_streaming' });
    emit({
      v: 1,
      type: 'agent_text',
      call_id: CALL_ID,
      turn_id: 'turn_1',
      text: 'Whole reply at once.',
      final: true,
    });
    emit({
      v: 1,
      type: 'floor',
      call_id: CALL_ID,
      seq: 2,
      floor: 'agent_speaking',
      turn_id: 'turn_1',
    });
    const view = ctx.controller.getView();
    expect(view.notice).toBe('agent_not_streaming');
    expect(view.reply).toEqual({ turnId: 'turn_1', text: 'Whole reply at once.', final: true });
    expect(view.call.status).toBe('AGENT_SPEAKING');
    expect(ctx.invalid).toEqual([]);
  });

  it('reports what the phone receives from the gateway as telemetry', async () => {
    const ctx = setup();
    await connect(ctx);
    const window = {
      window_ms: 5000,
      bytes_received: 250,
      packets_lost: 0,
      jitter_ms: 4,
      level_dbfs: -31,
    };
    ctx.transport.emit({ type: 'downlink_stats', window });
    expect(ctx.telemetry).toContainEqual(
      expect.objectContaining({ event: 'audio_rx', call_id: CALL_ID, downlink: window }),
    );
  });

  it('hangs up cleanly: releases media, ends the server call once, clears timers', async () => {
    const ctx = setup();
    await connect(ctx);
    await Promise.all([ctx.controller.hangUp(), ctx.controller.hangUp()]);
    expect(ctx.statuses.slice(-2)).toEqual(['ENDING', 'ENDED']);
    expect(ctx.transport.disconnects).toBe(1);
    expect(ctx.ended).toEqual([CALL_ID]);
    expect(ctx.timers.pending).toBe(0);
    expect(ctx.invalid).toEqual([]);
  });

  it('starts a fresh call after the previous one finished', async () => {
    const ctx = setup();
    await connect(ctx);
    await ctx.controller.hangUp();
    ctx.controller.reset();
    expect(ctx.controller.getView()).toEqual({ call: { status: 'IDLE' }, muted: false });
  });
});

describe('CallController failures', () => {
  it.each(['denied', 'blocked'] as const)(
    'fails without creating a server call when mic permission is %s',
    async (permission) => {
      const ctx = setup({ permission });
      await ctx.controller.start();
      const view = ctx.controller.getView().call;
      expect(view.status).toBe('FAILED');
      expect(view.status === 'FAILED' && view.error.code).toBe('MIC_PERMISSION_DENIED');
      expect(view.status === 'FAILED' && view.error.retryable).toBe(false);
      expect(ctx.ended).toEqual([]);
    },
  );

  it('maps a mic capture failure after joining', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.reject(new MicrophoneError('unavailable'));
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'MIC_UNAVAILABLE' },
    });
    expect(ctx.ended).toEqual([CALL_ID]);
  });

  it('reports busy lines and carries the request ID for support', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(new CallApiError('http', 'capacity_exceeded', 'req-123'));
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'CALL_CAPACITY_EXCEEDED', retryable: true, correlationId: 'req-123' },
    });
  });

  it('explains an unreadable own key at call start, not retryable', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(
      new CallApiError(
        'http',
        'speech_key_unreadable',
        'req-5',
        undefined,
        "Couldn't read your saved Deepgram key. Add it again in Settings.",
      ),
    );
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'SPEECH_KEY_REFUSED',
        retryable: false,
        message: "Couldn't read your saved Deepgram key. Add it again in Settings.",
      },
    });
  });

  it('falls back to generic copy for an unreadable key without a server message', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(new CallApiError('http', 'speech_key_unreadable'));
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      error: {
        code: 'SPEECH_KEY_REFUSED',
        message: "Couldn't read your saved voice account key. Add it again in Settings.",
      },
    });
  });

  it('explains a call refused for the daily limit, with when it resets', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(
      new CallApiError('http', 'daily_limit_reached', 'req-9', new Date('2026-10-01T00:00:00Z')),
    );
    await settle();
    const call = ctx.controller.getView().call;
    expect(call).toMatchObject({
      status: 'FAILED',
      error: { code: 'DAILY_LIMIT_REACHED', retryable: false, correlationId: 'req-9' },
    });
    expect(call.status === 'FAILED' && call.error.message).toMatch(
      /^You've used today's calling time\. It resets (tomorrow )?at /,
    );
  });

  it("says Twring is busy, not the person's connection, when the whole service's day is used", async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(
      new CallApiError('http', 'service_busy', 'req-7', new Date('2026-10-01T00:00:00Z')),
    );
    await settle();
    const call = ctx.controller.getView().call;
    expect(call).toMatchObject({
      status: 'FAILED',
      error: { code: 'SERVICE_BUSY', retryable: false, correlationId: 'req-7' },
    });
    expect(call.status === 'FAILED' && call.error.message).toMatch(
      /^Twring is very busy today\. Try again (tomorrow )?at /,
    );
  });

  it.each([
    ['call_in_progress', 'CALL_IN_PROGRESS', "You're already on a call. End it first."],
    [
      'agent_offline',
      'AGENT_OFFLINE',
      "Your computer is offline. Make sure it's on and online, then call again.",
    ],
    [
      'agent_not_on_computer',
      'AGENT_NOT_ON_COMPUTER',
      "This agent isn't set up on your computer anymore.",
    ],
    ['connector_invalid', 'CONNECTOR_REMOVED', 'Computer removed. Pair it again.'],
    [
      'audio_unavailable',
      'AUDIO_UNAVAILABLE',
      "Twring's audio service can't be reached right now. Try again in a minute.",
    ],
    [
      'audio_unreachable',
      'AUDIO_UNREACHABLE',
      "Call audio isn't reachable on your server. Run twring audio check on the server.",
    ],
    [
      'audio_paused',
      'AUDIO_PAUSED',
      "Calls are paused until your server's email address is confirmed. Your admin can find the email from Twring.",
    ],
    [
      'audio_expired',
      'AUDIO_EXPIRED',
      "Twring's audio service for this server has ended. Ask your admin.",
    ],
    [
      'audio_limit_reached',
      'AUDIO_LIMIT_REACHED',
      'This server has reached its call limit for now. Try again later.',
    ],
  ] as const)('explains a refused start (%s) as %s', async (apiCode, code, message) => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.reject(new CallApiError('http', apiCode, 'req-7'));
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code, message, correlationId: 'req-7' },
    });
  });

  it('asks the server for the chosen saved agent', async () => {
    const requests: unknown[] = [];
    const ctx = setup({
      create: (_signal, request) => {
        requests.push(request);
        return new Promise(() => undefined);
      },
    });
    void ctx.controller.start({ agent_id: 'agt_abcdefghij0123456789' });
    await settle();
    expect(requests).toEqual([{ agent_id: 'agt_abcdefghij0123456789' }]);
  });

  it('times out session creation', async () => {
    let seen: AbortSignal | undefined;
    const ctx = setup({
      create: (signal) => {
        seen = signal;
        return new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new CallApiError('timeout'))),
        );
      },
    });
    void ctx.controller.start();
    await settle();
    ctx.timers.advance(CALL_TIMEOUTS.prepareMs);
    await settle();
    expect(seen?.aborted).toBe(true);
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'CALL_SESSION_CREATE_FAILED' },
    });
  });

  it('times out joining the room', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.timers.advance(CALL_TIMEOUTS.mediaConnectMs);
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'LIVEKIT_CONNECT_FAILED' },
    });
    expect(ctx.transport.disconnects).toBe(1);
    expect(ctx.ended).toEqual([CALL_ID]);
  });

  it('fails if the gateway never becomes ready, and never claims Connected', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    ctx.timers.advance(CALL_TIMEOUTS.gatewayReadyMs);
    await settle();
    expect(ctx.statuses).not.toContain('LISTENING');
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'GATEWAY_UNAVAILABLE' },
    });
  });

  it.each([
    ['deepgram_key_refused', 'Deepgram'],
    ['cartesia_key_refused', 'Cartesia'],
    ['xai_key_refused', 'xAI'],
  ] as const)('explains %s with the provider named and no retry', async (reason, provider) => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    ctx.transport.emit({ type: 'gateway_ending', reason });
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: {
        code: 'SPEECH_KEY_REFUSED',
        retryable: false,
        message: `Your ${provider} key was refused, so the call ended. Update it in Settings, Your own voice accounts.`,
      },
    });
  });

  it.each([
    ['agent_unavailable', 'AGENT_CONNECT_FAILED'],
    ['agent_offline', 'AGENT_OFFLINE'],
    ['voice_unavailable', 'VOICE_UNAVAILABLE'],
    ['voice_failed', 'VOICE_UNAVAILABLE'],
  ] as const)('explains a gateway ending with %s as %s', async (reason, code) => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    ctx.transport.emit({ type: 'gateway_ending', reason });
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code, retryable: true },
    });
    expect(ctx.transport.disconnects).toBe(1);
  });

  it("says today's calling time is used up when the gateway ends for the daily limit", async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'gateway_ending', reason: 'daily_limit' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'DAILY_LIMIT_REACHED', retryable: false },
    });
    const call = ctx.controller.getView().call;
    expect(call.status === 'FAILED' && call.error.message).toMatch(
      /^You've used today's calling time\. It resets /,
    );
  });

  it('leaves a non-failure end reason to the room closing', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'gateway_ending', reason: 'max_duration' });
    await settle();
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      error: { code: 'CALL_ENDED_BY_SERVER' },
    });
  });

  it('ends normally when the agent hangs up, not as an interrupted call', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'gateway_ending', reason: 'agent_hangup' });
    await settle();
    // The room closing a moment later must not turn the ended call into a failure.
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call.status).toBe('ENDED');
    expect(ctx.transport.disconnects).toBe(1);
  });

  it('treats the server deleting the room as the call ending on its side', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'CALL_ENDED_BY_SERVER' },
    });
  });
});

describe('CallController reconnect', () => {
  it('recovers within the budget and keeps the same call', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'reconnecting' });
    expect(ctx.controller.getView().call.status).toBe('RECONNECTING');
    ctx.timers.advance(CALL_TIMEOUTS.reconnectBudgetMs - 1);
    ctx.transport.emit({ type: 'reconnected' });
    expect(ctx.controller.getView().call).toEqual({ status: 'LISTENING', callId: CALL_ID });
    ctx.timers.advance(CALL_TIMEOUTS.reconnectBudgetMs);
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.telemetry).toContainEqual(
      expect.objectContaining({
        event: 'transport_restored',
        call_id: CALL_ID,
        duration_ms: CALL_TIMEOUTS.reconnectBudgetMs - 1,
      }),
    );
  });

  it('fails when reconnect exceeds its budget', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'reconnecting' });
    ctx.timers.advance(CALL_TIMEOUTS.reconnectBudgetMs);
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'RECONNECT_EXHAUSTED' },
    });
    expect(ctx.transport.disconnects).toBe(1);
  });

  it('waits for the gateway to come back when it drops mid-call', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'gateway_lost' });
    expect(ctx.controller.getView().call.status).toBe('RECONNECTING');
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
  });
});

describe('CallController hang-up races', () => {
  it('hang-up while the session request is in flight releases everything', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    await ctx.controller.hangUp();
    ctx.create.resolve(SESSION);
    await settle();
    expect(ctx.statuses).toEqual(['PREPARING', 'ENDING', 'ENDED']);
    expect(ctx.transport.signal).toBeUndefined(); // never joined media
    expect(ctx.timers.pending).toBe(0);
  });

  it('hang-up while joining media aborts the join and ends the server call', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    await ctx.controller.hangUp();
    await settle();
    expect(ctx.transport.signal?.aborted).toBe(true);
    expect(ctx.controller.getView().call.status).toBe('ENDED');
    expect(ctx.ended).toEqual([CALL_ID]);
  });

  it('ignores a second start while a call is active', async () => {
    const ctx = setup();
    await connect(ctx);
    await ctx.controller.start();
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
  });
});

describe('CallController floor edge cases (verifier)', () => {
  const floorMessage = (
    seq: number,
    value: FloorMessage['floor'],
    extra: Partial<FloorMessage> = {},
  ): StatusMessage => ({ v: 1, type: 'floor', call_id: CALL_ID, seq, floor: value, ...extra });

  it('a floor that arrives before the gateway is ready is applied once the call connects', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    ctx.transport.emit({
      type: 'status',
      message: floorMessage(1, 'agent_working', { turn_id: 'turn_1' }),
    });
    expect(ctx.controller.getView().call.status).toBe('CONNECTING');
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('AGENT_WORKING');
    expect(ctx.controller.getView().connectedAt).toBeDefined();
    expect(ctx.invalid).toEqual([]);
  });

  it("a new call does not ignore the gateway's floor because the last call's seq was higher", async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'status', message: floorMessage(7, 'user_speaking') });
    await ctx.controller.hangUp();
    ctx.controller.reset();
    await connect(ctx);
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    ctx.transport.emit({
      type: 'status',
      message: floorMessage(1, 'agent_speaking', { turn_id: 'turn_1' }),
    });
    expect(ctx.controller.getView().call.status).toBe('AGENT_SPEAKING');
    expect(ctx.controller.getView().reply).toBeUndefined();
    expect(ctx.invalid).toEqual([]);
  });

  it('floor packets after the call failed change nothing and are not invalid transitions', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'disconnected', cause: 'network' });
    await settle();
    ctx.transport.emit({ type: 'status', message: floorMessage(1, 'user_speaking') });
    expect(ctx.controller.getView().call.status).toBe('FAILED');
    expect(ctx.invalid).toEqual([]);
  });

  it('keeps the agent reply and notice when the floor returns to listening', async () => {
    const ctx = setup();
    await connect(ctx);
    const emit = (message: StatusMessage) => ctx.transport.emit({ type: 'status', message });
    emit(floorMessage(1, 'agent_working', { turn_id: 'turn_1' }));
    emit({
      v: 1,
      type: 'agent_text',
      call_id: CALL_ID,
      turn_id: 'turn_1',
      text: 'Hi',
      final: true,
    });
    emit({ v: 1, type: 'notice', call_id: CALL_ID, code: 'agent_failed' });
    emit(floorMessage(2, 'listening'));
    expect(ctx.controller.getView().reply?.text).toBe('Hi');
    expect(ctx.controller.getView().notice).toBe('agent_failed');
    // A superseding turn clears the old reply even without user_speaking in between.
    emit(floorMessage(3, 'agent_working', { turn_id: 'turn_2' }));
    expect(ctx.controller.getView().reply).toBeUndefined();
    expect(ctx.controller.getView().notice).toBeUndefined();
  });
});

describe('CallController gateway end reasons, milestone 5 pass (verifier)', () => {
  it('a gateway already ending when the phone joins (before connect resolves) fails with the reason', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    // LiveKitCallTransport reports an already-`ending` gateway from inside connect().
    ctx.transport.emit({ type: 'gateway_ending', reason: 'agent_unavailable' });
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'AGENT_CONNECT_FAILED' },
    });
    expect(ctx.invalid).toEqual([]);
    expect(ctx.transport.disconnects).toBe(1);
  });

  it('a gateway_ending after the user hung up does not turn the ended call into a failure', async () => {
    const ctx = setup();
    await connect(ctx);
    const hangUp = ctx.controller.hangUp();
    ctx.transport.emit({ type: 'gateway_ending', reason: 'agent_unavailable' });
    await hangUp;
    expect(ctx.controller.getView().call.status).toBe('ENDED');
    expect(ctx.invalid).toEqual([]);
  });

  it('gateway_failed maps to GATEWAY_UNAVAILABLE and the room closing afterwards changes nothing', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'gateway_ending', reason: 'gateway_failed' });
    ctx.transport.emit({ type: 'gateway_lost' });
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(ctx.controller.getView().call).toMatchObject({
      status: 'FAILED',
      error: { code: 'GATEWAY_UNAVAILABLE' },
    });
    expect(ctx.invalid).toEqual([]);
  });
});

describe('CallController background service (milestone 8)', () => {
  it('asks for notification permission before connecting and starts only once connected', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    void ctx.controller.start({}, 'Ada');
    await settle();
    expect(background.log).toEqual(['prepare']);
    ctx.create.resolve(SESSION);
    await settle();
    ctx.transport.connected.resolve();
    await settle();
    expect(background.log).toEqual(['prepare']);
    ctx.transport.emit({ type: 'gateway_ready' });
    await settle();
    expect(background.log).toEqual(['prepare', 'start:Ada', 'started']);
    // Reconnecting and returning to LISTENING must not start it twice.
    ctx.transport.emit({ type: 'reconnecting' });
    ctx.transport.emit({ type: 'reconnected' });
    await settle();
    expect(background.log.filter((entry) => entry.startsWith('start:'))).toHaveLength(1);
  });

  it('stops on hang-up', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    await connect(ctx);
    await ctx.controller.hangUp();
    expect(background.log.at(-1)).toBe('stop');
  });

  it('stops when the call fails after connecting', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    await connect(ctx);
    ctx.transport.emit({ type: 'disconnected', cause: 'network' });
    await settle();
    expect(ctx.controller.getView().call.status).toBe('FAILED');
    expect(background.log.at(-1)).toBe('stop');
  });

  it('stops when the server ends the call', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    await connect(ctx);
    ctx.transport.emit({ type: 'disconnected', cause: 'server_ended' });
    await settle();
    expect(background.log.at(-1)).toBe('stop');
  });

  it('never starts when hung up during connect, and still stops (idempotent)', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    await ctx.controller.hangUp();
    expect(background.log).toEqual(['prepare', 'stop']);
  });

  it('never starts when session creation fails', async () => {
    const background = new FakeBackground();
    const ctx = setup({ background });
    void ctx.controller.start();
    await settle();
    ctx.create.reject(new Error('down'));
    await settle();
    await settle();
    expect(ctx.controller.getView().call.status).toBe('FAILED');
    expect(background.log.some((entry) => entry.startsWith('start'))).toBe(false);
  });

  it('stops only after an in-flight start settles, so the service never outlives the call', async () => {
    const background = new FakeBackground();
    const held = deferred<void>();
    background.startResult = held.promise;
    const ctx = setup({ background });
    await connect(ctx);
    const hangUp = ctx.controller.hangUp();
    await settle();
    expect(background.log).not.toContain('stop');
    held.resolve();
    await hangUp;
    expect(background.log.slice(-2)).toEqual(['started', 'stop']);
  });

  it('keeps the call when the service refuses to start', async () => {
    const background = new FakeBackground();
    const refused = deferred<void>();
    background.startResult = refused.promise;
    const ctx = setup({ background });
    await connect(ctx);
    refused.reject(new Error('background start not allowed'));
    await settle();
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.telemetry.map((event) => event.event)).toContain('background_start_failed');
    await ctx.controller.hangUp();
    expect(background.log.at(-1)).toBe('stop');
  });
});

describe('CallController mute (milestone 8)', () => {
  it('mutes and unmutes the microphone track and shows the state', async () => {
    const ctx = setup();
    await connect(ctx);
    expect(ctx.controller.getView().muted).toBe(false);
    await ctx.controller.setMuted(true);
    expect(ctx.controller.getView().muted).toBe(true);
    await ctx.controller.setMuted(false);
    expect(ctx.transport.muteCalls).toEqual([true, false]);
    expect(ctx.controller.getView().muted).toBe(false);
  });

  it('ignores a repeat of the current state', async () => {
    const ctx = setup();
    await connect(ctx);
    await ctx.controller.setMuted(false);
    expect(ctx.transport.muteCalls).toEqual([]);
  });

  it('reverts the visible state when the track refuses', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.failMute = true;
    await ctx.controller.setMuted(true);
    expect(ctx.controller.getView().muted).toBe(false);
    expect(ctx.telemetry.map((event) => event.event)).toContain('mute_failed');
  });

  it('does nothing before media is up or after the call ends', async () => {
    const ctx = setup();
    await ctx.controller.setMuted(true);
    expect(ctx.controller.getView().muted).toBe(false);
    await connect(ctx);
    await ctx.controller.hangUp();
    await ctx.controller.setMuted(true);
    expect(ctx.transport.muteCalls).toEqual([]);
  });

  it('stays muted across a reconnect and resets for the next call', async () => {
    const ctx = setup();
    await connect(ctx);
    await ctx.controller.setMuted(true);
    ctx.transport.emit({ type: 'reconnecting' });
    ctx.transport.emit({ type: 'reconnected' });
    expect(ctx.controller.getView().muted).toBe(true);
    await ctx.controller.hangUp();
    ctx.controller.reset();
    expect(ctx.controller.getView().muted).toBe(false);
  });
});

/**
 * Milestone 8 part A verifier: one ordered log across microphone, background service, session
 * API and a fresh transport per call, so end paths and back-to-back calls can be checked.
 */
function m8(
  options: { permission?: MicrophonePermission; background?: CallBackgroundService } = {},
) {
  const timers = new ManualTimers();
  const log: string[] = [];
  const transports: FakeTransport[] = [];
  const creates: ReturnType<typeof deferred<CreateCallResponse>>[] = [];
  const telemetry: CallTelemetryEvent[] = [];
  const background: CallBackgroundService = options.background ?? {
    setCallScreen: () => undefined,
    prepare: () => {
      log.push('prepare');
      return Promise.resolve();
    },
    start: ({ agentName }) => {
      log.push(`start:${agentName}`);
      return Promise.resolve();
    },
    stop: () => {
      log.push('stop');
      return Promise.resolve();
    },
  };
  const controller = new CallController({
    approvalApi: { decideApproval: () => Promise.resolve() },
    api: {
      create: () => {
        log.push('create');
        const created = deferred<CreateCallResponse>();
        creates.push(created);
        return created.promise;
      },
      end: (callId) => {
        log.push(`end:${callId}`);
        return Promise.resolve();
      },
    },
    createTransport: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    },
    microphone: {
      request: () => {
        log.push('mic');
        return Promise.resolve(options.permission ?? 'granted');
      },
    },
    background,
    timers,
    telemetry: (event) => telemetry.push(event),
  });
  /** Start → session created → transport connecting (connect() still pending). */
  const joinCall = async (agentName = 'Ada') => {
    void controller.start({}, agentName);
    await settle();
    creates.at(-1)!.resolve(SESSION);
    await settle();
  };
  const connectCall = async (agentName = 'Ada') => {
    await joinCall(agentName);
    transports.at(-1)!.connected.resolve();
    await settle();
    transports.at(-1)!.emit({ type: 'gateway_ready' });
    await settle();
  };
  const status = () => controller.getView().call.status;
  return { controller, timers, log, transports, telemetry, joinCall, connectCall, status };
}

const count = (log: string[], entry: string) => log.filter((e) => e === entry).length;

describe('background service end paths (milestone 8 verifier)', () => {
  it('asks mic first, then notifications, then creates the session', async () => {
    const ctx = m8();
    void ctx.controller.start();
    await settle();
    expect(ctx.log).toEqual(['mic', 'prepare', 'create']);
  });

  it('mic denied: never asks for notifications, never starts, stop is harmless', async () => {
    const ctx = m8({ permission: 'denied' });
    await ctx.controller.start();
    await settle();
    expect(ctx.status()).toBe('FAILED');
    expect(ctx.log).toEqual(['mic', 'stop']);
  });

  it('hang-up while the notification prompt is open never creates a session or starts', async () => {
    const prompt = deferred<void>();
    const log: string[] = [];
    const ctx = m8({
      background: {
        setCallScreen: () => undefined,
        prepare: () => {
          log.push('prepare');
          return prompt.promise;
        },
        start: () => {
          log.push('start');
          return Promise.resolve();
        },
        stop: () => {
          log.push('stop');
          return Promise.resolve();
        },
      },
    });
    void ctx.controller.start();
    await settle();
    await ctx.controller.hangUp();
    prompt.resolve();
    await settle();
    expect(ctx.status()).toBe('ENDED');
    expect(ctx.log).toEqual(['mic']); // no session was created
    expect(log).toEqual(['prepare', 'stop']);
  });

  it.each([
    ['network drop', { type: 'disconnected', cause: 'network' }],
    ['server end', { type: 'disconnected', cause: 'server_ended' }],
    ['gateway failure', { type: 'gateway_ending', reason: 'gateway_failed' }],
  ] as const)('stops exactly once on %s', async (_name, event: TransportEvent) => {
    const ctx = m8();
    await ctx.connectCall();
    ctx.transports[0].emit(event);
    await settle();
    expect(ctx.status()).toBe('FAILED');
    expect(count(ctx.log, 'start:Ada')).toBe(1);
    expect(count(ctx.log, 'stop')).toBe(1);
    expect(ctx.log.at(-1)).not.toBe('start:Ada');
  });

  it('stops once when reconnect is exhausted', async () => {
    const ctx = m8();
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'reconnecting' });
    ctx.timers.advance(CALL_TIMEOUTS.reconnectBudgetMs);
    await settle();
    expect(ctx.status()).toBe('FAILED');
    expect(count(ctx.log, 'stop')).toBe(1);
  });

  it('a failure while the start is in flight stops only after the start settles', async () => {
    const held = deferred<void>();
    const log: string[] = [];
    const ctx = m8({
      background: {
        setCallScreen: () => undefined,
        prepare: () => Promise.resolve(),
        start: () => {
          log.push('start');
          return held.promise.then(() => void log.push('started'));
        },
        stop: () => {
          log.push('stop');
          return Promise.resolve();
        },
      },
    });
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    expect(log).toEqual(['start']);
    held.resolve();
    await settle();
    expect(log).toEqual(['start', 'started', 'stop']);
  });

  it('notification End and on-screen End together hang up once', async () => {
    const ctx = m8();
    await ctx.connectCall();
    await Promise.all([ctx.controller.hangUp(), ctx.controller.hangUp()]);
    expect(ctx.status()).toBe('ENDED');
    expect(count(ctx.log, 'stop')).toBe(1);
    expect(count(ctx.log, `end:${CALL_ID}`)).toBe(1);
    expect(ctx.transports[0].disconnects).toBe(1);
  });

  it('notification End pressed after the call failed does nothing', async () => {
    const ctx = m8();
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    const before = [...ctx.log];
    await ctx.controller.hangUp();
    await settle();
    expect(ctx.status()).toBe('FAILED');
    expect(ctx.log).toEqual(before);
  });

  it('back-to-back calls start and stop the service once each, with each agent name', async () => {
    const ctx = m8();
    await ctx.connectCall('Ada');
    await ctx.controller.hangUp();
    ctx.controller.reset();
    await ctx.connectCall('Grace');
    expect(ctx.status()).toBe('LISTENING');
    expect(ctx.log.filter((e) => e.startsWith('start') || e === 'stop')).toEqual([
      'start:Ada',
      'stop',
      'start:Grace',
    ]);
  });

  it('retry straight from FAILED (no reset) still gives call 2 a running service', async () => {
    const ctx = m8();
    await ctx.connectCall('Ada');
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.connectCall('Grace');
    expect(ctx.status()).toBe('LISTENING');
    expect(ctx.log.filter((e) => e.startsWith('start') || e === 'stop')).toEqual([
      'start:Ada',
      'stop',
      'start:Grace',
    ]);
  });

  it("BUG: a slow start from call 1 lets call 1's deferred stop kill call 2's service", async () => {
    // Call 1 fails while its native start is still in flight; stop waits for that start. The user
    // retries and call 2 connects (starting the one shared service). Call 1's start then settles
    // and its deferred stop() runs, stopping the foreground service under a live call 2.
    const firstStart = deferred<void>();
    const log: string[] = [];
    let starts = 0;
    const ctx = m8({
      background: {
        setCallScreen: () => undefined,
        prepare: () => Promise.resolve(),
        start: ({ agentName }) => {
          log.push(`start:${agentName}`);
          starts += 1;
          return starts === 1 ? firstStart.promise : Promise.resolve();
        },
        stop: () => {
          log.push('stop');
          return Promise.resolve();
        },
      },
    });
    await ctx.connectCall('Ada');
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.connectCall('Grace');
    firstStart.resolve();
    await settle();
    expect(ctx.status()).toBe('LISTENING');
    // The service must still be running for call 2: the last service command is Grace's start.
    expect(log.at(-1)).toBe('start:Grace');
  });

  it('a native start that never settles still lets hang-up reach ENDED (bounded stop)', async () => {
    const ctx = m8({
      background: {
        setCallScreen: () => undefined,
        prepare: () => Promise.resolve(),
        start: () => new Promise<void>(() => undefined),
        stop: () => Promise.resolve(),
      },
    });
    await ctx.connectCall();
    void ctx.controller.hangUp();
    await settle();
    ctx.timers.advance(60_000);
    await settle();
    // stopBackground is bounded (backgroundStopMs): the call ends and a new call can start.
    expect(ctx.status()).toBe('ENDED');
    ctx.controller.reset();
    void ctx.controller.start();
    await settle();
    expect(ctx.status()).not.toBe('ENDED');
  });
});

describe('call screen lifecycle', () => {
  const screenBackground = (states: boolean[]): CallBackgroundService => ({
    prepare: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    setCallScreen: (active) => {
      states.push(active);
    },
  });

  it.each([
    ['hang-up', undefined],
    ['failure', { type: 'disconnected', cause: 'network' }],
    ['server end', { type: 'disconnected', cause: 'server_ended' }],
    ['agent hang-up', { type: 'gateway_ending', reason: 'agent_hangup' }],
  ] as const)('turns on once at connection and off on %s', async (_name, event) => {
    const states: boolean[] = [];
    const ctx = m8({ background: screenBackground(states) });
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'reconnecting' });
    ctx.transports[0].emit({ type: 'reconnected' });
    expect(states).toEqual([true]);
    if (event === undefined) await ctx.controller.hangUp();
    else ctx.transports[0].emit(event);
    await settle();
    expect(states).toEqual([true, false]);
  });

  it('clears screen state when hanging up during connect', async () => {
    const states: boolean[] = [];
    const ctx = m8({ background: screenBackground(states) });
    await ctx.joinCall();
    await ctx.controller.hangUp();
    expect(states).toEqual([false]);
  });

  it('an older release cannot turn off a newer call screen', async () => {
    const firstStart = deferred<void>();
    const states: boolean[] = [];
    let starts = 0;
    const background: CallBackgroundService = {
      ...screenBackground(states),
      start: () => (++starts === 1 ? firstStart.promise : Promise.resolve()),
    };
    const ctx = m8({ background });
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.connectCall();
    firstStart.resolve();
    await settle();
    expect(states).toEqual([true, false, true]);
  });

  it('logs a platform error and continues the call', async () => {
    const ctx = m8({
      background: {
        ...screenBackground([]),
        setCallScreen: () => {
          throw new Error('native failed');
        },
      },
    });
    await ctx.connectCall();
    expect(ctx.status()).toBe('LISTENING');
    await ctx.controller.hangUp();
    expect(ctx.status()).toBe('ENDED');
    expect(ctx.telemetry.filter((event) => event.event === 'call_screen_failed')).toHaveLength(2);
  });
});

describe('mute edge cases (milestone 8 verifier)', () => {
  it('is idempotent while a change is in flight', async () => {
    const ctx = m8();
    await ctx.connectCall();
    await Promise.all([ctx.controller.setMuted(true), ctx.controller.setMuted(true)]);
    expect(ctx.transports[0].muteCalls).toEqual([true]);
    expect(ctx.controller.getView().muted).toBe(true);
  });

  it('a failed mute followed at once by unmute ends unmuted', async () => {
    const ctx = m8();
    await ctx.connectCall();
    const transport = ctx.transports[0];
    transport.failMute = true;
    const muting = ctx.controller.setMuted(true);
    const unmuting = ctx.controller.setMuted(false);
    transport.failMute = false; // the queued unmute runs after the failure and succeeds
    await Promise.all([muting, unmuting]);
    expect(transport.muteCalls).toEqual([true, false]);
    expect(ctx.controller.getView().muted).toBe(false);
  });

  it('an unmute that fails after a successful mute shows muted (the truth)', async () => {
    const ctx = m8();
    await ctx.connectCall();
    const transport = ctx.transports[0];
    await ctx.controller.setMuted(true);
    transport.failMute = true;
    await ctx.controller.setMuted(false);
    expect(ctx.controller.getView().muted).toBe(true);
    expect(transport.muteCalls).toEqual([true, false]);
  });

  it('ignores mute while ENDING', async () => {
    const held = deferred<void>();
    const ctx = m8({
      background: {
        setCallScreen: () => undefined,
        prepare: () => Promise.resolve(),
        start: () => held.promise,
        stop: () => Promise.resolve(),
      },
    });
    await ctx.connectCall();
    void ctx.controller.hangUp();
    await settle();
    expect(ctx.status()).toBe('ENDING');
    await ctx.controller.setMuted(true);
    expect(ctx.controller.getView().muted).toBe(false);
    expect(ctx.transports[0].muteCalls).toEqual([]);
    held.resolve();
  });

  it('ignores mute after FAILED', async () => {
    const ctx = m8();
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.controller.setMuted(true);
    expect(ctx.controller.getView().muted).toBe(false);
    expect(ctx.transports[0].muteCalls).toEqual([]);
  });

  it('stays muted through a gateway drop and resets for a retry started from FAILED', async () => {
    const ctx = m8();
    await ctx.connectCall();
    await ctx.controller.setMuted(true);
    ctx.transports[0].emit({ type: 'gateway_lost' });
    ctx.transports[0].emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().muted).toBe(true);
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.connectCall('Grace');
    expect(ctx.controller.getView().muted).toBe(false);
  });

  it('BUG: mute before media is connected reaches the transport, which then unmutes on join', async () => {
    // setMuted's doc says "Only while media is up", but the guard only checks that a transport
    // exists, and the transport is assigned before connect() resolves. LiveKitCallTransport's
    // connect() calls setMicrophoneEnabled(true) after that, so the view says muted while the mic
    // is live. (The call screen hides Mute until connected, so only the API is exposed today.)
    const ctx = m8();
    await ctx.joinCall();
    expect(ctx.status()).toBe('CONNECTING');
    await ctx.controller.setMuted(true);
    expect(ctx.transports[0].muteCalls).toEqual([]);
    expect(ctx.controller.getView().muted).toBe(false);
  });

  it('BUG: a hung mute from call 1 blocks every mute in call 2 while the view says muted', async () => {
    const ctx = m8();
    await ctx.connectCall('Ada');
    const first = ctx.transports[0];
    first.setMicrophoneMuted = (muted: boolean) => {
      first.muteCalls.push(muted);
      return new Promise<void>(() => undefined); // e.g. the room went away mid-call
    };
    void ctx.controller.setMuted(true);
    first.emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.connectCall('Grace');
    void ctx.controller.setMuted(true);
    await settle();
    expect(ctx.controller.getView().muted).toBe(true);
    // The new call's microphone must actually be muted.
    expect(ctx.transports[1].muteCalls).toEqual([true]);
  });
});

/** The session.ts wiring: one haptic per feedbackFor() result on each call-state change. */
function recordFeedback(controller: CallController): string[] {
  const played: string[] = [];
  let previous = controller.getView().call;
  controller.subscribe(() => {
    const next = controller.getView().call;
    if (next === previous) return;
    const feedback = feedbackFor(previous, next);
    if (feedback !== undefined) played.push(feedback);
    previous = next;
  });
  return played;
}

const floor = (seq: number, value: FloorMessage['floor'], turn?: string): TransportEvent => ({
  type: 'status',
  message: {
    type: 'floor',
    seq,
    floor: value,
    ...(turn !== undefined && { turn_id: turn }),
  } as FloorMessage,
});

describe('haptics over a whole call (milestone 8 verifier)', () => {
  it('fires connected, reconnected, ended and nothing for speech turns or catch-up floors', async () => {
    const ctx = m8();
    const played = recordFeedback(ctx.controller);
    await ctx.connectCall();
    const t = ctx.transports[0];
    let seq = 0;
    for (let turn = 0; turn < 5; turn += 1) {
      t.emit(floor(++seq, 'user_speaking'));
      t.emit(floor(++seq, 'agent_working', `turn_${turn}`));
      t.emit(floor(++seq, 'agent_speaking', `turn_${turn}`));
      t.emit(floor(++seq, 'listening'));
    }
    t.emit({ type: 'reconnecting' });
    t.emit(floor(seq + 1, 'agent_speaking', 'turn_9'));
    t.emit({ type: 'reconnected' }); // lands in LISTENING, then catches up to AGENT_SPEAKING
    expect(ctx.status()).toBe('AGENT_SPEAKING');
    t.emit({ type: 'gateway_lost' });
    t.emit({ type: 'gateway_ready' });
    await ctx.controller.hangUp();
    expect(played).toEqual(['connected', 'reconnected', 'reconnected', 'ended']);
  });

  it('fires one error for a failure and nothing for the next call until it connects', async () => {
    const ctx = m8();
    const played = recordFeedback(ctx.controller);
    await ctx.connectCall();
    ctx.transports[0].emit({ type: 'disconnected', cause: 'network' });
    await settle();
    await ctx.controller.hangUp(); // notification End after failure
    await ctx.joinCall('Grace');
    expect(played).toEqual(['connected', 'error']);
  });
});

describe('CallController audio levels', () => {
  it('passes levels through only while connected, silencing a muted mic', async () => {
    const ctx = setup();
    void ctx.controller.start();
    await settle();
    ctx.create.resolve(SESSION);
    await settle();
    // Not connected yet: no level may drive the visualizer.
    ctx.transport.emit({ type: 'levels', levels: { local: 0.5, remote: 0.5 } });
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
    ctx.transport.connected.resolve();
    await settle();
    ctx.transport.emit({ type: 'gateway_ready' });

    ctx.transport.emit({ type: 'levels', levels: { local: 0.6, remote: 0.2 } });
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0.6, remote: 0.2 });

    void ctx.controller.setMuted(true);
    ctx.timers.advance(1000);
    expect(ctx.controller.levels.getLevels().local).toBe(0);
    ctx.transport.emit({ type: 'levels', levels: { local: 0.9, remote: 0.3 } });
    ctx.timers.advance(1000);
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0.3 });
  });

  it('drops to silence while reconnecting and when the call ends', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'levels', levels: { local: 0.4, remote: 0.7 } });
    ctx.transport.emit({ type: 'reconnecting' });
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
    ctx.transport.emit({ type: 'levels', levels: { local: 0.4, remote: 0.7 } });
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
    ctx.transport.emit({ type: 'reconnected' });
    ctx.timers.advance(1000);
    ctx.transport.emit({ type: 'levels', levels: { local: 0.4, remote: 0.7 } });
    expect(ctx.controller.levels.getLevels().remote).toBe(0.7);
    await ctx.controller.hangUp();
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
  });
});

describe('CallController audio levels (milestone 9 verifier)', () => {
  it('a trailing level pending at hang-up never lands, and later level events are ignored', async () => {
    const ctx = setup();
    await connect(ctx);
    let published = 0;
    ctx.controller.levels.subscribe(() => (published += 1));
    ctx.transport.emit({ type: 'levels', levels: { local: 0.2, remote: 0.2 } });
    // Inside the throttle window: held for a trailing publish.
    ctx.transport.emit({ type: 'levels', levels: { local: 0.9, remote: 0.9 } });
    await ctx.controller.hangUp();
    const afterEnd = published;
    ctx.timers.advance(1000);
    ctx.transport.emit({ type: 'levels', levels: { local: 1, remote: 1 } });
    ctx.timers.advance(1000);
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
    expect(published).toBe(afterEnd);
  });

  it('muting clears a louder sample still waiting in the throttle', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'levels', levels: { local: 0.3, remote: 0.1 } });
    ctx.transport.emit({ type: 'levels', levels: { local: 0.95, remote: 0.1 } });
    void ctx.controller.setMuted(true);
    ctx.timers.advance(1000);
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0.1 });
  });

  it('treats NaN, infinite, and out-of-range transport levels as bounded', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'levels', levels: { local: Number.NaN, remote: 3 } });
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 1 });
    ctx.timers.advance(1000);
    ctx.transport.emit({
      type: 'levels',
      levels: { local: Number.POSITIVE_INFINITY, remote: -0.5 },
    });
    const { local, remote } = ctx.controller.levels.getLevels();
    expect(local).toBeGreaterThanOrEqual(0);
    expect(local).toBeLessThanOrEqual(1);
    expect(remote).toBe(0);
  });

  it('a failed call (network lost) drops levels at once', async () => {
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'levels', levels: { local: 0.5, remote: 0.5 } });
    ctx.transport.emit({ type: 'disconnected', cause: 'network' });
    await settle();
    expect(ctx.controller.getView().call.status).toBe('FAILED');
    expect(ctx.controller.levels.getLevels()).toEqual({ local: 0, remote: 0 });
  });
});

describe('CallController answered invite', () => {
  it('joins the session the answer created, without creating another', async () => {
    const create = vi.fn<CallApi['create']>();
    const ctx = setup({ create });
    void ctx.controller.start({ agent_id: 'agt_x' }, 'Claude', SESSION);
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(ctx.controller.getView().call.status).toBe('CONNECTING');
    ctx.transport.connected.resolve();
    await settle();
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
  });

  it('ends the answered call on the server when the microphone is denied', async () => {
    const ctx = setup({ permission: 'denied' });
    await ctx.controller.start({}, 'Claude', SESSION);
    await settle();
    expect(ctx.controller.getView().call.status).toBe('FAILED');
    expect(ctx.ended).toEqual([SESSION.call_id]);
  });

  it('answering ends the call still on the phone and joins the answered one', async () => {
    const ctx = setup();
    await connect(ctx);
    void ctx.controller.start({}, 'Claude', { ...SESSION, call_id: 'call_other' });
    await settle();
    await settle();
    // The old call ends on the server; the answered one is joined, never ended.
    expect(ctx.ended).toEqual([SESSION.call_id]);
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.ended).toEqual([SESSION.call_id]);
    expect(ctx.invalid).toEqual([]);
  });

  it('answering while the old call is still reconnecting joins the answered call', async () => {
    // Device, 2026-10-08: a gateway restart left the call reconnecting; answering the agent's ring
    // hung up the new call 136 ms after the server created it.
    const ctx = setup();
    await connect(ctx);
    ctx.transport.emit({ type: 'reconnecting' });
    expect(ctx.controller.getView().call.status).toBe('RECONNECTING');
    void ctx.controller.start({}, 'Claude', { ...SESSION, call_id: 'call_answered' });
    await settle();
    await settle();
    expect(ctx.ended).toEqual([SESSION.call_id]);
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    // The old call's reconnect budget never fails the new call.
    ctx.timers.advance(60_000);
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.ended).not.toContain('call_answered');
  });

  it('answering just after a hang-up waits for it instead of hanging up twice', async () => {
    const ctx = setup();
    await connect(ctx);
    void ctx.controller.hangUp();
    void ctx.controller.start({}, 'Claude', { ...SESSION, call_id: 'call_answered' });
    await settle();
    await settle();
    expect(ctx.ended).toEqual([SESSION.call_id]);
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.invalid).toEqual([]);
  });

  it('two answers at once: exactly one joins, the other is ended on the server', async () => {
    const ctx = setup();
    await connect(ctx);
    void ctx.controller.start({}, 'Claude', { ...SESSION, call_id: 'call_a' });
    void ctx.controller.start({}, 'Claude', { ...SESSION, call_id: 'call_b' });
    await settle();
    await settle();
    expect(ctx.ended).toHaveLength(2);
    expect(ctx.ended[0]).toBe(SESSION.call_id);
    expect(['call_a', 'call_b']).toContain(ctx.ended[1]);
    ctx.transport.emit({ type: 'gateway_ready' });
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.invalid).toEqual([]);
  });

  it('a new outgoing call is still ignored while a call is active', async () => {
    const create = vi.fn<CallApi['create']>();
    const ctx = setup({ create });
    await connect2(ctx);
    await ctx.controller.start({ agent_id: 'agt_x' }, 'Claude');
    expect(create).not.toHaveBeenCalled();
    expect(ctx.controller.getView().call.status).toBe('LISTENING');
    expect(ctx.ended).toEqual([]);
  });
});

/** Drives an answered call to LISTENING (no create request). */
async function connect2(ctx: ReturnType<typeof setup>) {
  void ctx.controller.start({}, 'Claude', SESSION);
  await settle();
  ctx.transport.connected.resolve();
  await settle();
  ctx.transport.emit({ type: 'gateway_ready' });
}
