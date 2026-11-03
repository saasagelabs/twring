import {
  AUDIO_EXPIRED_MESSAGE,
  AUDIO_LIMIT_REACHED_MESSAGE,
  AUDIO_PAUSED_MESSAGE,
  AUDIO_UNAVAILABLE_MESSAGE,
  AUDIO_UNREACHABLE_MESSAGE,
  INITIAL_CALL_STATE,
  isActive,
  isConnected,
  isTerminal,
  reduceCall,
  type CallError,
  type CallErrorCode,
  type CallEvent,
  type CallState,
  type CreateCallRequest,
  type CreateCallResponse,
  type Floor,
  type GatewayEndReason,
  type FloorMessage,
  type NoticeMessage,
  type StatusMessage,
  type ApprovalAction,
} from '@twring/contracts';
import { ApiError, type TwringApi } from '../api/client';
import { keyRefusedCallMessage } from '../settings/voice-accounts';
import { dailyLimitMessage, serviceBusyMessage } from '../usage/copy';

import { CallApiError, type CallApi } from './api';
import type { DownlinkWindow } from './downlink';
import { CallLevels } from './levels';
import { CALL_TIMEOUTS, deadline, type Timers } from './timers';
import {
  MicrophoneError,
  type CallBackgroundService,
  type CallTransport,
  type MicrophonePermissionService,
  type TransportEvent,
} from './transport';

/** What the UI renders. Derived from the state machine, never from loose flags (§12). */
export interface CallView {
  call: CallState;
  /** Latest proof that the gateway hears the phone's microphone. */
  inbound?: { peakDbfs: number; framesReceived: number; at: number };
  /** Latest caption of what the caller said; `final` once the turn is committed. */
  caption?: { turnIndex: number; text: string; final: boolean };
  /** What the agent is saying in reply, as it streams; `final` once the agent finished. */
  reply?: { turnId: string; text: string; final: boolean };
  /** The last turn didn't get an answer; cleared when the caller speaks again. */
  notice?: NoticeMessage['code'];
  /** When the call first reached LISTENING (for the duration clock). */
  connectedAt?: number;
  /** When the call ended or failed. */
  finishedAt?: number;
  /** The caller muted their microphone. Reset for every call. */
  muted: boolean;
  approval?: {
    id: string;
    agentName: string;
    action: ApprovalAction;
    title: string;
    description?: string;
    expiresAt: number;
  };
  approvalError?: boolean;
}

/** Safe, structured telemetry. Never transcript or credential content. */
export interface CallTelemetryEvent {
  event: string;
  call_id?: string;
  /** Milliseconds since the user started this call; lets one call's steps be lined up. */
  t_ms?: number;
  duration_ms?: number;
  from?: string;
  to?: string;
  error_code?: CallErrorCode;
  detail?: string;
  /** Gateway → phone audio received in one sampling window. */
  downlink?: DownlinkWindow;
}

export interface CallControllerDeps {
  api: CallApi;
  approvalApi: Pick<TwringApi, 'decideApproval'>;
  createTransport: () => CallTransport;
  microphone: MicrophonePermissionService;
  /** Keeps the connected call alive in the background; absent in tests that don't care. */
  background?: CallBackgroundService;
  timers: Timers;
  telemetry: (event: CallTelemetryEvent) => void;
  /** Development builds surface illegal transitions loudly (§13). */
  onInvalidTransition?: (state: CallState, event: CallEvent) => void;
  timeouts?: Partial<typeof CALL_TIMEOUTS>;
}

/**
 * Seconds of Twring reporting no audio from an unmuted phone before the microphone is restarted:
 * an Android phone has been seen to stop sending it while the call went on ("Waiting for audio…").
 */
export const MIC_STALL_REPORTS = 4;
/** Restarts tried in one call; past that, something else is wrong and retrying won't fix it. */
export const MAX_MIC_RESTARTS = 3;

