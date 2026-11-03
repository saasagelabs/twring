import { isAdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import type { GatewayEnv } from '@twring/config/gateway';
import type {
  CallUsage,
  GatewayEndReason,
  ListeningProvider,
  SpeechProvider,
} from '@twring/contracts';

import {
  FRAME_MS,
  FrameDelay,
  PRESENCE_TONE,
  PRESENCE_TONE_GAIN,
  READY_CHIME,
  SILENCE_DBFS,
  peakDbfs,
  renderTone,
} from '../audio/pcm';
import { SttAudioCapture } from '../audio/capture';
import { ConversationController } from '../conversation/controller';
import { toSafeError } from '../redact';
import { VoicePipeline } from '../voice/pipeline';
import { VoiceProviderError, type SttProvider, type TtsProvider } from '../voice/types';

import { CALL_TIMEOUTS, ECHO_DELAY_MS } from './limits';
import type { AgentFactory } from './agents';
import type { Scheduler } from './scheduler';
import type { MediaTransport, TransportEvent } from './transport';
import { estimateCost, seconds, type UsageRates } from './usage';

/** Structured call telemetry sink: pino-compatible, safe fields only (OBSERVABILITY §10). */
export interface CallLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  debug?(fields: Record<string, unknown>, message?: string): void;
}

export type EndReason =
  | 'hangup'
  | 'caller_never_joined'
  | 'caller_left'
  | 'max_duration'
  | 'daily_limit'
  | 'gateway_connect_failed'
  | 'gateway_disconnected'
  | 'voice_unavailable'
  | 'voice_failed'
  | 'deepgram_key_refused'
  | 'cartesia_key_refused'
  | 'xai_key_refused'
  | 'agent_unavailable'
  | 'agent_offline'
  | 'agent_not_on_computer'
  | 'agent_hangup'
  | 'shutdown';

/**
 * Endings the phone should be told about even when they happen before it joins. `daily_limit`
 * can fire first when only a few seconds were left today.
 */
const NOTICE_REASONS: ReadonlySet<EndReason> = new Set([
  'agent_unavailable',
  'agent_offline',
  'agent_not_on_computer',
  'voice_unavailable',
  'deepgram_key_refused',
  'cartesia_key_refused',
  'xai_key_refused',
  'daily_limit',
]);

const FAILURE_REASONS: ReadonlySet<EndReason> = new Set([
  'gateway_connect_failed',
  'gateway_disconnected',
  'voice_unavailable',
  'voice_failed',
  'deepgram_key_refused',
  'cartesia_key_refused',
  'xai_key_refused',
  'agent_unavailable',
  'agent_offline',
  'agent_not_on_computer',
]);

type KeyRefusedReason = 'deepgram_key_refused' | 'cartesia_key_refused' | 'xai_key_refused';

/** Modes that hold a spoken conversation (and so need speech providers and an agent). */
function isConversational(mode: GatewayEnv['GATEWAY_AUDIO_TEST_MODE']): boolean {
  return mode === 'agent' || mode === 'repeat' || mode === 'native' || mode === 'rest';
}

/** What the phone is told about why the gateway left (GATEWAY_END_REASON_ATTRIBUTE). */
export function publicEndReason(reason: EndReason): GatewayEndReason {
  switch (reason) {
    case 'hangup':
    case 'caller_left':
    case 'max_duration':
    case 'daily_limit':
    case 'shutdown':
    case 'voice_unavailable':
    case 'voice_failed':
    case 'deepgram_key_refused':
    case 'cartesia_key_refused':
    case 'xai_key_refused':
    case 'agent_unavailable':
    case 'agent_offline':
    case 'agent_not_on_computer':
    case 'agent_hangup':
      return reason;
    case 'caller_never_joined':
      return 'caller_left';
    case 'gateway_connect_failed':
    case 'gateway_disconnected':
      return 'gateway_failed';
  }
}

