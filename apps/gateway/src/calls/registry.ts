import type { GatewayEnv } from '@twring/config/gateway';
import type {
  AgentProtocol,
  ConnectorEndpoint,
  CallRecordStatus,
  CallHistoryItem,
  CallUsage,
  CallSummary,
  CreateCallResponse,
} from '@twring/contracts';

import { toSafeError } from '../redact';

import type { AgentFactory } from './agents';
import { newCallIds, type CallIds } from './ids';
import type { CallHistoryRepository } from '../store/repositories';

import {
  CallRuntime,
  publicEndReason,
  type CallLogger,
  type CallRuntimeOptions,
  type EndReason,
} from './runtime';
import type { Scheduler } from './scheduler';
import type { MediaTransportFactory } from './transport';
import { usageRates, type RateEnv } from './usage';
import type { RoomService } from '../livekit/rooms';
import {
  CallAudioError,
  OwnLiveKitAudio,
  type CallAudio,
  type CallAudioErrorCode,
} from '../livekit/call-audio';
import type { SttProvider, TtsProvider } from '../voice/types';
import { serverXaiListensOnDeepgram, serverXaiTtsSide } from '../voice/server-xai-voice';
import type { ResolvedSpeech } from '../voice/speech-resolver';
import { cartesiaVoice, xaiVoice } from '../agents/voices';

export interface CallTokens {
  caller(request: { room: string; identity: string; ttlSeconds: number }): Promise<string>;
  gateway(request: { room: string; ttlSeconds: number }): Promise<string>;
}

export interface CallRegistryOptions {
  env: Pick<
    GatewayEnv,
    | 'CALLS_ENABLED'
    | 'CALL_MAX_CONCURRENT'
    | 'CALL_MAX_DURATION_S'
    | 'CALL_TOKEN_TTL_S'
    | 'AGENT_TURN_MAX_S'
    | 'GATEWAY_AUDIO_TEST_MODE'
    | 'DEBUG_AUDIO_CAPTURE_DIR'
  > &
    Partial<Pick<GatewayEnv, 'PRESENCE_CUES' | 'PRESENCE_ACK' | 'SHORT_TURN_HOLD_MS'>> &
    RateEnv;
  /**
   * The call's audio: the server's own LiveKit or Twring's (self-hosted). Without it, the server's
   * own LiveKit from `liveKitUrl`, `rooms` and `tokens`, exactly as before.
   */
  audio?: CallAudio;
  liveKitUrl?: string;
  rooms?: RoomService;
  tokens?: CallTokens;
  transports: MediaTransportFactory;
  /** Builds each call's agent in a conversational mode (see `agentFactoryFor`). */
  createAgent?: AgentFactory;
  /** Speech providers for `repeat` mode (and, from Milestone 3, agent calls). */
  voice?: { stt: SttProvider; tts: TtsProvider };
  /**
   * TTS in a saved agent's voice (an id from the allowed list), on the call's keys. Falls back to
   * `voice.tts`.
   */
  ttsForVoice?: (voiceId: string, speech?: ResolvedSpeech) => TtsProvider;
  /** STT that listens for a saved agent's keyterms, on the call's keys. Falls back to `voice.stt`. */
  sttForKeyterms?: (
    keyterms: readonly string[],
    agentName?: string,
    speech?: ResolvedSpeech,
  ) => SttProvider;
  /**
   * Self-hosted on the server's own xAI key: every call listens and speaks on xAI, so only an own
   * xAI key can be the person's to blame (see `ownKeySides`).
   */
  speaksServerXai?: boolean;
  /** Where saved-agent calls leave their summary when they end. */
  history?: CallHistoryRepository;
  /**
   * Told when a call with an owner finishes, with its length, for the daily allowance. Shutdown
   * waits (bounded) for the returned promise, as for history.
   */
  onCallFinished?: (finished: {
    ownerId: string;
    startedAt: Date;
    durationS: number;
  }) => Promise<void>;
  scheduler: Scheduler;
  logger: CallLogger;
  newIds?: () => CallIds;
  now?: () => Date;
}

/** Why a call could not be created. Maps to a stable HTTP error in the route. */
export class CallCreateError extends Error {
  constructor(
    readonly reason:
      'disabled' | 'updating' | 'capacity' | 'provider' | 'in_progress' | CallAudioErrorCode,
  ) {
    super(`call not created: ${reason}`);
    this.name = 'CallCreateError';
  }
}