const COPY: Record<CallErrorCode, { message: string; retryable: boolean }> = {
  CALL_AUTH_FAILED: { message: 'Sign in again to place calls.', retryable: false },
  CALL_SESSION_CREATE_FAILED: {
    message: "We couldn't start the call. Check your connection and try again.",
    retryable: true,
  },
  CALL_CAPACITY_EXCEEDED: {
    message: 'All call lines are busy. Try again in a minute.',
    retryable: true,
  },
  // Replaced with the reset time where it is known (`dailyLimitMessage`).
  DAILY_LIMIT_REACHED: {
    message: "You've used today's calling time. It resets at midnight UTC.",
    retryable: false,
  },
  // Replaced with the local reset time where it is known (`serviceBusyMessage`).
  SERVICE_BUSY: {
    message: 'Twring is very busy today. Try again after midnight UTC.',
    retryable: false,
  },
  LIVEKIT_CONNECT_FAILED: {
    message: "We couldn't connect the call. Check your connection and try again.",
    retryable: true,
  },
  GATEWAY_UNAVAILABLE: {
    message: "Twring didn't pick up. Try again in a moment.",
    retryable: true,
  },
  AGENT_CONNECT_FAILED: {
    message: "We couldn't reach your agent. Check that it's running, then try again.",
    retryable: true,
  },
  AGENT_OFFLINE: {
    message: "Your computer is offline. Make sure it's on and online, then call again.",
    retryable: true,
  },
  AGENT_NOT_ON_COMPUTER: {
    message: "This agent isn't set up on your computer anymore.",
    retryable: false,
  },
  CONNECTOR_REMOVED: {
    message: 'Computer removed. Pair it again.',
    retryable: false,
  },
  CALL_IN_PROGRESS: {
    message: "You're already on a call. End it first.",
    retryable: true,
  },
  VOICE_UNAVAILABLE: {
    message: "Twring's voice service isn't available right now. Try again in a moment.",
    retryable: true,
  },
  MIC_PERMISSION_DENIED: {
    message: 'Twring needs microphone access to hear you. Turn it on in Settings.',
    retryable: false,
  },
  MIC_UNAVAILABLE: {
    message: "Your microphone isn't available. Close other apps using it and try again.",
    retryable: true,
  },
  NETWORK_LOST: {
    message: 'Your connection dropped, so the call ended. Call again once you are back online.',
    retryable: true,
  },
  RECONNECT_EXHAUSTED: {
    message: "We couldn't reconnect the call. Try calling again.",
    retryable: true,
  },
  CALL_ENDED_BY_SERVER: { message: 'Twring ended the call. You can call again.', retryable: true },
  UNKNOWN_CALL_FAILURE: {
    message: 'Something went wrong with the call. Try calling again.',
    retryable: true,
  },
  SPEECH_KEY_REFUSED: {
    message:
      'Your voice account key was refused, so the call ended. Update it in Settings, Your own voice accounts.',
    retryable: false,
  },
  AUDIO_UNAVAILABLE: { message: AUDIO_UNAVAILABLE_MESSAGE, retryable: true },
  AUDIO_UNREACHABLE: { message: AUDIO_UNREACHABLE_MESSAGE, retryable: false },
  AUDIO_PAUSED: { message: AUDIO_PAUSED_MESSAGE, retryable: false },
  AUDIO_EXPIRED: { message: AUDIO_EXPIRED_MESSAGE, retryable: false },
  AUDIO_LIMIT_REACHED: { message: AUDIO_LIMIT_REACHED_MESSAGE, retryable: true },
};

export function callError(
  code: CallErrorCode,
  correlationId?: string,
  message?: string,
): CallError {
  return {
    code,
    ...COPY[code],
    ...(message !== undefined && { message }),
    ...(correlationId !== undefined && { correlationId }),
  };
}

function toFloor(message: FloorMessage): Floor {
  switch (message.floor) {
    case 'listening':
      return { kind: 'listening' };
    case 'user_speaking':
      return { kind: 'user_speaking' };
    case 'agent_working':
      return {
        kind: 'agent_working',
        turnId: message.turn_id ?? '',
        ...(message.activity !== undefined && { activity: message.activity }),
      };
    case 'agent_speaking':
      return { kind: 'agent_speaking', turnId: message.turn_id ?? '' };
  }
}

function sameFloor(state: CallState, floor: Floor): boolean {
  switch (floor.kind) {
    case 'listening':
      return state.status === 'LISTENING';
    case 'user_speaking':
      return state.status === 'USER_SPEAKING';
    case 'agent_working':
      return (
        state.status === 'AGENT_WORKING' &&
        state.turnId === floor.turnId &&
        state.activity === floor.activity
      );
    case 'agent_speaking':
      return state.status === 'AGENT_SPEAKING' && state.turnId === floor.turnId;
  }
}

/** The view without the previous answer or notice. */
function withoutReply(view: CallView): CallView {
  const next = { ...view };
  delete next.reply;
  delete next.notice;
  return next;
}