export interface CallRuntimeOptions {
  callId: string;
  transport: MediaTransport;
  audioMode: GatewayEnv['GATEWAY_AUDIO_TEST_MODE'];
  maxDurationMs: number;
  /**
   * Why the call ends when `maxDurationMs` runs out: `daily_limit` when the caller's daily
   * allowance, not the per-call cap, set it (the phone then says today's time is used up).
   */
  maxDurationReason?: 'max_duration' | 'daily_limit';
  scheduler: Scheduler;
  logger: CallLogger;
  /** Speech providers; required when `audioMode` is `agent` or `repeat`. */
  voice?: { stt: SttProvider; tts: TtsProvider };
  /** Builds this call's agent; required when `audioMode` holds a conversation. */
  createAgent?: AgentFactory;
  /** Development only (config-enforced): record STT input and captions to this folder. */
  captureDir?: string;
  /**
   * The sides running on the person's own speech key. A refused key there ends the call with
   * `<provider>_key_refused` so the phone can say which key to fix.
   */
  ownKeyProviders?: { stt?: ListeningProvider; tts?: SpeechProvider };
  onCallerJoined?: () => void;
  /** A participant other than the caller joined; the owner of the room removes it. */
  onUnexpectedParticipant?: (identity: string) => void;
  /** Hard cap on one agent turn, however busy (keep-alive activity) the agent is. */
  agentTurnMaxMs?: number;
  /** USD rates for the usage cost estimate; absent or all 0 leaves the estimate out. */
  usageRates?: UsageRates;
  onEnded?: (outcome: { reason: EndReason; failed: boolean; usage: CallUsage }) => void;
  /**
   * The call's first agent turn (an answered ring, ADR-024): sent once the gateway is ready and the
   * caller is in the room, so the agent speaks first.
   */
  openingTurn?: string;
  /** The answered ring's message, spoken as the opening turn's first agent text. */
  openingLine?: string;
  /** The agent's display name ("Hermes, stop" is a stop request, ADR-028). */
  agentName?: string;
  /** The "heard you" tone and spoken progress lines while the agent works (ADR-028). */
  presenceCues?: boolean;
  /** The short spoken acknowledgement while the agent is still silent (ADR-032). */
  acknowledge?: boolean;
  /** Grace for a one- or two-word normal turn. */
  shortTurnHoldMs?: number;
}

/** Live (echo) audio older than this is dropped rather than let playback lag behind the caller. */
const MAX_LIVE_BACKLOG_FRAMES = 50;
/** Synthesized speech arrives faster than real time and is queued whole, up to a minute. */
const MAX_SPEECH_BACKLOG_FRAMES = 3000;
/** Longest an answered ring's opening waits for the caller's audio to start flowing. */
export const OPENING_AUDIO_WAIT_MS = 1_500;
/**
 * And once it flows, a beat more before speaking: the phone sends its microphone a moment before
 * its speaker is playing (an iPhone answering on the system call screen), and words sent in that
 * moment were played back rushed and unclear (release test, build 9).
 */
export const OPENING_LEAD_IN_MS = 1_000;
/**
 * No caller audio at all for this long, mid-call, is logged as a stall: an Android phone has been
 * seen to stop sending its microphone while the call kept running ("Waiting for audio…").
 */
export const CALLER_AUDIO_STALL_MS = 5_000;

/** A frame to publish, or (no frame) a marker whose callback runs when playback reaches it. */
interface QueuedFrame {
  frame?: Int16Array;
  onPublished?: () => void;
}

/**
 * One call's gateway side: joins the room, runs the configured audio (a spoken conversation with an
 * agent in `agent`/`repeat` mode, echo/chime test audio otherwise), reports caller levels, and owns
 * every timer and resource of the call so `end()` can release all of it exactly once.
 */