/** A call to a user's saved agent (`POST /v1/calls` with `agent_id`). */
export interface SavedAgentCall {
  /** Whose call it is (its history, its line). */
  userId: string;
  /** Self-hosted: the owner of a server agent shared with `userId`; unset for their own agent. */
  agentOwnerId?: string;
  /** Self-hosted: `userId`'s own session on that shared agent's computer. */
  sessionScope?: string;
  agentId: string;
  agentName: string;
  protocol: AgentProtocol;
  voiceId: string;
  /** The agent's words to recognise, for its STT session. */
  keyterms: readonly string[];
  createAgent: AgentFactory;
  /** Set for a `cord-connector` agent: the user's computer and the agent on it (ADR-023). */
  connector?: ConnectorEndpoint;
  /** The first agent turn, so the agent speaks first (an answered ring, ADR-024). */
  openingTurn?: string;
  /** The ring message spoken before the agent's streamed reply. */
  openingLine?: string;
}

/** Who owns the agent a call is to: the caller, or the owner of a shared server agent. */
export function agentOwner(agent: Pick<SavedAgentCall, 'userId' | 'agentOwnerId'>): string {
  return agent.agentOwnerId ?? agent.userId;
}

/** What an answered ring adds to a saved-agent call (ADR-024). */
export interface SavedAgentExtras {
  /** The agent session the connector should resume. */
  resumeRef?: string;
  /** The call's first agent turn. */
  openingTurn?: string;
  /** The ring message spoken before the agent's streamed reply. */
  openingLine?: string;
}

/** Per-call limits and hooks from the route. */
export interface CallCreateLimits {
  /** Calling seconds the owner has left today; caps this call below CALL_MAX_DURATION_S. */
  dailySecondsLeft?: number;
  /**
   * Gives back the call's daily count. Runs when a connector agent's computer went offline (or
   * dropped the agent) after the call was admitted but before any turn reached the agent.
   */
  refund?: () => Promise<void>;
  /** The speech keys this call uses (the person's own or Twring's). */
  speech?: ResolvedSpeech;
}

interface CallRecord {
  /** The room and caller identity are the audio's (Twring-run audio names its own). */
  ids: CallIds;
  /** Where the call's audio is, once started. */
  audioUrl?: string;
  agent?: SavedAgentCall;
  /** The user who created the call; only they can read or end it through the API. */
  ownerId?: string;
  status: CallRecordStatus;
  createdAt: Date;
  endedAt?: Date;
  runtime?: CallRuntime;
  ended?: Promise<void>;
  /** Calling seconds the owner has left today; caps this call below CALL_MAX_DURATION_S. */
  dailySecondsLeft?: number;
  refund?: () => Promise<void>;
  /** The call's keys, only until its providers are built; cleared so no key outlives the start. */
  speech?: ResolvedSpeech;
  /** Whose key each provider used, for history. Never the key. */
  speechSource?: NonNullable<CallHistoryItem['speech_source']>;
}

/** Endings before any turn that mean the user's computer, not the user, stopped the call. */
const REFUNDED_REASONS: ReadonlySet<EndReason> = new Set([
  'agent_offline',
  'agent_not_on_computer',
]);

/** Finished calls stay queryable for a while; durable history arrives with the database. */
const MAX_FINISHED_RECORDS = 200;

/** How long graceful shutdown waits for the history of the calls it ended before exiting. */
export const SHUTDOWN_HISTORY_WAIT_MS = 3_000;

/**
 * Owns every call this process runs: creation limits, the room and tokens, the runtime, and
 * idempotent teardown. One process = one owner per call (BACKEND_SPEC §10).
 */
export class CallRegistry {
  private readonly calls = new Map<string, CallRecord>();
  private readonly newIds: () => CallIds;
  private readonly now: () => Date;
  private shuttingDown = false;
  /** History writes still in flight; shutdown waits for them (bounded). */
  private readonly pendingHistory = new Set<Promise<void>>();
  /** Data deletions per user (one small entry per user who ever deleted their data). */
  private readonly erasures = new Map<string, number>();

  private readonly audio: CallAudio;

  constructor(private readonly options: CallRegistryOptions) {
    this.newIds = options.newIds ?? newCallIds;
    if (options.audio !== undefined) {
      this.audio = options.audio;
    } else if (options.liveKitUrl !== undefined && options.rooms && options.tokens) {
      this.audio = new OwnLiveKitAudio({
        url: options.liveKitUrl,
        rooms: options.rooms,
        tokens: options.tokens,
      });
    } else {
      throw new Error('CallRegistry needs audio, or liveKitUrl, rooms and tokens');
    }
    this.now = options.now ?? (() => new Date());
  }