/** The failure a gateway end reason means for the caller; undefined when it isn't a failure. */
function endReasonErrorCode(reason: GatewayEndReason): CallErrorCode | undefined {
  switch (reason) {
    case 'agent_unavailable':
      return 'AGENT_CONNECT_FAILED';
    case 'agent_offline':
      return 'AGENT_OFFLINE';
    case 'agent_not_on_computer':
      return 'AGENT_NOT_ON_COMPUTER';
    case 'voice_unavailable':
    case 'voice_failed':
      return 'VOICE_UNAVAILABLE';
    case 'gateway_failed':
      return 'GATEWAY_UNAVAILABLE';
    case 'daily_limit':
      return 'DAILY_LIMIT_REACHED';
    case 'deepgram_key_refused':
    case 'cartesia_key_refused':
    case 'xai_key_refused':
      return 'SPEECH_KEY_REFUSED';
    case 'hangup':
    case 'caller_left':
    case 'max_duration':
    case 'shutdown':
    case 'agent_hangup':
      // The room closing right after reports these (CALL_ENDED_BY_SERVER).
      return undefined;
  }
}

function sessionErrorCode(error: unknown): CallErrorCode {
  if (error instanceof CallApiError) {
    if (error.code === 'capacity_exceeded') return 'CALL_CAPACITY_EXCEEDED';
    if (error.code === 'daily_limit_reached') return 'DAILY_LIMIT_REACHED';
    if (error.code === 'service_busy') return 'SERVICE_BUSY';
    if (error.code === 'call_in_progress') return 'CALL_IN_PROGRESS';
    if (error.code === 'agent_offline') return 'AGENT_OFFLINE';
    if (error.code === 'agent_not_on_computer') return 'AGENT_NOT_ON_COMPUTER';
    if (error.code === 'connector_invalid') return 'CONNECTOR_REMOVED';
    if (error.code === 'speech_key_unreadable') return 'SPEECH_KEY_REFUSED';
    if (error.code === 'audio_unavailable') return 'AUDIO_UNAVAILABLE';
    if (error.code === 'audio_unreachable') return 'AUDIO_UNREACHABLE';
    if (error.code === 'audio_paused') return 'AUDIO_PAUSED';
    if (error.code === 'audio_expired') return 'AUDIO_EXPIRED';
    if (error.code === 'audio_limit_reached') return 'AUDIO_LIMIT_REACHED';
  }
  return 'CALL_SESSION_CREATE_FAILED';
}

/**
 * Drives one call at a time through the shared state machine: permission → session → media →
 * gateway readiness → reconnect → hang-up, with every timeout named and every resource released
 * exactly once. React subscribes via subscribe()/getView().
 */
export class CallController {
  private view: CallView = { call: INITIAL_CALL_STATE, muted: false };
  private readonly listeners = new Set<() => void>();
  private readonly timeouts: typeof CALL_TIMEOUTS;
  private readonly cancelTimers = new Map<string, () => void>();
  private transport: CallTransport | undefined;
  /** Consecutive audio reports with nothing from this phone, and restarts tried this call. */
  private silentReports = 0;
  private micRestarts = 0;
  /** Twring has heard this phone since it (re)connected; only then does silence count. */
  private micHeard = false;
  /** A restart that audio has not followed yet; the first audio after it is reported. */
  private micRestartPending = false;
  /** Latest floor from the gateway (highest seq); applied whenever the call is connected. */
  private floor: FloorMessage | undefined;
  private attempt: AbortController | undefined;
  private callId: string | undefined;
  private startedAt = 0;
  private reconnectStartedAt = 0;
  private cleanup: Promise<void> | undefined;
  /** Who the ongoing-call notification names. */
  private agentName = '';
  /** The in-flight background start, so stop() always runs after it. */
  private background: Promise<void> | undefined;
  /** Serializes mute changes so the track ends in the last requested state. */
  private muting: Promise<void> = Promise.resolve();
  /** Media connected at least once this call; before that the mic is not ours to mute. */
  private mediaConnected = false;
  /** Bumped by each background start; a stop from an older call must not stop a newer call's service. */
  private backgroundGeneration = 0;
  /** Generation that owns the shared call-screen mode. */
  private screenGeneration = 0;
  /** The platform refused the background service this call; retried when the app is visible. */
  private backgroundRefused = false;
  private decidingApproval = false;
  /**
   * Live audio levels for the visualizer. A separate store so level updates (~12 Hz) never touch
   * the call view or re-render anything but the visualizer.
   */
  readonly levels: CallLevels;