export class CallRuntime {
  private readonly controller = new AbortController();
  private readonly cancelTimers = new Map<string, () => void>();
  private readonly echo = new FrameDelay(Math.round(ECHO_DELAY_MS / FRAME_MS));
  private readonly output: QueuedFrame[] = [];
  private voice: VoicePipeline | undefined;
  private conversation: ConversationController | undefined;
  private capture: SttAudioCapture | undefined;
  private readonly drainedCallbacks: (() => void)[] = [];
  private pumping = false;
  private chimePlaying = false;
  private callerPresent = false;
  private everJoined = false;
  private firstCallerFrameLogged = false;
  private windowFrames = 0;
  private windowPeak = SILENCE_DBFS;
  /** Since when no caller audio has arrived (after it first did), and whether that was logged. */
  private callerSilentSince: number | undefined;
  private callerStallLogged = false;
  private callerMuted = false;
  private gatewayReconnecting = false;
  private ending: Promise<void> | undefined;
  /** Ends the failure-notice wait early (caller joined, hang-up, room gone). */
  private endNotice: (() => void) | undefined;
  private readonly startedAt: number;
  /** Scheduler time the gateway joined the room (room-minutes estimate). */
  private joinedAt: number | undefined;
  private gatewayReady = false;
  private openingSent = false;
  /**
   * An answered ring's opening is spoken once the caller's audio is flowing (their media is up),
   * or after `OPENING_AUDIO_WAIT_MS` at most: spoken the instant they joined, its first words were
   * lost while the phone's audio came up.
   */
  private openingAudioReady = false;
  private openingWait: (() => void) | undefined;
  private openingLeadIn: (() => void) | undefined;

  constructor(private readonly options: CallRuntimeOptions) {
    this.startedAt = options.scheduler.now();
  }

  decideApproval(id: string, decision: 'approve' | 'deny'): 'applied' | 'decided' | 'unknown' {
    const status = this.conversation?.approvalStatus(id) ?? 'unknown';
    if (status === 'decided') return 'decided';
    if (status === 'unknown') return 'unknown';
    return this.conversation?.resolveApproval(id, decision, 'tap') ? 'applied' : 'decided';
  }