  get activeCount(): number {
    let count = 0;
    for (const record of this.calls.values()) if (isLive(record.status)) count += 1;
    return count;
  }

  /** True while `userId` has a call that is created, connecting, connected, or ending. */
  hasLiveCall(userId: string): boolean {
    for (const record of this.calls.values()) {
      if (record.ownerId === userId && isLive(record.status)) return true;
    }
    return false;
  }

  hasLiveCallToAgent(userId: string, agentId: string): boolean {
    for (const record of this.calls.values()) {
      if (
        isLive(record.status) &&
        record.agent?.userId === userId &&
        record.agent.agentId === agentId
      )
        return true;
    }
    return false;
  }

  /**
   * Without `agent`, the call uses the configured development audio mode. `ownerId` is the acting
   * user (a saved agent's calls always belong to the agent's user).
   */
  async create(
    agent?: SavedAgentCall,
    ownerId?: string,
    limits: CallCreateLimits = {},
  ): Promise<CreateCallResponse> {
    const { env, logger } = this.options;
    const { audio } = this;
    if (!env.CALLS_ENABLED) throw new CallCreateError('disabled');
    if (this.shuttingDown) throw new CallCreateError('updating');
    const owner = agent?.userId ?? ownerId;
    // One call at a time per user, like a phone line. Checked and reserved with no await in
    // between, so of two parallel starts exactly one gets the line.
    if (owner !== undefined && this.hasLiveCall(owner)) throw new CallCreateError('in_progress');
    if (this.activeCount >= env.CALL_MAX_CONCURRENT) throw new CallCreateError('capacity');

    const ids = this.newIds();
    const createdAt = this.now();
    const record: CallRecord = {
      ids,
      status: 'created',
      createdAt,
      ...(agent && { agent }),
      ...(owner !== undefined && { ownerId: owner }),
      ...(limits.dailySecondsLeft !== undefined && { dailySecondsLeft: limits.dailySecondsLeft }),
      ...(limits.refund !== undefined && { refund: limits.refund }),
      ...(limits.speech !== undefined && {
        speech: limits.speech,
        speechSource: speechSource(limits.speech),
      }),
    };
    // Reserve the slot before any await so concurrent requests cannot exceed the cap.
    this.calls.set(ids.callId, record);

    let session: Awaited<ReturnType<CallAudio['start']>>;
    try {
      // A failed start cleans up after itself (the own LiveKit deletes the room it named).
      session = await audio.start(
        ids.callId,
        { room: ids.room, callerIdentity: ids.callerIdentity },
        { callerTtlSeconds: env.CALL_TOKEN_TTL_S, gatewayTtlSeconds: env.CALL_MAX_DURATION_S },
      );
    } catch (error) {
      delete record.speech;
      record.status = 'failed';
      record.endedAt = this.now();
      logger.warn(
        { event: 'call_create_failed', call_id: ids.callId, err: toSafeError(error) },
        'could not mint call tokens',
      );
      this.pruneFinished();
      throw new CallCreateError(error instanceof CallAudioError ? error.code : 'provider');
    }
    record.ids = { ...ids, room: session.room, callerIdentity: session.callerIdentity };
    record.audioUrl = session.url;
    const { callerToken, gatewayToken } = session;
    if (record.status !== 'created') {
      // Ended while its tokens were minted (data deletion, agent change, shutdown): the hang-up
      // wins, so the call never starts and the phone never gets a token for it.
      delete record.speech;
      record.status = 'ended';
      record.endedAt = this.now();
      void audio.end(session.room).catch(() => undefined);
      this.pruneFinished();
      throw new CallCreateError('disabled');
    }

    logger.info({ event: 'call_created', call_id: ids.callId, session_id: ids.sessionId });
    this.startRuntime(record, gatewayToken);

    return {
      call_id: ids.callId,
      session_id: ids.sessionId,
      livekit: { url: session.url, token: callerToken, room: session.room },
      expires_at: (
        session.expiresAt ?? new Date(createdAt.getTime() + env.CALL_TOKEN_TTL_S * 1000)
      ).toISOString(),
    };
  }

  get(callId: string): CallSummary | undefined {
    const record = this.calls.get(callId);
    return record && summarize(record);
  }