  constructor(private readonly deps: CallControllerDeps) {
    this.timeouts = { ...CALL_TIMEOUTS, ...deps.timeouts };
    this.levels = new CallLevels(deps.timers);
  }

  getView = (): CallView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Starts a new call, to a saved agent when `request.agent_id` is set. Ignored while one is active.
   * `answered` is a session the server already created (an answered invite): it is joined instead
   * of creating one, and ended on the server if the call cannot go ahead.
   *
   * Answering is the owner choosing that call, as on a phone, so a call still on this phone ends
   * first. The server rings only an owner it holds no live call for, so that call is usually one a
   * gateway restart already lost and is still reconnecting here.
   */
  async start(
    request: CreateCallRequest = {},
    agentName = 'Twring test line',
    answered?: CreateCallResponse,
  ): Promise<void> {
    if (isActive(this.view.call)) {
      if (answered === undefined) return;
      this.track('replaced_by_answer');
      await (this.view.call.status === 'ENDING' ? this.cleanup : this.hangUp());
      // Another start won the race while the old call wound down: this answer cannot go ahead.
      if (isActive(this.view.call)) {
        void this.endOnServer(answered.call_id);
        return;
      }
    }
    this.view = { call: INITIAL_CALL_STATE, muted: false };
    this.decidingApproval = false;
    this.agentName = agentName;
    this.background = undefined;
    this.backgroundRefused = false;
    this.cleanup = undefined;
    this.callId = undefined;
    this.floor = undefined;
    // A mute left hanging by the previous call must not block this one.
    this.muting = Promise.resolve();
    this.mediaConnected = false;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.startedAt = this.deps.timers.now();
    this.dispatch({ type: 'START_REQUESTED' });

    const abandon = () => {
      if (answered !== undefined) void this.endOnServer(answered.call_id);
    };
    const permission = await this.deps.microphone.request();
    this.track('mic_permission_checked');
    if (!this.current(attempt)) return abandon();
    if (permission === 'denied' || permission === 'blocked') {
      this.fail('MIC_PERMISSION_DENIED');
      return abandon();
    }
    // Ask for the ongoing-call notification now, while the caller is looking; denial is fine.
    await this.deps.background?.prepare();
    if (!this.current(attempt)) return abandon();

    let session;
    const prepare = deadline(attempt.signal, this.timeouts.prepareMs, this.deps.timers);
    try {
      session = answered ?? (await this.deps.api.create(prepare.signal, request));
    } catch (error) {
      if (this.current(attempt)) {
        const code = sessionErrorCode(error);
        this.fail(
          code,
          error instanceof CallApiError ? error.requestId : undefined,
          !(error instanceof CallApiError)
            ? undefined
            : code === 'DAILY_LIMIT_REACHED'
              ? dailyLimitMessage(error.resetsAt)
              : code === 'SERVICE_BUSY'
                ? serviceBusyMessage(error.resetsAt)
                : code === 'SPEECH_KEY_REFUSED'
                  ? (error.serverMessage ??
                    "Couldn't read your saved voice account key. Add it again in Settings.")
                  : undefined,
        );
      }
      return;
    } finally {
      prepare.dispose();
    }
    this.callId = session.call_id;
    // Hung up while the request was in flight: the server call exists, so end it too.
    if (!this.current(attempt)) {
      void this.endOnServer(session.call_id);
      return;
    }
    this.dispatch({ type: 'SESSION_CREATED', callId: session.call_id });
    this.track('session_created');
    this.timer('gateway_ready', this.timeouts.gatewayReadyMs, () =>
      this.fail('GATEWAY_UNAVAILABLE'),
    );

    const transport = this.deps.createTransport();
    this.transport = transport;
    this.silentReports = 0;
    this.micRestarts = 0;
    this.micHeard = false;
    this.micRestartPending = false;
    const media = deadline(attempt.signal, this.timeouts.mediaConnectMs, this.deps.timers);
    try {
      await transport.connect(
        { url: session.livekit.url, token: session.livekit.token },
        (event) => {
          if (this.current(attempt)) this.onTransportEvent(event);
        },
        media.signal,
      );
    } catch (error) {
      if (!this.current(attempt)) return;
      if (error instanceof MicrophoneError) {
        this.fail(error.reason === 'denied' ? 'MIC_PERMISSION_DENIED' : 'MIC_UNAVAILABLE');
      } else {
        this.fail('LIVEKIT_CONNECT_FAILED');
      }
      return;
    } finally {
      media.dispose();
    }
    if (!this.current(attempt)) return;
    this.mediaConnected = true;
    this.track('media_connected');
    this.dispatch({ type: 'MEDIA_CONNECTED' });
    // Belt and braces: connect() enables the mic, so re-apply a mute the view already shows.
    if (this.view.muted) void this.applyMute(transport, true);
  }