  /** Resolves once the gateway is in the room and ready; failures end the call instead. */
  async start(): Promise<void> {
    const { transport, scheduler } = this.options;
    this.timer(
      'caller_join',
      CALL_TIMEOUTS.callerJoinMs,
      () => void this.end('caller_never_joined'),
    );
    this.timer(
      'max_duration',
      this.options.maxDurationMs,
      () => void this.end(this.options.maxDurationReason ?? 'max_duration'),
    );

    this.log('gateway_join_started');
    const connectSignal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(CALL_TIMEOUTS.gatewayConnectMs),
    ]);
    // Speech providers connect while the gateway joins the room; both must be up before "ready".
    const voiceReady = this.startConversation();
    try {
      await transport.connect(
        {
          onEvent: (event) => this.handleTransportEvent(event),
          onCallerFrame: (samples) => this.handleCallerFrame(samples),
        },
        connectSignal,
      );
    } catch (error) {
      if (this.ending === undefined) {
        this.options.logger.warn(
          { event: 'gateway_join_failed', call_id: this.options.callId, err: toSafeError(error) },
          'gateway could not join the call room',
        );
        await this.end('gateway_connect_failed');
      }
      return;
    }
    if (this.ending !== undefined) return;
    this.joinedAt = this.options.scheduler.now();
    this.log('gateway_joined', { duration_ms: this.elapsed() });
    const voice = await voiceReady;
    if (voice !== 'ready') {
      await this.end(voice);
      return;
    }
    if (this.ending !== undefined) return;

    await transport.setGatewayState('ready');
    this.log('gateway_ready', { duration_ms: this.elapsed() });
    this.gatewayReady = true;
    this.maybeSendOpening();

    this.cancelTimers.set(
      'audio_stats',
      scheduler.setInterval(() => this.flushAudioStats(), CALL_TIMEOUTS.audioStatsIntervalMs),
    );
  }

  /** Ends the call and releases everything. Idempotent: later calls return the same promise. */
  end(reason: EndReason): Promise<void> {
    // A second end (e.g. hang-up) during the failure-notice wait leaves the room at once.
    if (this.ending !== undefined) this.endNotice?.();
    this.ending ??= this.release(reason);
    return this.ending;
  }

  private async release(reason: EndReason): Promise<void> {
    const failed = FAILURE_REASONS.has(reason);
    this.controller.abort();
    for (const cancel of this.cancelTimers.values()) cancel();
    this.cancelTimers.clear();
    this.output.length = 0;
    this.echo.clear();
    this.conversation?.close();
    await this.voice?.close();
    this.capture?.close();

    const { transport } = this.options;
    try {
      transport.clearOutput();
      await transport.setGatewayState('ending', publicEndReason(reason));
      // The phone learns why only from the room attribute it reads on join: stay until it can.
      if (NOTICE_REASONS.has(reason) && !this.everJoined) await this.waitForNotice();
    } catch {
      // Best effort: the room may already be gone.
    }
    try {
      await transport.close();
    } catch (error) {
      this.options.logger.warn(
        { event: 'gateway_leave_failed', call_id: this.options.callId, err: toSafeError(error) },
        'gateway could not leave the room cleanly',
      );
    }
    this.log(failed ? 'call_failed' : 'call_ended', { reason, duration_ms: this.elapsed() });
    const usage = this.usage();
    // One line per call, counts and durations only (OBSERVABILITY_AND_SLOS §16): no transcript.
    this.log('call_usage', { reason, ...usage });
    this.options.onEnded?.({ reason, failed, usage });
  }

  /** Sends the opening turn once: gateway ready, conversation up, and the caller in the room. */
  private maybeSendOpening(): void {
    const text = this.options.openingTurn;
    if (text === undefined || this.openingSent || this.ending !== undefined) return;
    if (!this.gatewayReady || !this.everJoined || this.conversation === undefined) return;
    if (!this.openingAudioReady) {
      if (this.firstCallerFrameLogged) {
        // The caller's audio flows: the fallback is no longer needed, the lead-in is.
        this.openingWait?.();
        this.openingWait = undefined;
        this.openingLeadIn ??= this.options.scheduler.setTimeout(() => {
          this.openingAudioReady = true;
          this.maybeSendOpening();
        }, OPENING_LEAD_IN_MS);
      } else {
        this.openingWait ??= this.options.scheduler.setTimeout(() => {
          this.openingAudioReady = true;
          this.maybeSendOpening();
        }, OPENING_AUDIO_WAIT_MS);
      }
      return;
    }
    this.openingWait?.();
    this.openingWait = undefined;
    this.openingLeadIn?.();
    this.openingLeadIn = undefined;
    this.openingSent = true;
    this.conversation.openingTurn(text, this.options.openingLine);
  }

  /**
   * The caller spoke before the opening went out (a reflexive "Hello?" during the wait): send it
   * now, so it lands before their turn. The conversation ignores an opening once a turn exists, and
   * the agent would never learn it was an answered ring.
   */
  private openingNow(): void {
    if (this.options.openingTurn === undefined || this.openingSent) return;
    this.openingAudioReady = true;
    this.maybeSendOpening();
  }

  /** What this call used, measured on the gateway side. */
  private usage(): CallUsage {
    const voice = this.voice?.usage();
    const turns = this.conversation?.usage();
    const now = this.options.scheduler.now();
    const usage: CallUsage = {
      stt_audio_s: seconds(voice?.sttAudioMs ?? 0),
      stt_connected_s: seconds(voice?.sttConnectedMs ?? 0),
      tts_chars: voice?.ttsChars ?? 0,
      tts_audio_s: seconds(voice?.ttsAudioMs ?? 0),
      agent_turns: turns?.turns ?? 0,
      agent_turns_completed: turns?.completed ?? 0,
      agent_turns_failed: turns?.failed ?? 0,
      barge_ins: turns?.bargeIns ?? 0,
      gateway_connected_s: seconds(this.joinedAt === undefined ? 0 : now - this.joinedAt),
      stt_reconnects: voice?.sttReconnects ?? 0,
      tts_reconnects: voice?.ttsReconnects ?? 0,
    };
    const cost = estimateCost(usage, this.options.usageRates);
    return cost === undefined ? usage : { ...usage, estimated_cost_usd: cost };
  }

  /** Test/diagnostic view of per-call state that must stay bounded however long the call runs. */
  retainedState(): Record<string, number> {
    return {
      output: this.output.length,
      runtimeTimers: this.cancelTimers.size,
      drainedCallbacks: this.drainedCallbacks.length,
      ...prefixed('voice', this.voice?.retainedState()),
      ...prefixed('conversation', this.conversation?.retainedState()),
    };
  }

  private waitForNotice(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        cancel();
        this.endNotice = undefined;
        resolve();
      };
      const cancel = this.options.scheduler.setTimeout(done, CALL_TIMEOUTS.failureNoticeMs);
      this.endNotice = done;
    });
  }

  private handleTransportEvent(event: TransportEvent): void {
    if (this.ending !== undefined) {
      // Joining after the end reason is set is enough: the phone reads it on join.
      if (event.type === 'caller_joined') this.everJoined = true;
      if (event.type === 'caller_joined' || event.type === 'disconnected') this.endNotice?.();
      return;
    }
    switch (event.type) {
      case 'caller_joined': {
        this.cancel('caller_join');
        this.cancel('caller_rejoin');
        this.callerPresent = true;
        this.log(this.everJoined ? 'caller_rejoined' : 'caller_joined', {
          duration_ms: this.elapsed(),
        });
        if (!this.everJoined) this.options.onCallerJoined?.();
        else this.conversation?.resendFloor();
        this.everJoined = true;
        this.maybeSendOpening();
        return;
      }
      case 'caller_left':
        this.callerPresent = false;
        this.resetCallerStall();
        this.echo.clear();
        this.log('caller_left');
        this.timer(
          'caller_rejoin',
          CALL_TIMEOUTS.callerRejoinGraceMs,
          () => void this.end('caller_left'),
        );
        return;
      case 'caller_listening':
        if (this.options.audioMode !== 'off') this.playChime();
        return;
      case 'caller_muted':
      case 'caller_unmuted':
        // Muted silence is not a stall; after unmuting, silence counts from the unmute.
        this.callerMuted = event.type === 'caller_muted';
        this.resetCallerStall();
        return;
      case 'unexpected_participant':
        this.options.logger.warn(
          {
            event: 'unexpected_participant',
            call_id: this.options.callId,
            identity: event.identity,
          },
          'someone other than the caller joined the call room; removing',
        );
        this.options.onUnexpectedParticipant?.(event.identity);
        return;
      case 'reconnecting':
        this.log('transport_lost');
        // The gateway's own connection is down: silence then is not the caller's microphone.
        this.gatewayReconnecting = true;
        this.resetCallerStall();
        return;
      case 'reconnected':
        this.log('transport_restored');
        this.gatewayReconnecting = false;
        this.resetCallerStall();
        return;
      case 'disconnected':
        this.log('gateway_disconnected', { detail: event.reason });
        void this.end('gateway_disconnected');
        return;
    }
  }

  private handleCallerFrame(samples: Int16Array): void {
    if (this.ending !== undefined) return;
    if (!this.firstCallerFrameLogged) {
      this.firstCallerFrameLogged = true;
      this.log('caller_audio_first_frame', { duration_ms: this.elapsed() });
      this.maybeSendOpening();
    }
    this.windowFrames += 1;
    this.windowPeak = Math.max(this.windowPeak, peakDbfs(samples));

    this.voice?.pushCallerAudio(samples);
    if (this.options.audioMode === 'echo' && !this.chimePlaying) {
      const delayed = this.echo.push(samples);
      if (delayed !== undefined) this.enqueue([delayed], { live: true });
    }
  }

  /**
   * Opens STT/TTS and connects the agent for a conversational mode, in parallel. Resolves `ready`,
   * or why the call cannot work.
   */
  private async startConversation(): Promise<
    | 'ready'
    | 'voice_unavailable'
    | KeyRefusedReason
    | 'agent_unavailable'
    | 'agent_offline'
    | 'agent_not_on_computer'
  > {
    const { audioMode, voice, callId, scheduler, logger, transport } = this.options;
    if (!isConversational(audioMode)) return 'ready';
    if (voice === undefined) {
      logger.warn({ event: 'voice_unavailable', call_id: callId, error_code: 'not_configured' });
      return 'voice_unavailable';
    }
    const sendReliable = (message: Parameters<MediaTransport['sendStatus']>[0]) => {
      transport.sendStatus(message, { reliable: true }).catch(() => undefined);
    };
    if (this.options.captureDir !== undefined) {
      this.capture = new SttAudioCapture(this.options.captureDir, callId);
      logger.warn({ event: 'debug_audio_capture_on', call_id: callId }, 'recording STT input');
    }
    const agent = await this.createAgent();
    if (agent === undefined) return 'agent_unavailable';
    if (this.ending !== undefined) {
      void agent.close().catch(() => undefined);
      return 'agent_unavailable';
    }
    const pipeline: VoicePipeline = new VoicePipeline({
      callId,
      ...(this.capture && { capture: this.capture }),
      stt: voice.stt,
      tts: voice.tts,
      scheduler,
      logger,
      onUserSpeechStarted: () => {
        this.openingNow();
        conversation.userSpeechStarted();
      },
      onUserSpeechDiscarded: () => conversation.userSpeechDiscarded(),
      onUserPartial: (text) => conversation.userPartial(text),
      onUserTurn: (text) => conversation.userTurn(text),
      onCaption: ({ turnIndex, text, final }) => {
        sendReliable({
          v: 1,
          type: 'caption',
          call_id: callId,
          turn_index: turnIndex,
          text,
          final,
        });
      },
      onSpeech: ({ generationId, state }) => conversation.speechState(generationId, state),
      playFrames: (frames, callbacks) => {
        this.enqueue(frames, { live: false, ...callbacks });
      },
      stopPlayback: () => {
        const dropped = this.output.filter((queued) => queued.frame !== undefined).length;
        this.output.length = 0;
        transport.clearOutput();
        return dropped;
      },
      onFatal: (error, which) => {
        logger.warn({ event: 'voice_failed', call_id: callId, error_code: error.code });
        void this.end(this.keyRefused(error.code, which) ?? 'voice_failed');
      },
    });
    const conversation = new ConversationController({
      callId,
      adapter: agent,
      scheduler,
      logger,
      send: sendReliable,
      ...(this.options.agentTurnMaxMs !== undefined && {
        timeouts: { totalMs: this.options.agentTurnMaxMs },
      }),
      onAgentUnusable: (code) => {
        logger.warn({
          event: 'agent_unavailable',
          call_id: callId,
          agent: agent.name,
          error_code: code,
        });
        void this.end('agent_unavailable');
      },
      onAgentHangup: () => void this.end('agent_hangup'),
      ...(this.options.agentName !== undefined && { agentName: this.options.agentName }),
      presenceCues: this.options.presenceCues === true,
      acknowledge: this.options.acknowledge === true,
      shortTurnHoldMs: this.options.shortTurnHoldMs,
      speech: {
        begin: (committedAt) => pipeline.beginSpeech(committedAt),
        append: (id, text) => pipeline.appendSpeech(id, text),
        end: (id) => pipeline.endSpeech(id),
        cancel: (reason) => pipeline.cancelSpeech(reason),
        callerOnsetAt: () => pipeline.callerOnsetAt(),
        playedMs: (id) => pipeline.playedMs(id),
        totalAudioMs: (id) => pipeline.totalAudioMs(id),
        // Queued like speech: a barge-in or the agent's first words drop it with the rest.
        playTone: () =>
          this.enqueue(renderTone(PRESENCE_TONE, PRESENCE_TONE_GAIN), { live: false }),
      },
    });
    this.voice = pipeline;
    this.conversation = conversation;

    const startedAt = scheduler.now();
    const [voiceResult, agentResult] = await Promise.allSettled([
      pipeline.start(),
      conversation.connect(
        AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(CALL_TIMEOUTS.agentConnectMs),
        ]),
      ),
    ]);
    if (voiceResult.status === 'rejected') {
      const error: unknown = voiceResult.reason;
      const code = error instanceof VoiceProviderError ? error.error.code : 'unknown';
      logger.warn({ event: 'voice_unavailable', call_id: callId, error_code: code });
      const side = error instanceof VoiceProviderError ? error.side : undefined;
      return (side && this.keyRefused(code, side)) ?? 'voice_unavailable';
    }
    if (agentResult.status === 'rejected') {
      logger.warn({
        event: 'agent_unavailable',
        call_id: callId,
        agent: agent.name,
        error_code: agentErrorCode(agentResult.reason),
      });
      // The user's computer is not connected (ADR-023): the phone says so in plain words.
      const code = agentErrorCode(agentResult.reason);
      return code === 'agent_offline' || code === 'agent_not_on_computer'
        ? code
        : 'agent_unavailable';
    }
    this.log('voice_ready', {
      duration_ms: Math.round(scheduler.now() - startedAt),
      agent: agent.name,
    });
    return 'ready';
  }

  /** The ending for a refused key on a side that runs on the person's own key, if it is one. */
  private keyRefused(code: string, which: 'stt' | 'tts'): KeyRefusedReason | undefined {
    if (code !== 'auth_failed') return undefined;
    const provider = this.options.ownKeyProviders?.[which];
    return provider === undefined ? undefined : `${provider}_key_refused`;
  }

  /** Builds the agent; undefined (logged by code only, never URL or token) when it can't be. */
  private async createAgent(): Promise<TwringAgentAdapter | undefined> {
    const { createAgent, callId, logger } = this.options;
    if (createAgent === undefined) {
      logger.warn({ event: 'agent_unavailable', call_id: callId, error_code: 'not_configured' });
      return undefined;
    }
    try {
      return await createAgent(callId);
    } catch (error) {
      logger.warn({
        event: 'agent_unavailable',
        call_id: callId,
        error_code: agentErrorCode(error),
      });
      return undefined;
    }
  }

  private flushAudioStats(): void {
    const frames = this.windowFrames;
    const peak = this.windowPeak;
    this.windowFrames = 0;
    this.windowPeak = SILENCE_DBFS;
    if (!this.callerPresent) return;
    this.watchCallerAudio(frames);
    // Per-window levels help diagnose echo/feedback on real devices; debug only (1/s per call).
    this.options.logger.debug?.({
      event: 'caller_audio_level',
      call_id: this.options.callId,
      frames,
      peak_dbfs: Math.round(peak * 10) / 10,
      echo_active: this.options.audioMode === 'echo' && !this.chimePlaying,
    });
    this.options.transport
      .sendStatus({
        v: 1,
        type: 'audio_stats',
        call_id: this.options.callId,
        window_ms: CALL_TIMEOUTS.audioStatsIntervalMs,
        frames_received: frames,
        peak_dbfs: Math.round(peak * 10) / 10,
      })
      .catch(() => {
        // Lossy by design; the next window reports again.
      });
  }

  private playChime(): void {
    if (this.chimePlaying) return;
    this.chimePlaying = true;
    this.echo.clear();
    const frames = renderTone(READY_CHIME);
    this.enqueue(frames, {
      live: false,
      onDrained: () => {
        this.chimePlaying = false;
      },
    });
  }

  private enqueue(
    frames: Int16Array[],
    options: {
      live: boolean;
      onFirstPublished?: () => void;
      /** Runs when the last of these frames is handed off. */
      onLastPublished?: () => void;
      /** Runs when playback reaches the end of these frames (a marker in the queue). */
      onDone?: () => void;
      /** Runs when the pump next goes idle. */
      onDrained?: () => void;
    },
  ): void {
    const last = frames.length - 1;
    frames.forEach((frame, index) => {
      const first = index === 0 ? options.onFirstPublished : undefined;
      const end = index === last ? options.onLastPublished : undefined;
      const onPublished =
        first !== undefined && end !== undefined
          ? () => {
              first();
              end();
            }
          : (first ?? end);
      this.output.push(onPublished === undefined ? { frame } : { frame, onPublished });
    });
    if (options.onDone !== undefined) this.output.push({ onPublished: options.onDone });
    const cap = options.live ? MAX_LIVE_BACKLOG_FRAMES : MAX_SPEECH_BACKLOG_FRAMES;
    if (this.output.length > cap) this.output.splice(0, this.output.length - cap);
    void this.pump(options.onDrained);
  }

  /** Single consumer so frames reach the track in order and publishFrame is never re-entered. */
  private async pump(onDrained?: () => void): Promise<void> {
    if (onDrained) this.drainedCallbacks.push(onDrained);
    if (this.pumping) return;
    this.pumping = true;
    try {
      let item: QueuedFrame | undefined;
      while (this.ending === undefined && (item = this.output.shift()) !== undefined) {
        if (item.frame !== undefined) await this.options.transport.publishFrame(item.frame);
        item.onPublished?.();
      }
    } catch (error) {
      this.options.logger.warn(
        { event: 'audio_publish_failed', call_id: this.options.callId, err: toSafeError(error) },
        'could not publish gateway audio',
      );
      // The queued audio is lost, but its end-of-playback markers still run (after clearing, so
      // they see an empty queue): a speech generation reports finished and the floor moves on.
      const markers = this.output.splice(0).filter((queued) => queued.frame === undefined);
      for (const marker of markers) marker.onPublished?.();
    } finally {
      this.pumping = false;
      for (const callback of this.drainedCallbacks.splice(0)) callback();
    }
  }

  private timer(name: string, ms: number, callback: () => void): void {
    this.cancel(name);
    this.cancelTimers.set(
      name,
      this.options.scheduler.setTimeout(() => {
        this.cancelTimers.delete(name);
        callback();
      }, ms),
    );
  }

  private cancel(name: string): void {
    this.cancelTimers.get(name)?.();
    this.cancelTimers.delete(name);
  }

  private elapsed(): number {
    return Math.round(this.options.scheduler.now() - this.startedAt);
  }

  /** Silence is counted afresh: after a mute, a reconnect, or the caller leaving. */
  private resetCallerStall(): void {
    this.callerSilentSince = undefined;
    this.callerStallLogged = false;
  }

  /** A caller whose audio stops arriving mid-call is logged once, and again when it comes back. */
  private watchCallerAudio(frames: number): void {
    const now = this.options.scheduler.now();
    if (frames > 0) {
      if (this.callerStallLogged && this.callerSilentSince !== undefined) {
        this.log('caller_audio_resumed', { stalled_ms: Math.round(now - this.callerSilentSince) });
      }
      this.callerSilentSince = undefined;
      this.callerStallLogged = false;
      return;
    }
    if (!this.firstCallerFrameLogged || this.callerMuted || this.gatewayReconnecting) return;
    // The empty window began one interval ago.
    this.callerSilentSince ??= now - CALL_TIMEOUTS.audioStatsIntervalMs;
    if (!this.callerStallLogged && now - this.callerSilentSince >= CALLER_AUDIO_STALL_MS) {
      this.callerStallLogged = true;
      this.options.logger.warn({
        event: 'caller_audio_stalled',
        call_id: this.options.callId,
        silent_ms: Math.round(now - this.callerSilentSince),
      });
    }
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.logger.info({ event, call_id: this.options.callId, ...fields });
  }
}

function prefixed(
  prefix: string,
  state: Record<string, number> | undefined,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(state ?? {}).map(([key, value]) => [`${prefix}.${key}`, value]),
  );
}

/** A stable code for an agent failure. Adapter messages are safe, but only the code is logged. */
function agentErrorCode(error: unknown): string {
  return isAdapterError(error) ? error.code : 'unknown';
}