  /** The call when `userId` owns it; otherwise undefined, exactly as for an unknown call. */
  getFor(userId: string, callId: string): CallSummary | undefined {
    const record = this.calls.get(callId);
    return record?.ownerId === userId ? summarize(record) : undefined;
  }

  feedbackTargetFor(
    userId: string,
    callId: string,
  ): { agentId: string; protocol?: AgentProtocol } | undefined {
    const record = this.calls.get(callId);
    if (record?.ownerId !== userId) return undefined;
    return {
      agentId: record.agent?.agentId ?? '',
      ...(record.agent && { protocol: record.agent.protocol }),
    };
  }

  decideApprovalFor(
    userId: string,
    callId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
  ): 'applied' | 'decided' | 'unknown' {
    const record = this.calls.get(callId);
    if (record?.ownerId !== userId || !isLive(record.status)) return 'unknown';
    return record.runtime?.decideApproval(approvalId, decision) ?? 'unknown';
  }

  /**
   * How many times `userId`'s data has been deleted (`endCallsForUser`). A call to an agent looked
   * up before a deletion must not start after it: callers compare this before and after the lookup.
   */
  erasureCount(userId: string): number {
    return this.erasures.get(userId) ?? 0;
  }

  /** Idempotent hang-up of a call `userId` owns. Undefined when unknown or someone else's. */
  async endFor(userId: string, callId: string): Promise<CallSummary | undefined> {
    if (this.calls.get(callId)?.ownerId !== userId) return undefined;
    return this.end(callId);
  }

  /**
   * Ends every live call `userId` owns (they asked for their data to be deleted, so it is their
   * own hang-up). Resolves how many were live.
   */
  async endCallsForUser(userId: string): Promise<number> {
    this.erasures.set(userId, this.erasureCount(userId) + 1);
    const live = [...this.calls.values()].filter(
      (record) => isLive(record.status) && record.ownerId === userId,
    );
    await Promise.all(live.map((record) => this.end(record.ids.callId, 'hangup')));
    // Their history is written as they finish; let it land so a deletion that follows sees it.
    await this.waitForHistory();
    return live.length;
  }

  /** Idempotent hang-up. Undefined when the call is unknown. */
  async end(callId: string, reason: EndReason = 'hangup'): Promise<CallSummary | undefined> {
    const record = this.calls.get(callId);
    if (record === undefined) return undefined;
    if (isLive(record.status)) {
      record.status = 'ending';
      record.ended ??= record.runtime?.end(reason);
    }
    await record.ended;
    return summarize(record);
  }

  /**
   * Ends every live call to one saved agent: its credential, endpoint, or protocol changed, or it
   * was deleted, so the call must stop using it now (SECURITY §20). The phone is told
   * `agent_unavailable`.
   */
  async endCallsForAgent(
    userId: string,
    agentId: string,
    reason: EndReason = 'agent_unavailable',
  ): Promise<void> {
    await Promise.all(
      [...this.calls.values()]
        .filter(
          (record) =>
            isLive(record.status) &&
            record.agent !== undefined &&
            agentOwner(record.agent) === userId &&
            record.agent.agentId === agentId,
        )
        .map((record) => this.end(record.ids.callId, reason)),
    );
  }

  /**
   * Ends every live call to an agent on one of the user's computers: that computer was removed
   * (revoked). The phone is told `agent_offline`, the same notice as a computer that went away.
   */
  async endCallsForConnector(userId: string, connectorId: string): Promise<void> {
    await Promise.all(
      [...this.calls.values()]
        .filter(
          (record) =>
            isLive(record.status) &&
            record.agent !== undefined &&
            agentOwner(record.agent) === userId &&
            record.agent.connector?.connectorId === connectorId,
        )
        .map((record) => this.end(record.ids.callId, 'agent_offline')),
    );
  }

  /** Refuses new calls (the server is about to restart); live calls carry on. */
  drain(): void {
    this.shuttingDown = true;
  }