  /** User hang-up. Idempotent; resolves when every resource is released. */
  async hangUp(): Promise<void> {
    if (!isActive(this.view.call)) return this.cleanup;
    this.track('hangup_requested');
    this.dispatch({ type: 'END_REQUESTED' });
    await this.release();
    this.dispatch({ type: 'CLEANUP_COMPLETE' });
  }

  /** The first tap is sent once; a resolved or replaced card never changes a newer approval. */
  async decideApproval(decision: 'approve' | 'deny'): Promise<void> {
    const approval = this.view.approval;
    const callId = this.callId;
    if (this.decidingApproval || approval === undefined || callId === undefined) return;
    this.decidingApproval = true;
    if (this.view.approvalError) {
      this.view = { ...this.view, approvalError: false };
      this.emit();
    }
    try {
      await this.deps.approvalApi.decideApproval(
        callId,
        approval.id,
        decision,
        this.attempt?.signal,
      );
      if (this.view.approval?.id === approval.id) this.clearApproval();
    } catch (error) {
      if (this.view.approval?.id !== approval.id) return;
      if (
        error instanceof ApiError &&
        error.kind === 'http' &&
        (error.status === 404 || error.status === 409)
      ) {
        this.clearApproval();
      } else if (isActive(this.view.call)) {
        this.view = { ...this.view, approvalError: true };
        this.emit();
      }
    } finally {
      this.decidingApproval = false;
    }
  }

  private clearApproval(): void {
    const next = { ...this.view };
    delete next.approval;
    delete next.approvalError;
    this.view = next;
    this.emit();
  }

  /**
   * Mutes or unmutes the caller's microphone. Only while media is up; a muted mic sends silence,
   * so the gateway never hears speech to barge in with.
   */
  setMuted(muted: boolean): Promise<void> {
    const transport = this.transport;
    if (
      transport === undefined ||
      !this.mediaConnected ||
      !isActive(this.view.call) ||
      this.view.call.status === 'ENDING'
    ) {
      return Promise.resolve();
    }
    if (this.view.muted === muted) return this.muting;
    this.view = { ...this.view, muted };
    if (muted) this.levels.push({ local: 0, remote: this.levels.getLevels().remote });
    this.emit();
    this.track(muted ? 'mic_muted' : 'mic_unmuted');
    return this.applyMute(transport, muted);
  }

  /**
   * Twring hears nothing from an unmuted phone for a few seconds: the microphone is restarted, at
   * most a few times a call, and each try is reported so the cause can be found.
   */
  private watchMicrophone(framesReceived: number): void {
    const transport = this.transport;
    if (framesReceived > 0) {
      this.silentReports = 0;
      this.micHeard = true;
      if (this.micRestartPending) {
        this.micRestartPending = false;
        this.micTelemetry('mic_recovered', `attempt ${this.micRestarts}`);
      }
      return;
    }
    // Empty reports before the first audio (call start, just after a reconnect) are not a stall.
    if (
      transport === undefined ||
      this.view.muted ||
      !isConnected(this.view.call) ||
      !this.micHeard
    ) {
      this.silentReports = 0;
      return;
    }
    this.silentReports += 1;
    if (this.silentReports < MIC_STALL_REPORTS || this.micRestarts >= MAX_MIC_RESTARTS) return;
    this.silentReports = 0;
    this.micRestarts += 1;
    const attempt = `attempt ${this.micRestarts}`;
    // Serialized with mute changes, so a restart never races the mute button.
    this.muting = this.muting.then(async () => {
      // Muted or hung up while it waited: the microphone is not to be touched.
      if (this.transport !== transport || this.view.muted) return;
      try {
        await this.bounded(transport.restartMicrophone(), this.timeouts.muteMs, true);
        this.micRestartPending = true;
        this.micTelemetry('mic_restarted', attempt);
      } catch (error) {
        this.micTelemetry('mic_restart_failed', error instanceof Error ? error.name : 'Error');
      }
    });
  }