  /** Graceful shutdown: refuse new calls, end every live one, and let their history land. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      [...this.calls.values()]
        .filter((record) => isLive(record.status))
        .map((record) => this.end(record.ids.callId, 'shutdown')),
    );
    await this.waitForHistory();
  }

  /** Waits (bounded) for the history writes in flight. */
  private async waitForHistory(): Promise<void> {
    if (this.pendingHistory.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.pendingHistory]),
      new Promise((resolve) => (timer = setTimeout(resolve, SHUTDOWN_HISTORY_WAIT_MS))),
    ]);
    clearTimeout(timer);
  }

  private startRuntime(record: CallRecord, gatewayToken: string): void {
    const { env, transports, scheduler, logger } = this.options;
    const { audio } = this;
    const { ids, agent, speech } = record;
    record.status = 'connecting';
    const voice = this.options.voice && {
      stt:
        agent && this.options.sttForKeyterms
          ? this.options.sttForKeyterms(agent.keyterms, agent.agentName, speech)
          : this.options.voice.stt,
      tts:
        agent && this.options.ttsForVoice
          ? this.options.ttsForVoice(agent.voiceId, speech)
          : this.options.voice.tts,
    };
    const ownKeyProviders =
      agent && speech && ownKeySides(agent.voiceId, speech, this.options.speaksServerXai === true);
    // The providers hold what they need; the record keeps no plaintext key from here on.
    delete record.speech;
    const createAgent = agent?.createAgent ?? this.options.createAgent;
    const callCapMs = env.CALL_MAX_DURATION_S * 1000;
    const dailyCapMs =
      record.dailySecondsLeft === undefined ? Infinity : record.dailySecondsLeft * 1000;
    const runtime = new CallRuntime({
      callId: ids.callId,
      transport: transports({
        url: record.audioUrl!,
        token: gatewayToken,
        callerIdentity: ids.callerIdentity,
      }),
      audioMode: agent
        ? agent.protocol === 'cord-native'
          ? 'native'
          : 'rest'
        : env.GATEWAY_AUDIO_TEST_MODE,
      ...(voice && { voice }),
      ...(createAgent && { createAgent }),
      ...(env.DEBUG_AUDIO_CAPTURE_DIR !== undefined && { captureDir: env.DEBUG_AUDIO_CAPTURE_DIR }),
      ...(ownKeyProviders && { ownKeyProviders }),
      maxDurationMs: Math.min(callCapMs, dailyCapMs),
      maxDurationReason: dailyCapMs < callCapMs ? 'daily_limit' : 'max_duration',
      agentTurnMaxMs: env.AGENT_TURN_MAX_S * 1000,
      usageRates: usageRates(env),
      ...(agent?.openingTurn !== undefined && { openingTurn: agent.openingTurn }),
      ...(agent?.openingLine !== undefined && { openingLine: agent.openingLine }),
      ...(agent !== undefined && { agentName: agent.agentName }),
      presenceCues: env.PRESENCE_CUES !== 'off',
      acknowledge: env.PRESENCE_ACK !== 'off',
      ...(env.SHORT_TURN_HOLD_MS !== undefined && { shortTurnHoldMs: env.SHORT_TURN_HOLD_MS }),
      scheduler,
      logger,
      onCallerJoined: () => {
        if (record.status === 'connecting') record.status = 'active';
      },
      onUnexpectedParticipant: (identity) => {
        audio.removeParticipant(ids.room, identity).catch((error: unknown) => {
          logger.warn(
            { event: 'participant_remove_failed', call_id: ids.callId, err: toSafeError(error) },
            'could not remove an unexpected participant',
          );
        });
      },
      onEnded: ({ failed, reason, usage }) => {
        record.status = failed ? 'failed' : 'ended';
        record.endedAt = this.now();
        this.recordHistory(record, failed, reason, usage);
        this.recordFinished(record);
        if (REFUNDED_REASONS.has(reason) && usage.agent_turns === 0) this.refund(record);
        // Deleting the room disconnects the phone promptly instead of leaving it in a dead room.
        // Tracked with history so shutdown waits (bounded) for the relay to hear the end.
        const ended = audio.end(ids.room).catch((error: unknown) => {
          logger.warn(
            { event: 'room_delete_failed', call_id: ids.callId, err: toSafeError(error) },
            'could not delete the call room',
          );
        });
        const tracked: Promise<void> = ended.finally(() => this.pendingHistory.delete(tracked));
        this.pendingHistory.add(tracked);
        this.pruneFinished();
      },
    });
    record.runtime = runtime;
    void runtime.start();
  }

  /** Summary only: no transcript, no audio (DATA_MODEL §5). Never blocks or fails the hang-up. */
  private recordHistory(
    record: CallRecord,
    failed: boolean,
    reason: EndReason,
    usage: CallUsage,
  ): void {
    const { agent, endedAt } = record;
    const { history, logger } = this.options;
    if (agent === undefined || history === undefined || endedAt === undefined) return;
    const write = history
      .record(agent.userId, {
        call_id: record.ids.callId,
        agent_id: agent.agentId,
        agent_name: agent.agentName,
        started_at: record.createdAt.toISOString(),
        duration_s: Math.max(
          0,
          Math.round((endedAt.getTime() - record.createdAt.getTime()) / 1000),
        ),
        outcome: failed ? 'failed' : 'completed',
        end_reason: publicEndReason(reason),
        usage,
        ...(record.speechSource && { speech_source: record.speechSource }),
      })
      .catch((error: unknown) => {
        logger.warn(
          { event: 'call_history_failed', call_id: record.ids.callId, err: toSafeError(error) },
          'could not record call history',
        );
      })
      .finally(() => this.pendingHistory.delete(write));
    this.pendingHistory.add(write);
  }

  /** Reports the call's length for the daily allowance. Never blocks or fails the hang-up. */
  private recordFinished(record: CallRecord): void {
    const { ownerId, endedAt } = record;
    const { onCallFinished, logger } = this.options;
    if (onCallFinished === undefined || ownerId === undefined || endedAt === undefined) return;
    const durationS = Math.max(0, (endedAt.getTime() - record.createdAt.getTime()) / 1000);
    const write = onCallFinished({ ownerId, startedAt: record.createdAt, durationS })
      .catch((error: unknown) => {
        logger.warn(
          { event: 'daily_usage_failed', call_id: record.ids.callId, err: toSafeError(error) },
          'could not record daily usage',
        );
      })
      .finally(() => this.pendingHistory.delete(write));
    this.pendingHistory.add(write);
  }

  /** Gives back the call's daily count. Never blocks or fails the hang-up. */
  private refund(record: CallRecord): void {
    const { refund } = record;
    if (refund === undefined) return;
    record.refund = undefined;
    const write = refund()
      .catch((error: unknown) => {
        this.options.logger.warn(
          { event: 'daily_refund_failed', call_id: record.ids.callId, err: toSafeError(error) },
          'could not give back the daily call count',
        );
      })
      .finally(() => this.pendingHistory.delete(write));
    this.pendingHistory.add(write);
  }

  private pruneFinished(): void {
    const finished = [...this.calls.values()].filter((r) => !isLive(r.status));
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_RECORDS))) {
      this.calls.delete(record.ids.callId);
    }
  }
}