  private micTelemetry(event: string, detail: string): void {
    this.emitTelemetry({
      event,
      ...(this.callId !== undefined && { call_id: this.callId }),
      detail,
    });
  }

  /** Queues one bounded track change; a failure or timeout rolls the view back to the truth. */
  private applyMute(transport: CallTransport, muted: boolean): Promise<void> {
    this.muting = this.muting.then(async () => {
      try {
        await this.bounded(transport.setMicrophoneMuted(muted), this.timeouts.muteMs, true);
      } catch {
        // Show the truth: the track did not change.
        this.track('mute_failed');
        if (this.transport === transport && this.view.muted === muted) {
          this.view = { ...this.view, muted: !muted };
          this.emit();
        }
      }
    });
    return this.muting;
  }

  /**
   * Settles when `promise` does or after `ms`, whichever is first. With `rejectOnTimeout` the
   * timeout rejects; otherwise it resolves. Never rejects with the promise's own error otherwise.
   */
  private bounded(promise: Promise<void>, ms: number, rejectOnTimeout: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cancel = this.deps.timers.setTimeout(() => {
        if (rejectOnTimeout) {
          const timeout = new Error('timed out');
          timeout.name = 'TimeoutError';
          reject(timeout);
        } else resolve();
      }, ms);
      promise.then(
        () => {
          cancel();
          resolve();
        },
        (error: unknown) => {
          cancel();
          reject(error instanceof Error ? error : new Error('failed'));
        },
      );
    });
  }

  /**
   * The platform refused the background service after start() had resolved (Android: the service
   * could not enter the foreground). The call keeps working while visible.
   */
  backgroundStartRefused(): void {
    if (this.view.connectedAt === undefined || !isActive(this.view.call)) return;
    this.backgroundRefused = true;
    this.track('background_start_failed');
  }

  /** The app is visible again: retry a background start that was refused while backgrounded. */
  retryBackground(): void {
    if (!this.backgroundRefused || !isConnected(this.view.call)) return;
    this.backgroundRefused = false;
    this.startBackground();
  }

  /** Back to IDLE after a finished call so the next one starts clean. */
  reset(): void {
    if (!isTerminal(this.view.call)) return;
    this.view = { call: INITIAL_CALL_STATE, muted: false };
    this.emit();
  }

  private onTransportEvent(event: TransportEvent): void {
    switch (event.type) {
      case 'gateway_ready':
        this.dispatch({ type: 'GATEWAY_READY' });
        return;
      case 'gateway_lost':
        this.track('gateway_lost');
        this.dispatch({ type: 'GATEWAY_LOST' });
        return;
      case 'gateway_ending': {
        this.emitTelemetry({ event: 'gateway_ending', call_id: this.callId, detail: event.reason });
        if (this.view.approval !== undefined) this.clearApproval();
        if (event.reason === 'agent_hangup') {
          // The agent said goodbye and hung up: an ordinary end, like the owner hanging up, not
          // the server cutting the call. Leave before the room closes so it reads "Call ended".
          this.track('agent_hung_up');
          void this.hangUp();
          return;
        }
        const code = endReasonErrorCode(event.reason);
        if (code !== undefined) {
          this.fail(
            code,
            undefined,
            code === 'DAILY_LIMIT_REACHED'
              ? dailyLimitMessage(undefined)
              : event.reason === 'deepgram_key_refused'
                ? keyRefusedCallMessage('deepgram')
                : event.reason === 'cartesia_key_refused'
                  ? keyRefusedCallMessage('cartesia')
                  : event.reason === 'xai_key_refused'
                    ? keyRefusedCallMessage('xai')
                    : undefined,
          );
        }
        return;
      }
      case 'reconnecting':
        this.dispatch({ type: 'TRANSPORT_LOST' });
        return;
      case 'reconnected':
        this.dispatch({ type: 'TRANSPORT_RECOVERED' });
        return;
      case 'disconnected':
        if (event.cause !== 'client') {
          this.fail(event.cause === 'server_ended' ? 'CALL_ENDED_BY_SERVER' : 'NETWORK_LOST');
        }
        return;
      case 'levels':
        // Only a live call has real levels; a muted mic is silent whatever the track reports.
        if (!isConnected(this.view.call)) return;
        this.levels.push({
          local: this.view.muted ? 0 : event.levels.local,
          remote: event.levels.remote,
        });
        return;
      case 'downlink_stats':
        this.emitTelemetry({ event: 'audio_rx', call_id: this.callId, downlink: event.window });
        return;
      case 'status':
        this.onStatus(event.message);
        return;
    }
  }

  private onStatus(message: StatusMessage): void {
    switch (message.type) {
      case 'audio_stats':
        this.view = {
          ...this.view,
          inbound: {
            peakDbfs: message.peak_dbfs,
            framesReceived: message.frames_received,
            at: this.deps.timers.now(),
          },
        };
        this.watchMicrophone(message.frames_received);
        break;
      case 'caption': {
        const current = this.view.caption;
        // Never let an older turn's late packet overwrite a newer caption.
        if (current !== undefined && message.turn_index < current.turnIndex) return;
        this.view = {
          ...this.view,
          caption: { turnIndex: message.turn_index, text: message.text, final: message.final },
        };
        break;
      }
      case 'floor': {
        if (this.floor !== undefined && message.seq <= this.floor.seq) return;
        this.floor = message;
        const { reply } = this.view;
        if (message.floor === 'user_speaking') {
          // The caller has the floor again: the previous answer and any notice are done with.
          this.view = withoutReply(this.view);
        } else if (
          message.turn_id !== undefined &&
          reply !== undefined &&
          reply.turnId !== message.turn_id
        ) {
          this.view = withoutReply(this.view);
        }
        this.applyFloor();
        break;
      }
      case 'agent_text':
        this.view = {
          ...this.view,
          reply: { turnId: message.turn_id, text: message.text, final: message.final },
        };
        break;
      case 'notice':
        this.track(`notice_${message.code}`);
        this.view = { ...this.view, notice: message.code };
        break;
      case 'approval':
        if (this.view.call.status === 'ENDING' || isTerminal(this.view.call)) return;
        this.view = {
          ...this.view,
          approval: {
            id: message.approval_id,
            agentName: message.agent_name,
            action: message.action,
            title: message.title,
            ...(message.description !== undefined && { description: message.description }),
            expiresAt: Date.parse(message.expires_at),
          },
          approvalError: false,
        };
        break;
      case 'approval_resolved':
        if (this.view.approval?.id !== message.approval_id) return;
        this.clearApproval();
        return;
    }
    this.emit();
  }

  /** Mirrors the gateway's latest floor into the call state, once the call is connected. */
  private applyFloor(): void {
    const message = this.floor;
    const state = this.view.call;
    if (message === undefined || !isConnected(state)) return;
    const floor = toFloor(message);
    if (sameFloor(state, floor)) return;
    this.dispatch({ type: 'FLOOR_CHANGED', floor });
  }

  private dispatch(event: CallEvent): void {
    const previous = this.view.call;
    const { state, accepted } = reduceCall(previous, event);
    if (!accepted) {
      this.deps.onInvalidTransition?.(previous, event);
      return;
    }
    if (state === previous) return;
    this.view = { ...this.view, call: state };
    if (!isConnected(state)) this.levels.reset();
    this.onEnter(previous, state);
    this.emit();
    // (Re)connected: catch up with the conversation the gateway kept running meanwhile.
    if (!isConnected(previous) && isConnected(state)) this.applyFloor();
  }

  /** Side effects of entering a state: timers, telemetry, timestamps. */
  private onEnter(previous: CallState, next: CallState): void {
    const now = this.deps.timers.now();
    this.emitTelemetry({
      event: 'call_state',
      call_id: this.callId,
      from: previous.status,
      to: next.status,
    });

    if (previous.status === 'RECONNECTING' && next.status !== 'RECONNECTING') {
      this.cancel('reconnect_budget');
      if (next.status === 'LISTENING') {
        this.track('transport_restored', now - this.reconnectStartedAt);
      }
    }

    switch (next.status) {
      case 'LISTENING':
        this.cancel('gateway_ready');
        if (this.view.connectedAt === undefined) {
          this.view = { ...this.view, connectedAt: now };
          this.track('call_connected', now - this.startedAt);
          this.startBackground(true);
        }
        return;
      case 'RECONNECTING':
        if (previous.status !== 'RECONNECTING') {
          this.reconnectStartedAt = now;
          this.silentReports = 0;
          this.micHeard = false;
          this.track('transport_lost');
          this.timer('reconnect_budget', this.timeouts.reconnectBudgetMs, () =>
            this.fail('RECONNECT_EXHAUSTED'),
          );
        }
        return;
      case 'ENDED':
      case 'FAILED':
        this.view = { ...this.view, finishedAt: now, approval: undefined, approvalError: false };
        if (next.status === 'FAILED') {
          this.emitTelemetry({
            event: 'call_failed',
            call_id: this.callId,
            error_code: next.error.code,
            duration_ms: now - this.startedAt,
          });
        } else {
          this.track('call_ended', now - this.startedAt);
        }
        return;
      case 'IDLE':
      case 'PREPARING':
      case 'CONNECTING':
      case 'USER_SPEAKING':
      case 'AGENT_WORKING':
      case 'AGENT_SPEAKING':
        return;
      case 'ENDING':
        this.view = { ...this.view, approval: undefined, approvalError: false };
        return;
    }
  }

  private fail(code: CallErrorCode, correlationId?: string, message?: string): void {
    if (!isActive(this.view.call) || this.view.call.status === 'ENDING') return;
    this.dispatch({
      type: 'FATAL_ERROR',
      error: callError(code, correlationId ?? this.callId, message),
    });
    void this.release();
  }

  /** Releases every call resource once, whichever path (hang-up or failure) gets here first. */
  private release(): Promise<void> {
    this.cleanup ??= (async () => {
      this.attempt?.abort();
      for (const cancel of this.cancelTimers.values()) cancel();
      this.cancelTimers.clear();
      const transport = this.transport;
      this.transport = undefined;
      await Promise.all([
        transport?.disconnect().catch(() => undefined),
        this.callId !== undefined ? this.endOnServer(this.callId) : undefined,
        this.stopBackground(),
      ]);
    })();
    return this.cleanup;
  }

  private startBackground(firstConnection = false): void {
    const background = this.deps.background;
    if (background === undefined) return;
    this.backgroundGeneration += 1;
    this.screenGeneration = this.backgroundGeneration;
    if (firstConnection) this.setCallScreen(true);
    this.background = background.start({ agentName: this.agentName }).catch(() => {
      // The call still works while visible; it just may not survive the screen going off.
      this.backgroundRefused = true;
      this.track('background_start_failed');
    });
  }

  /**
   * Every end path lands here; waits for an in-flight start so the service never outlives the call.
   * Both waits are bounded so hang-up always completes, and a newer call's start wins: this stop is
   * skipped if another call started the (single, shared) service meanwhile.
   */
  private async stopBackground(): Promise<void> {
    const background = this.deps.background;
    if (background === undefined) return;
    const generation = this.backgroundGeneration;
    if (generation === this.screenGeneration) {
      this.screenGeneration = 0;
      this.setCallScreen(false);
    }
    const ms = this.timeouts.backgroundStopMs;
    if (this.background !== undefined) {
      await this.bounded(this.background, ms, false).catch(() => undefined);
    }
    if (generation !== this.backgroundGeneration) return;
    await this.bounded(background.stop(), ms, true).catch(() =>
      this.track('background_stop_failed'),
    );
  }

  private setCallScreen(active: boolean): void {
    try {
      this.deps.background?.setCallScreen(active);
    } catch {
      this.track('call_screen_failed');
    }
  }

  private async endOnServer(callId: string): Promise<void> {
    const request = deadline(
      new AbortController().signal,
      this.timeouts.endRequestMs,
      this.deps.timers,
    );
    try {
      await this.deps.api.end(callId, request.signal);
    } catch {
      // Best effort: the gateway also ends calls whose caller leaves.
      this.track('server_end_failed');
    } finally {
      request.dispose();
    }
  }

  /** True while `attempt` is still the live call attempt (not hung up, failed, or replaced). */
  private current(attempt: AbortController): boolean {
    return this.attempt === attempt && !attempt.signal.aborted && isActive(this.view.call);
  }

  private timer(name: string, ms: number, callback: () => void): void {
    this.cancel(name);
    this.cancelTimers.set(
      name,
      this.deps.timers.setTimeout(() => {
        this.cancelTimers.delete(name);
        callback();
      }, ms),
    );
  }

  private cancel(name: string): void {
    this.cancelTimers.get(name)?.();
    this.cancelTimers.delete(name);
  }

  private track(event: string, durationMs?: number): void {
    this.emitTelemetry({
      event,
      call_id: this.callId,
      ...(durationMs !== undefined && { duration_ms: durationMs }),
    });
  }

  private emitTelemetry(event: CallTelemetryEvent): void {
    this.deps.telemetry({ ...event, t_ms: this.deps.timers.now() - this.startedAt });
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