/**
 * Which sides of a call run on the person's own key, mirroring the TTS router's and the call
 * STT's choices: a Cartesia voice speaks on Cartesia when a Cartesia key exists, a Grok voice on
 * xAI when an xAI key exists (always the person's own), otherwise on Deepgram.
 */
function ownKeySides(
  voiceId: string,
  speech: ResolvedSpeech,
  serverXai: boolean,
): NonNullable<CallRuntimeOptions['ownKeyProviders']> {
  if (serverXai) {
    // Mirrors `serverXaiCallVoice`: each side is blamed on the key it actually ran on.
    const stt = serverXaiListensOnDeepgram(speech)
      ? ('deepgram' as const)
      : speech.listening === 'xai'
        ? ('xai' as const)
        : undefined;
    const tts = serverXaiTtsSide(voiceId, speech);
    return {
      ...(stt !== undefined && speech[stt]?.source === 'own' && { stt }),
      ...(speech[tts]?.source === 'own' && { tts }),
    };
  }
  const ttsProvider =
    xaiVoice(voiceId) !== undefined && speech.xai !== undefined
      ? 'xai'
      : cartesiaVoice(voiceId) !== undefined && speech.cartesia !== undefined
        ? 'cartesia'
        : 'deepgram';
  const sttProvider =
    speech.listening === 'xai' && speech.xai !== undefined ? 'xai' : ('deepgram' as const);
  return {
    ...(speech[sttProvider]?.source === 'own' && { stt: sttProvider }),
    ...(speech[ttsProvider]?.source === 'own' && { tts: ttsProvider }),
  };
}

function speechSource(speech: ResolvedSpeech): NonNullable<CallHistoryItem['speech_source']> {
  return {
    ...(speech.deepgram && { deepgram: speech.deepgram.source }),
    ...(speech.cartesia && { cartesia: speech.cartesia.source }),
    ...(speech.xai && { xai: speech.xai.source }),
  };
}

function isLive(status: CallRecordStatus): boolean {
  return status !== 'ended' && status !== 'failed';
}

function summarize(record: CallRecord): CallSummary {
  return {
    call_id: record.ids.callId,
    status: record.status,
    created_at: record.createdAt.toISOString(),
    ...(record.endedAt && { ended_at: record.endedAt.toISOString() }),
  };
}
