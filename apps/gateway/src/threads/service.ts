import { createHash, randomUUID } from 'node:crypto';

import { isAdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import {
  APPROVAL_HOLD_MS,
  CONNECTOR_APPROVALS_MAX_PENDING,
  MAX_ACTIVITY_LABEL_CHARS,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  parseConnectorEndpoint,
  SEALED_TURN_IDLE_MS,
  SEALED_FILES_FEATURE,
  SEALED_WORKING_FEATURE,
  sanitizeRingText,
  truncateRingText,
  userRef,
  type ConnectorApproval,
  type SealedEnvelopeV1,
  type ThreadMessage,
  type ThreadSocketFrame,
  type UserMessageStatus,
  type CallHistoryItem,
  type TurnAttachment,
} from '@twring/contracts';

import type { AgentFactory } from '../calls/agents';
import type { AgentRecord, AgentRepository } from '../store/repositories';
import { ownerUnavailable, type RingService } from '../ring/service';
import { FileStoreError, ThreadStoreError, type SqliteThreadStore } from './store';
import type { FileService } from '../files/service';
import { fetchAgentFile, FetchAgentFileError } from '../files/fetch-agent-file';
import { sniffFile } from '../files/sniff';
import { withQuote } from './quote';
import { PRIVATE_PUSH_TEXT, PRIVATE_RING_REASON } from '../e2e/guard';
import { PrivateIdle } from './private-idle';

export interface ThreadTurnTimeouts {
  connectMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
}
/** Past the total turn cap, how long a `sent`/`working` turn with no live run is left alone. */
const STALE_TURN_MARGIN_MS = 5 * 60_000;

export const THREAD_TURN_TIMEOUTS: ThreadTurnTimeouts = {
  connectMs: 10_000,
  firstEventMs: 60_000,
  idleMs: 120_000,
  totalMs: 30 * 60_000,
};
/** How long a finished turn waits for its adapter to close before freeing the agent. */
export const ADAPTER_CLOSE_MS = 5_000;
export interface ThreadServiceOptions {
  store: SqliteThreadStore;
  files?: FileService;
  fileFetchEnv?: 'development' | 'staging' | 'production';
  agents: Pick<AgentRepository, 'get'>;
  agentFactory(userId: string, record: AgentRecord): AgentFactory;
  agentStatus(userId: string, record: AgentRecord): 'online' | 'offline' | 'agent_missing';
  hasLiveCallToAgent(userId: string, agentId: string): boolean;
  ring?: RingService;
  isFocused?: (userId: string, agentId: string) => boolean;
  /** Checks that a focused phone still answers before a push is skipped; falls back to `isFocused`. */
  confirmFocused?: (userId: string, agentId: string) => Promise<boolean>;
  notify(userId: string, frame: ThreadSocketFrame): void;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  timeouts?: Partial<ThreadTurnTimeouts>;
  sweepIntervalMs?: number;
  /** Silence after which a private turn is interrupted (default `SEALED_TURN_IDLE_MS`, ADR-045). */
  privateIdleMs?: number;
  /**
   * Private chats (ADR-044). Absent: no chat can become private, and sealed messages are refused.
   * `computerSupports` is true only when the agent's computer is connected and said `sealed_chat`.
   */
  privateChats?: {
    allowed(userId: string): boolean;
    computerSupports(record: AgentRecord): boolean;
    /** Sends a sealed message unchanged to the agent's computer; false when it cannot. */
    deliver(record: AgentRecord, messageId: string, sealed: SealedEnvelopeV1): boolean;
    /** Sends the phone's sealed approval answer unchanged to the computer (C3 #11). */
    deliverDecision(record: AgentRecord, messageId: string, sealed: SealedEnvelopeV1): boolean;
    /**
     * Tells the computer the phone stopped private turn `turnId` (C3 #11); best effort, false when
     * it is offline or did not say `sealed_cancel`.
     */
    cancel?(record: AgentRecord, turnId: string): boolean;
    /** True when the computer is connected and its hello said `feature` (ADR-045). */
    computerHas?(record: AgentRecord, feature: string): boolean;
  };
}
export class ThreadServiceError extends Error {
  constructor(
    readonly code:
      | 'agent_not_found'
      | 'queue_full'
      | 'bad_attachment'
      | 'approval_conflict'
      | 'approval_not_found'
      | 'reply_to_not_found'
      | 'message_in_progress'
      | 'private_chats_off'
      | 'private_unsupported'
      | 'private_thread'
      | 'not_private'
      | 'approvals_full'
      | 'computer_offline',
    readonly current?: ThreadMessage,
  ) {
    super(code);
    this.name = 'ThreadServiceError';
  }
}

interface Running {
  userId: string;
  messageId: string;
  turnId: string;
  controller: AbortController;
  adapter?: TwringAgentAdapter;
  stopped: boolean;
  discarded: boolean;
  timedOut: boolean;
  requeued: boolean;
  approval?: {
    messageId: string;
    approvalId: string;
    timer: ReturnType<typeof setTimeout>;
    deciding?: Promise<ThreadMessage>;
  };
}

/** What the computer sees of its approval (ADR-047). */
function connectorView(message: Extract<ThreadMessage, { kind: 'approval' }>): ConnectorApproval {
  return { approval_id: message.id, status: message.status, expires_at: message.expires_at };
}

/** An adapter that never answers a decision must not hold the turn (or its run slot) forever. */
async function boundedAdapterCall(call: Promise<void> | undefined): Promise<void> {
  if (!call) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('adapter_decision_timeout')), ADAPTER_CLOSE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const keyOf = (userId: string, agentId: string) => `${userId}\0${agentId}`;
const fileLabels: Record<string, string> = {
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'image/webp': 'WebP image',
  'application/pdf': 'PDF',
  'text/plain': 'text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'application/json': 'JSON',
};
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * A sealed message's `client_id` is a UUID in the wire contract, and a computer's Idempotency-Key
 * is any printable string. The same key in the same chat always maps to the same UUID, so a retry
 * stores one message, and the phone's random client ids never collide with it.
 */
function sealedPostClientId(userId: string, agentId: string, key: string): string {
  const hex = createHash('sha256')
    .update(`twring-sealed-post\0${userId}\0${agentId}\0${key}`)
    .digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class ThreadService {
  /** Sealed replies dropped as not this account's, not private, or not a known turn (ADR-044). */
  sealedRepliesRejected = 0;
  private readonly running = new Map<string, Running>();
  /** Connector approvals (ADR-047): expiry timers and long-poll waiters, by message id. */
  private readonly connectorApprovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly connectorApprovalWaiters = new Map<string, Set<() => void>>();
  private readonly newSessionNotices = new Map<string, number>();
  private readonly sendLocks = new Map<string, Promise<void>>();
  private readonly timeouts: ThreadTurnTimeouts;
  private readonly idle: PrivateIdle;
  private timer?: ReturnType<typeof setInterval>;
  private starting?: Promise<void>;
  private epoch = 0;
  private sweeping = false;

  constructor(private readonly options: ThreadServiceOptions) {
    this.timeouts = { ...THREAD_TURN_TIMEOUTS, ...options.timeouts };
    this.idle = new PrivateIdle(options.privateIdleMs ?? SEALED_TURN_IDLE_MS);
  }

  async noteNewSession(userId: string, agentId: string): Promise<void> {
    const key = keyOf(userId, agentId);
    const now = Date.now();
    if (now - (this.newSessionNotices.get(key) ?? -Infinity) < 60_000) return;
    this.newSessionNotices.set(key, now);
    try {
      const message = await this.options.store.appendMessage(userId, agentId, {
        kind: 'notice',
        code: 'new_session',
      });
      this.upsert(userId, message);
    } catch {
      // A notice is best effort and must never fail the agent turn.
    }
  }

  async deliverResult(
    userId: string,
    agentId: string,
    input: {
      text: string;
      origin: 'call_turn' | 'text_turn' | 'agent';
      turnId?: string;
      sessionRef?: string;
      idempotencyKey: string;
      fileIds?: string[];
      target: { connectorId?: string; localAgent?: string; agentName: string };
    },
  ): Promise<{ messageId: string; delivery: 'ring' | 'push' | 'none'; created: boolean }> {
    const saved = await this.options.store.appendMessage(userId, agentId, {
      kind: 'agent_text',
      text: input.text,
      turn_id: input.turnId,
      partial: false,
      clientId: input.idempotencyKey,
      attachmentIds: input.fileIds,
    });
    const messageId = saved.message.id;
    if (!saved.created) return { messageId, delivery: 'none', created: false };
    this.upsert(userId, saved.message);
    if (input.turnId) {
      const turn = await this.options.store.findUserMessageByTurn(userId, input.turnId);
      if (
        turn?.kind === 'user_text' &&
        turn.agent_id === agentId &&
        ['sent', 'working', 'interrupted'].includes(turn.status)
      ) {
        const answered = await this.options.store.updateUserMessage(userId, turn.id, {
          status: 'answered',
        });
        if (answered) this.upsert(userId, answered);
      }
    }
    const delivery = await this.announceResult(userId, agentId, {
      messageId,
      text: input.text,
      ring: input.origin === 'call_turn' && input.text.trim() !== '',
      sessionRef: input.sessionRef,
      target: input.target,
    });
    this.options.log?.info(
      {
        event: 'result_delivered',
        agent_id: agentId,
        message_id: messageId,
        origin: input.origin,
        delivery,
        length: input.text.length,
      },
      'result_delivered',
    );
    return { messageId, delivery, created: true };
  }

  /** True when this person's chat with the agent is private. */
  isPrivate(userId: string, agentId: string): Promise<boolean> {
    return this.options.store.isPrivate(userId, agentId);
  }

  /**
   * Rings or pushes for a delivered result, unless a call is live or the chat is on screen. A
   * private chat's ring and push carry fixed words, never the agent's text (ADR-044); `text` is
   * undefined for a sealed result, which the server cannot read.
   */
  private async announceResult(
    userId: string,
    agentId: string,
    input: {
      messageId: string;
      text: string | undefined;
      ring: boolean;
      sessionRef?: string;
      target: { connectorId?: string; localAgent?: string; agentName: string };
    },
  ): Promise<'ring' | 'push' | 'none'> {
    let delivery: 'ring' | 'push' | 'none' = 'none';
    if (this.options.hasLiveCallToAgent(userId, agentId) || !this.options.ring) return delivery;
    const settings = await this.options.ring.settings(userId);
    const sealedChat =
      input.text === undefined || (await this.options.store.isPrivate(userId, agentId));
    if (input.ring && (settings.after_call_result ?? 'ring') === 'ring') {
      const clean = (input.text ?? '')
        .replace(/⟪[^⟫]*⟫/gu, '')
        .replace(/\s+/gu, ' ')
        .replace(/\s+([.!?])/gu, '$1')
        .trim();
      const end = /[.!?](?= |$)/u.exec(clean);
      const reason = sealedChat
        ? PRIVATE_RING_REASON
        : truncateRingText(sanitizeRingText(end ? clean.slice(0, end.index + 1) : clean), 140);
      const result = await this.options.ring.ring({
        userId,
        agentId,
        ...(input.target.connectorId !== undefined && { connectorId: input.target.connectorId }),
        ...(input.target.localAgent !== undefined && { localAgent: input.target.localAgent }),
        agentName: input.target.agentName,
        reason,
        messageId: input.messageId,
        ...(input.sessionRef && { sessionRef: input.sessionRef }),
      });
      if ('invite' in result) delivery = 'ring';
    }
    if (delivery === 'none' && !(await this.focused(userId, agentId))) {
      const attempted = await this.options.ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: input.target.agentName,
        message_id: input.messageId,
        preview: sealedChat
          ? PRIVATE_PUSH_TEXT
          : truncateRingText(sanitizeRingText((input.text ?? '').split('\n')[0] ?? ''), 120),
        silent: ownerUnavailable(settings, this.options.ring.nowDate()) ? '1' : '0',
      });
      if (attempted > 0) delivery = 'push';
    }
    return delivery;
  }

  /**
   * A computer's own message into a private chat, already sealed by the computer (ADR-045). Stored
   * as a sealed agent message with no turn. The caller has checked the chat is private and that
   * every envelope is from this computer. Dedupes by the Idempotency-Key.
   */
  async deliverSealedResult(
    userId: string,
    agentId: string,
    input: {
      sealed: SealedEnvelopeV1[];
      fileIds?: string[];
      origin: 'call_turn' | 'text_turn' | 'agent';
      sessionRef?: string;
      idempotencyKey: string;
      /** A background result that rings the phone (with the private reason). */
      ring?: boolean;
      target: { connectorId?: string; localAgent?: string; agentName: string };
    },
  ): Promise<{ messageId: string; delivery: 'ring' | 'push' | 'none'; created: boolean }> {
    const saved = await this.options.store.appendSealedMessage(userId, agentId, {
      author: 'agent',
      sealed: input.sealed,
      clientId: sealedPostClientId(userId, agentId, input.idempotencyKey),
      ...(input.fileIds && { attachmentIds: input.fileIds }),
    });
    const messageId = saved.message.id;
    if (!saved.created) return { messageId, delivery: 'none', created: false };
    this.upsert(userId, saved.message);
    const delivery = await this.announceResult(userId, agentId, {
      messageId,
      text: undefined,
      ring: input.ring === true,
      sessionRef: input.sessionRef,
      target: input.target,
    });
    this.options.log?.info(
      {
        event: 'sealed_result_delivered',
        agent_id: agentId,
        message_id: messageId,
        origin: input.origin,
        delivery,
        chunks: input.sealed.length,
        files: input.fileIds?.length ?? 0,
      },
      'sealed_result_delivered',
    );
    return { messageId, delivery, created: true };
  }

  async recordRing(invite: {
    user_id: string;
    agent_id: string;
    id: string;
    reason: string;
    status: 'answered' | 'declined' | 'missed' | 'cancelled';
    note?: string;
  }): Promise<void> {
    const sealedChat = await this.options.store.isPrivate(invite.user_id, invite.agent_id);
    const message = await this.options.store.appendMessage(invite.user_id, invite.agent_id, {
      kind: 'ring',
      invite_id: invite.id,
      reason: sealedChat ? PRIVATE_RING_REASON : invite.reason,
      outcome: invite.status,
      note: invite.note,
    });
    this.upsert(invite.user_id, message);
  }

  async recordCall(userId: string, item: CallHistoryItem): Promise<void> {
    if (item.kind === 'missed_invite') return;
    try {
      const message = await this.options.store.appendMessage(userId, item.agent_id, {
        kind: 'call',
        call_id: item.call_id,
        duration_s: item.duration_s,
        outcome: item.outcome,
        end_reason: item.end_reason,
      });
      this.upsert(userId, message);
    } catch (error) {
      this.options.log?.warn(
        {
          event: 'thread_call_record_failed',
          error: error instanceof Error ? error.name : 'unknown',
        },
        'thread_call_record_failed',
      );
    }
  }

  async pushSettledResult(invite: {
    user_id: string;
    agent_id: string;
    agent_name: string;
    status: string;
    message_id?: string;
  }): Promise<void> {
    if (
      (invite.status !== 'declined' && invite.status !== 'missed') ||
      !invite.message_id ||
      !this.options.ring ||
      (await this.focused(invite.user_id, invite.agent_id))
    )
      return;
    const result = await this.options.store.findMessageById(
      invite.user_id,
      invite.agent_id,
      invite.message_id,
    );
    if (result?.kind !== 'agent_text') return;
    const settings = await this.options.ring.settings(invite.user_id);
    await this.options.ring.pushMessage(invite.user_id, {
      type: 'cord.message',
      user_ref: userRef(invite.user_id),
      agent_id: invite.agent_id,
      agent_name: invite.agent_name,
      message_id: invite.message_id,
      preview: (await this.options.store.isPrivate(invite.user_id, invite.agent_id))
        ? PRIVATE_PUSH_TEXT
        : truncateRingText(sanitizeRingText(result.text.split('\n')[0] ?? ''), 120),
      silent: ownerUnavailable(settings, this.options.ring.nowDate()) ? '1' : '0',
    });
  }

  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    // Concurrent starts share one run; a stop() in between cancels it (epoch), so no interval leaks.
    this.starting ??= (async () => {
      const epoch = this.epoch;
      await this.settleAppMessages();
      await this.options.store.interruptInFlight();
      await this.options.store.expirePendingApprovals();
      if (epoch !== this.epoch || this.timer) return;
      this.timer = setInterval(() => void this.sweep(), this.options.sweepIntervalMs ?? 5_000);
      this.timer.unref();
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  stop(): void;
  stop(userId: string, messageId: string): Promise<ThreadMessage | undefined>;
  stop(userId?: string, messageId?: string): void | Promise<ThreadMessage | undefined> {
    if (userId === undefined || messageId === undefined) {
      this.epoch++;
      clearInterval(this.timer);
      this.timer = undefined;
      for (const timer of this.connectorApprovalTimers.values()) clearTimeout(timer);
      this.connectorApprovalTimers.clear();
      for (const wake of [...this.connectorApprovalWaiters.values()].flatMap((set) => [...set]))
        wake();
      return;
    }
    return this.stopMessage(userId, messageId);
  }

  private async stopMessage(userId: string, messageId: string): Promise<ThreadMessage | undefined> {
    for (const run of this.running.values()) {
      if (run.messageId === messageId && run.userId === userId) {
        run.stopped = true;
        this.cancel(run, 'superseded');
        const changed = await this.options.store.updateUserMessage(userId, messageId, {
          status: 'stopped',
        });
        if (changed) this.upsert(userId, changed);
        return changed;
      }
    }
    const sealed = await this.options.store.findMessageForUser(userId, messageId);
    if (sealed?.message.kind === 'sealed' && sealed.message.author === 'user')
      return this.stopSealed(userId, sealed.agentId, sealed.message);
    const threads = await this.options.store.listThreads(userId);
    for (const thread of threads) {
      const queued = await this.options.store.queuedMessages(userId, thread.agent_id);
      if (queued.some((message) => message.id === messageId)) {
        const changed = await this.options.store.updateUserMessage(userId, messageId, {
          status: 'stopped',
        });
        if (changed) this.upsert(userId, changed);
        return changed;
      }
    }
    for (const thread of threads) {
      let beforeSeq: number | undefined;
      while (true) {
        const page = await this.options.store.listMessages(userId, thread.agent_id, {
          limit: 100,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        });
        const found = page.messages.find((message) => message.id === messageId);
        if (found) return found;
        if (!page.hasMore || page.messages.length === 0) break;
        beforeSeq = page.messages.at(-1)!.seq;
      }
    }
    return undefined;
  }

  /**
   * Stop for a private message (C3 #11). Queued: it is never delivered (the sweep sends only
   * `queued`). Sent or working: marked stopped, then the computer is told, best effort; a reply
   * still arriving is kept and the status stays stopped. Answered or stopped: unchanged.
   */
  private async stopSealed(
    userId: string,
    agentId: string,
    message: Extract<ThreadMessage, { kind: 'sealed' }>,
  ): Promise<ThreadMessage | undefined> {
    const status = message.status;
    if (status !== 'queued' && status !== 'sent' && status !== 'working') return message;
    // Only from a live status: a final reply that landed since the read keeps `answered`.
    const changed = await this.options.store.updateUserMessage(userId, message.id, {
      status: 'stopped',
      from: ['queued', 'sent', 'working'],
    });
    if (!changed) {
      const now = await this.options.store.findMessageForUser(userId, message.id);
      return now?.message;
    }
    this.idle.end(message.id);
    this.upsert(userId, changed);
    let told = false;
    if (status !== 'queued') {
      const record = await this.options.agents.get(userId, agentId);
      told = !!record && this.options.privateChats?.cancel?.(record, message.id) === true;
    }
    this.options.log?.info(
      {
        event: 'thread_sealed_stopped',
        agent_id: agentId,
        message_id: message.id,
        from: status,
        told,
      },
      'thread_sealed_stopped',
    );
    return changed;
  }

  async decideApproval(
    userId: string,
    agentId: string,
    messageId: string,
    decision: 'approve' | 'deny',
  ): Promise<ThreadMessage> {
    const current = await this.options.store.findMessageById(userId, agentId, messageId);
    if (current?.kind !== 'approval') throw new ThreadServiceError('approval_not_found');
    // A computer's approval outside a call (ADR-047) has no turn or relay: decided here.
    const fromComputer = await this.options.store.findConnectorApproval(userId, messageId);
    if (fromComputer !== undefined && fromComputer.agentId === agentId)
      return this.decideConnectorApproval(userId, agentId, fromComputer.message, decision);
    const run = this.running.get(keyOf(userId, agentId));
    const pending = run?.approval;
    if (
      current.status !== 'pending' ||
      !pending ||
      pending.messageId !== messageId ||
      !run?.adapter ||
      run.controller.signal.aborted
    ) {
      throw new ThreadServiceError('approval_conflict', current);
    }
    if (pending.deciding) {
      await pending.deciding.catch(() => undefined);
      throw new ThreadServiceError(
        'approval_conflict',
        (await this.options.store.findMessageById(userId, agentId, messageId)) ?? current,
      );
    }
    const work = (async () => {
      await boundedAdapterCall(
        run.adapter!.decideApproval?.(run.turnId, pending.approvalId, decision),
      );
      clearTimeout(pending.timer);
      const updated = await this.options.store.updateApproval(
        userId,
        agentId,
        messageId,
        decision === 'approve' ? 'allowed' : 'denied',
      );
      if (!updated)
        throw new ThreadServiceError(
          'approval_conflict',
          (await this.options.store.findMessageById(userId, agentId, messageId)) ?? current,
        );
      if (run.approval === pending) run.approval = undefined;
      this.upsert(userId, updated);
      return updated;
    })();
    pending.deciding = work;
    try {
      return await work;
    } catch (error) {
      pending.deciding = undefined;
      throw error;
    }
  }

  /** A linked computer asks its owner to allow one action outside a call (ADR-047). */
  async createConnectorApproval(
    userId: string,
    agentId: string,
    input: {
      connectorId: string;
      agentName: string;
      requestId: string;
      title: string;
      description: string;
      originLabel?: string;
      expiresInS: number;
    },
  ): Promise<{ approval: ConnectorApproval; created: boolean }> {
    // A private chat is sealed: this server must never read the command (ADR-044).
    if (await this.options.store.isPrivate(userId, agentId))
      throw new ThreadServiceError('private_thread');
    const title =
      input.originLabel === undefined ? input.title : `${input.title} (${input.originLabel})`;
    let saved;
    try {
      saved = await this.options.store.appendMessage(userId, agentId, {
        kind: 'approval',
        approval_id: input.requestId,
        title,
        ...(input.description !== '' && { description: input.description }),
        status: 'pending',
        expires_at: new Date(Date.now() + input.expiresInS * 1000).toISOString(),
        clientId: `connector:${input.connectorId}:${input.requestId}`,
        meta: { origin: 'connector', request_id: input.requestId, connector_id: input.connectorId },
        maxPending: CONNECTOR_APPROVALS_MAX_PENDING,
      });
    } catch (cause) {
      if (cause instanceof ThreadStoreError && cause.code === 'approvals_full')
        throw new ThreadServiceError('approvals_full');
      throw cause;
    }
    const message = saved.message;
    if (message.kind !== 'approval') throw new ThreadServiceError('approval_not_found');
    if (!saved.created) {
      const now = await this.readConnectorApproval(userId, input.connectorId, message.id);
      return { approval: now ?? connectorView(message), created: false };
    }
    const timer = setTimeout(
      () => void this.expireConnectorApproval(userId, agentId, message.id).catch(() => undefined),
      Math.max(0, Date.parse(message.expires_at) - Date.now()),
    );
    timer.unref();
    this.connectorApprovalTimers.set(message.id, timer);
    this.upsert(userId, message);
    this.options.log?.info(
      { event: 'connector_approval_created', agent_id: agentId, message_id: message.id },
      'connector_approval_created',
    );
    void this.announceConnectorApproval(userId, agentId, input.agentName, message);
    return { approval: connectorView(message), created: true };
  }

  /** The approval as the computer sees it, long-polled up to `waitMs`. Undefined: not this computer's. */
  async getConnectorApproval(
    userId: string,
    connectorId: string,
    approvalId: string,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<ConnectorApproval | undefined> {
    const first = await this.readConnectorApproval(userId, connectorId, approvalId);
    if (first === undefined || first.status !== 'pending' || waitMs <= 0 || signal?.aborted)
      return first;
    await new Promise<void>((resolve) => {
      const set = this.connectorApprovalWaiters.get(approvalId) ?? new Set();
      this.connectorApprovalWaiters.set(approvalId, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        set.delete(done);
        if (set.size === 0) this.connectorApprovalWaiters.delete(approvalId);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      timer.unref();
      set.add(done);
      signal?.addEventListener('abort', done, { once: true });
      // Settled between the first read and now: no wake-up will come for it.
      void this.readConnectorApproval(userId, connectorId, approvalId).then((now) => {
        if (now?.status !== 'pending') done();
      });
    });
    return this.readConnectorApproval(userId, connectorId, approvalId);
  }

  /** The computer gave up (timeout, interrupt, answered elsewhere): the card stops asking. */
  async cancelConnectorApproval(
    userId: string,
    connectorId: string,
    approvalId: string,
  ): Promise<ConnectorApproval | undefined> {
    const found = await this.options.store.findConnectorApproval(userId, approvalId);
    if (found === undefined || found.connectorId !== connectorId) return undefined;
    if (found.message.status !== 'pending') return connectorView(found.message);
    const expired = await this.expireConnectorApproval(userId, found.agentId, approvalId);
    return connectorView(expired?.kind === 'approval' ? expired : found.message);
  }

  private async readConnectorApproval(
    userId: string,
    connectorId: string,
    approvalId: string,
  ): Promise<ConnectorApproval | undefined> {
    const found = await this.options.store.findConnectorApproval(userId, approvalId);
    if (found === undefined || found.connectorId !== connectorId) return undefined;
    // Past its time but the timer has not run (or the process slept): never answer pending.
    if (found.message.status === 'pending' && Date.parse(found.message.expires_at) <= Date.now()) {
      const expired = await this.expireConnectorApproval(userId, found.agentId, approvalId);
      return connectorView(
        expired?.kind === 'approval' ? expired : { ...found.message, status: 'expired' },
      );
    }
    return connectorView(found.message);
  }

  private async decideConnectorApproval(
    userId: string,
    agentId: string,
    current: Extract<ThreadMessage, { kind: 'approval' }>,
    decision: 'approve' | 'deny',
  ): Promise<ThreadMessage> {
    if (current.status !== 'pending') throw new ThreadServiceError('approval_conflict', current);
    if (Date.parse(current.expires_at) <= Date.now()) {
      const expired = await this.expireConnectorApproval(userId, agentId, current.id);
      throw new ThreadServiceError('approval_conflict', expired ?? current);
    }
    const updated = await this.options.store.updateApproval(
      userId,
      agentId,
      current.id,
      decision === 'approve' ? 'allowed' : 'denied',
    );
    if (!updated)
      throw new ThreadServiceError(
        'approval_conflict',
        (await this.options.store.findMessageById(userId, agentId, current.id)) ?? current,
      );
    this.settleConnectorApproval(userId, updated);
    this.options.log?.info(
      { event: 'connector_approval_decided', agent_id: agentId, message_id: current.id, decision },
      'connector_approval_decided',
    );
    return updated;
  }

  /** Marks a pending connector approval expired. Undefined when it was no longer pending. */
  private async expireConnectorApproval(
    userId: string,
    agentId: string,
    messageId: string,
  ): Promise<ThreadMessage | undefined> {
    const updated = await this.options.store.updateApproval(userId, agentId, messageId, 'expired');
    if (updated) this.settleConnectorApproval(userId, updated);
    else {
      clearTimeout(this.connectorApprovalTimers.get(messageId));
      this.connectorApprovalTimers.delete(messageId);
    }
    return updated;
  }

  private settleConnectorApproval(userId: string, message: ThreadMessage): void {
    clearTimeout(this.connectorApprovalTimers.get(message.id));
    this.connectorApprovalTimers.delete(message.id);
    this.upsert(userId, message);
    for (const wake of [...(this.connectorApprovalWaiters.get(message.id) ?? [])]) wake();
  }

  /**
   * A chat ring (answering opens the chat, never a call) with the title only; a refused ring, a
   * live call with this agent or a ring error leaves the push. Never throws.
   */
  private async announceConnectorApproval(
    userId: string,
    agentId: string,
    agentName: string,
    message: ThreadMessage,
  ): Promise<void> {
    const ring = this.options.ring;
    if (!ring || message.kind !== 'approval') return;
    if (!this.options.hasLiveCallToAgent(userId, agentId)) {
      try {
        const result = await ring.ring({
          userId,
          agentId,
          agentName,
          reason: truncateRingText(sanitizeRingText(`Needs your OK: ${message.title}`), 140),
          messageId: message.id,
        });
        if ('invite' in result) return;
      } catch {
        /* Fall back to the push. */
      }
    }
    await this.notifyApproval(userId, agentId, agentName, message);
  }

  private async expireApproval(run: Running, agentId: string): Promise<void> {
    const pending = run.approval;
    if (!pending) return;
    if (pending.deciding) {
      await pending.deciding.catch(() => undefined);
      if (run.approval === pending) {
        pending.deciding = undefined;
        await this.expireApproval(run, agentId);
      }
      return;
    }
    run.approval = undefined;
    clearTimeout(pending.timer);
    try {
      await boundedAdapterCall(
        run.adapter?.decideApproval?.(run.turnId, pending.approvalId, 'deny'),
      );
    } catch {
      /* The stored expiry is authoritative. */
    }
    const updated = await this.options.store.updateApproval(
      run.userId,
      agentId,
      pending.messageId,
      'expired',
    );
    if (updated) this.upsert(run.userId, updated);
  }

  async send(
    userId: string,
    agentId: string,
    input: {
      clientId: string;
      text: string;
      voice?: { duration_s: number };
      attachmentIds?: string[];
      replyTo?: string;
      /** A consented voice note in a private chat (ADR-044). */
      serverReadable?: true;
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    const key = keyOf(userId, agentId);
    const prior = this.sendLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sendLocks.set(key, current);
    await prior;
    try {
      return await this.sendUnlocked(userId, agentId, input);
    } finally {
      if (this.sendLocks.get(key) === current) this.sendLocks.delete(key);
      release();
    }
  }

  private async sendUnlocked(
    userId: string,
    agentId: string,
    input: {
      clientId: string;
      text: string;
      voice?: { duration_s: number };
      attachmentIds?: string[];
      replyTo?: string;
      serverReadable?: true;
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    const record = await this.options.agents.get(userId, agentId);
    if (!record) throw new ThreadServiceError('agent_not_found');
    // Nothing goes into a private chat in plain text, so it never silently downgrades.
    if (input.serverReadable !== true && (await this.options.store.isPrivate(userId, agentId))) {
      const prior = await this.options.store.findUserMessageByClientId(
        userId,
        agentId,
        input.clientId,
      );
      if (prior) return { message: prior, created: false };
      throw new ThreadServiceError('private_thread');
    }
    if (input.attachmentIds) {
      if (!this.options.files) throw new ThreadServiceError('bad_attachment');
      const prior = await this.options.store.findUserMessageByClientId(
        userId,
        agentId,
        input.clientId,
      );
      for (const id of input.attachmentIds) {
        const file = this.options.store.findFile(userId, id);
        if (
          !file ||
          file.agentId !== agentId ||
          file.direction !== 'owner' ||
          (file.messageId !== null && file.messageId !== prior?.id)
        )
          throw new ThreadServiceError('bad_attachment');
      }
    }
    const mcpApp = record.protocol === 'mcp-app';
    const ready = !mcpApp && (await this.canStart(userId, agentId, record));
    let result: { message: ThreadMessage; created: boolean };
    try {
      result = await this.options.store.appendUserMessage(userId, agentId, {
        ...input,
        // An AI app reads its mailbox (check_replies) and never runs a turn here: the message is
        // delivered, shown as Sent, never as Working (finding 8).
        status: mcpApp ? 'answered' : ready ? 'sent' : 'queued',
      });
    } catch (error) {
      if (error instanceof ThreadStoreError && error.code === 'queue_full')
        throw new ThreadServiceError('queue_full');
      if (error instanceof ThreadStoreError && error.code === 'reply_to_not_found')
        throw new ThreadServiceError('reply_to_not_found');
      if (error instanceof FileStoreError && error.code === 'bad_attachment')
        throw new ThreadServiceError('bad_attachment');
      throw error;
    }
    if (!result.created) return result;
    if (ready && this.options.hasLiveCallToAgent(userId, agentId)) {
      // A call went live while the message was being stored: it waits like any other queued message.
      const queued = await this.options.store.updateUserMessage(userId, result.message.id, {
        status: 'queued',
      });
      if (queued) result = { message: queued, created: true };
      this.upsert(userId, result.message);
      return result;
    }
    this.upsert(userId, result.message);
    if (ready) this.launch(userId, agentId, record, result.message);
    return result;
  }

  /**
   * Makes the chat private (ADR-044): only for this person's own computer agent, when private
   * chats are on for them, the computer is connected and supports them, and so does the app.
   */
  async setPrivate(userId: string, agentId: string, appSupports: boolean): Promise<void> {
    const privateChats = this.options.privateChats;
    if (!privateChats?.allowed(userId)) throw new ThreadServiceError('private_chats_off');
    const record = await this.options.agents.get(userId, agentId);
    if (!record) throw new ThreadServiceError('agent_not_found');
    if (
      !appSupports ||
      record.user_id !== userId ||
      record.protocol !== 'cord-connector' ||
      parseConnectorEndpoint(record.endpoint_url) === undefined ||
      !privateChats.computerSupports(record)
    )
      throw new ThreadServiceError('private_unsupported');
    if (await this.options.store.isPrivate(userId, agentId)) return;
    await this.options.store.setPrivate(userId, agentId);
    this.options.log?.info(
      { event: 'thread_made_private', agent_id: agentId },
      'thread_made_private',
    );
  }

  /** A sealed message from the phone into a private chat. Deduped by client id. */
  async sendSealed(
    userId: string,
    agentId: string,
    input: {
      clientId: string;
      sealed: SealedEnvelopeV1;
      replyTo?: string;
      attachmentIds?: string[];
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    const key = keyOf(userId, agentId);
    const prior = this.sendLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.sendLocks.set(key, current);
    await prior;
    try {
      const record = await this.options.agents.get(userId, agentId);
      if (!record) throw new ThreadServiceError('agent_not_found');
      if (!(await this.options.store.isPrivate(userId, agentId)))
        throw new ThreadServiceError('not_private');
      // In order: a message goes straight out only when nothing of this chat is still waiting.
      const waiting = (await this.options.store.queuedSealed()).some(
        (entry) => entry.userId === userId && entry.agentId === agentId,
      );
      const online = !waiting && this.options.privateChats?.computerSupports(record) === true;
      // Files go only to a computer that can open them: otherwise the message fails, never
      // delivered with its files dropped (ADR-045). Offline, it waits and is checked on return.
      const files = input.attachmentIds !== undefined && input.attachmentIds.length > 0;
      const cannotOpen =
        online &&
        files &&
        this.options.privateChats?.computerHas?.(record, SEALED_FILES_FEATURE) !== true;
      const ready = online && !cannotOpen;
      let result: { message: ThreadMessage; created: boolean };
      try {
        result = await this.options.store.appendSealedMessage(userId, agentId, {
          author: 'user',
          sealed: input.sealed,
          clientId: input.clientId,
          status: cannotOpen ? 'failed' : ready ? 'sent' : 'queued',
          ...(cannotOpen && { errorCode: 'computer_update' }),
          ...(input.attachmentIds !== undefined && { attachmentIds: input.attachmentIds }),
          ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
        });
      } catch (error) {
        if (error instanceof FileStoreError && error.code === 'bad_attachment')
          throw new ThreadServiceError('bad_attachment');
        if (error instanceof ThreadStoreError && error.code === 'queue_full')
          throw new ThreadServiceError('queue_full');
        if (error instanceof ThreadStoreError && error.code === 'reply_to_not_found')
          throw new ThreadServiceError('reply_to_not_found');
        throw error;
      }
      if (!result.created) return result;
      if (ready && !this.options.privateChats?.deliver(record, result.message.id, input.sealed)) {
        // The computer went away between the check and the send: it waits for the next sweep.
        const queued = await this.options.store.updateUserMessage(userId, result.message.id, {
          status: 'queued',
        });
        if (queued) result = { message: queued, created: true };
      }
      if (result.message.kind === 'sealed' && result.message.status === 'sent')
        this.watchTurn(record, result.message.id);
      this.upsert(userId, result.message);
      this.options.log?.info(
        {
          event: 'thread_sealed_received',
          agent_id: agentId,
          message_id: result.message.id,
          keys: input.sealed.keys.length,
          length: input.sealed.body.length,
          files: input.attachmentIds?.length ?? 0,
          status: result.message.kind === 'sealed' ? result.message.status : undefined,
        },
        'thread_sealed_received',
      );
      return result;
    } finally {
      if (this.sendLocks.get(key) === current) this.sendLocks.delete(key);
      release();
    }
  }

  /** A sealed frame from a computer (ADR-044): a reply chunk or an approval request. */
  async receiveSealed(
    from: { connectorId: string; userId: string },
    frame:
      | {
          type: 'sealed.reply';
          agent: string;
          turn_id: string;
          sealed: SealedEnvelopeV1;
          final: boolean;
          file_ids?: string[];
        }
      | {
          type: 'sealed.approval';
          agent: string;
          turn_id: string;
          sealed: SealedEnvelopeV1;
          expires_at: string;
        }
      | { type: 'sealed.working'; agent: string; turn_id: string },
  ): Promise<void> {
    switch (frame.type) {
      case 'sealed.reply':
        return this.receiveSealedReply(from, frame);
      case 'sealed.working':
        return this.receiveSealedWorking(from, frame);
      case 'sealed.approval':
        return this.receiveSealedApproval(from, frame);
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /**
   * The private turn `turn_id` of the sending computer's account, in a private chat with an agent
   * on that same computer; undefined (and rejected) otherwise.
   */
  private async sealedTurn(
    from: { connectorId: string; userId: string },
    frame: { agent: string; turn_id: string },
    reject: (reason: string) => void,
  ): Promise<
    | { agentId: string; record: AgentRecord; message: Extract<ThreadMessage, { kind: 'sealed' }> }
    | undefined
  > {
    const found = await this.options.store.findMessageForUser(from.userId, frame.turn_id);
    if (found?.message.kind !== 'sealed' || found.message.author !== 'user') {
      reject('unknown_turn');
      return undefined;
    }
    const { agentId } = found;
    const record = await this.options.agents.get(from.userId, agentId);
    const endpoint =
      record?.protocol === 'cord-connector'
        ? parseConnectorEndpoint(record.endpoint_url)
        : undefined;
    if (
      !record ||
      record.user_id !== from.userId ||
      endpoint?.connectorId !== from.connectorId ||
      endpoint.localAgent !== frame.agent
    ) {
      reject('wrong_computer');
      return undefined;
    }
    if (!(await this.options.store.isPrivate(from.userId, agentId))) {
      reject('not_private');
      return undefined;
    }
    return { agentId, record, message: found.message };
  }

  /**
   * A computer's content-free "still working" frame (ADR-045). Checked like a reply; it refreshes
   * the turn's silence clock and revives an interrupted turn to working. Nothing else is written.
   */
  private async receiveSealedWorking(
    from: { connectorId: string; userId: string },
    frame: { agent: string; turn_id: string },
  ): Promise<void> {
    const reject = (reason: string) => {
      this.sealedRepliesRejected++;
      this.options.log?.warn(
        { event: 'e2e_working_rejected', connector_id: from.connectorId, reason },
        'e2e_working_rejected',
      );
    };
    const turn = await this.sealedTurn(from, frame, reject);
    if (turn === undefined) return;
    let status = turn.message.status;
    if (status === 'interrupted') {
      const revived = await this.options.store.updateUserMessage(from.userId, frame.turn_id, {
        status: 'working',
        from: ['interrupted'],
      });
      if (revived) {
        this.upsert(from.userId, revived);
        status = 'working';
      }
    }
    if (status === 'sent' || status === 'working')
      this.idle.touch(frame.turn_id, from.userId, turn.agentId);
  }

  /**
   * A computer's sealed approval request (C3 #11). Stored as an opaque sealed message the phone
   * opens into an approval card; the server keeps only that it is pending and when it expires, and
   * pushes the fixed private text, never the title.
   */
  async receiveSealedApproval(
    from: { connectorId: string; userId: string },
    frame: { agent: string; turn_id: string; sealed: SealedEnvelopeV1; expires_at: string },
  ): Promise<void> {
    const reject = (reason: string) => {
      this.sealedRepliesRejected++;
      this.options.log?.warn(
        { event: 'e2e_approval_rejected', connector_id: from.connectorId, reason },
        'e2e_approval_rejected',
      );
    };
    // Never held longer than a plain approval card (a minute of clock skew allowed).
    if (!(Date.parse(frame.expires_at) <= Date.now() + APPROVAL_HOLD_MS + 60_000))
      return reject('bad_expiry');
    const turn = await this.sealedTurn(from, frame, reject);
    if (turn === undefined) return;
    const saved = await this.options.store.appendSealedMessage(from.userId, turn.agentId, {
      author: 'agent',
      sealed: frame.sealed,
      approvalExpiresAt: frame.expires_at,
    });
    this.upsert(from.userId, saved.message);
    this.options.log?.info(
      {
        event: 'thread_sealed_approval',
        agent_id: turn.agentId,
        message_id: saved.message.id,
        turn_id: frame.turn_id,
      },
      'thread_sealed_approval',
    );
    void this.notifySealedReply(from.userId, turn.agentId, turn.record.name, saved.message);
  }

  /**
   * The phone's sealed answer to a sealed approval (C3 #11), relayed unchanged to the computer,
   * which alone opens and checks it. The server marks the request answered, never how.
   */
  async decideSealedApproval(
    userId: string,
    agentId: string,
    messageId: string,
    sealed: SealedEnvelopeV1,
  ): Promise<ThreadMessage> {
    const record = await this.options.agents.get(userId, agentId);
    if (!record) throw new ThreadServiceError('approval_not_found');
    const found = await this.options.store.findMessageForUser(userId, messageId);
    const current = found?.agentId === agentId ? found.message : undefined;
    if (current?.kind !== 'sealed' || current.approval === undefined)
      throw new ThreadServiceError('approval_not_found');
    if (
      current.approval.state !== 'pending' ||
      Date.parse(current.approval.expires_at) <= Date.now()
    )
      throw new ThreadServiceError('approval_conflict', current);
    if (!this.options.privateChats?.deliverDecision(record, messageId, sealed))
      throw new ThreadServiceError('computer_offline');
    const updated = await this.options.store.answerSealedApproval(userId, agentId, messageId);
    if (updated === undefined) throw new ThreadServiceError('approval_not_found');
    if (updated === 'answered') throw new ThreadServiceError('approval_conflict', current);
    this.upsert(userId, updated);
    this.options.log?.info(
      { event: 'thread_sealed_decision', agent_id: agentId, message_id: messageId },
      'thread_sealed_decision',
    );
    return updated;
  }

  /**
   * A computer's sealed reply (ADR-044). Kept only when `turn_id` names a sealed message of the
   * computer's own account, in a private chat with an agent on that same computer; anything else
   * is dropped and counted. The user message moves sent, working, answered as for text.
   */
  async receiveSealedReply(
    from: { connectorId: string; userId: string },
    frame: {
      agent: string;
      turn_id: string;
      sealed: SealedEnvelopeV1;
      final: boolean;
      file_ids?: string[];
    },
  ): Promise<void> {
    const reject = (reason: string) => {
      this.sealedRepliesRejected++;
      this.options.log?.warn(
        { event: 'e2e_reply_rejected', connector_id: from.connectorId, reason },
        'e2e_reply_rejected',
      );
    };
    if (!/^msg_[a-z2-7]{20}$/.test(frame.turn_id)) return reject('bad_turn');
    if (frame.sealed.chunk !== undefined && frame.sealed.chunk.final !== frame.final)
      return reject('bad_chunk');
    const turn = await this.sealedTurn(from, frame, reject);
    if (turn === undefined) return;
    const { agentId, record } = turn;
    const found = { message: turn.message };
    let saved;
    try {
      saved = await this.options.store.upsertSealedReply(from.userId, agentId, {
        turnId: frame.turn_id,
        sealed: frame.sealed,
        final: frame.final,
        ...(frame.file_ids !== undefined && { fileIds: frame.file_ids }),
      });
    } catch (error) {
      // A file that is not this computer's sealed upload: the whole reply is dropped.
      if (error instanceof FileStoreError && error.code === 'bad_attachment')
        return reject('bad_attachment');
      throw error;
    }
    // A chunk resent after a reconnect is already stored: nothing changed, nothing to count.
    if (saved === 'duplicate') return;
    if (saved === 'after_final' || saved === 'too_large') return reject(saved);
    // Only a complete reply ends the silence clock: a final chunk that beat a missing one keeps it
    // running, so the turn is interrupted if that chunk never comes.
    if (saved.complete) this.idle.end(frame.turn_id);
    else if (
      this.idle.tracks(frame.turn_id) ||
      this.options.privateChats?.computerHas?.(record, SEALED_WORKING_FEATURE) === true
    )
      this.idle.touch(frame.turn_id, from.userId, agentId);
    this.upsert(from.userId, saved.message);
    const status = saved.complete ? 'answered' : 'working';
    const current = found.message.status;
    if (current !== status && current !== 'answered' && current !== 'stopped') {
      // Never over a Stop or an answer that landed since the turn was read.
      const changed = await this.options.store.updateUserMessage(from.userId, frame.turn_id, {
        status,
        from: ['queued', 'sent', 'working', 'interrupted', 'expired', 'failed'],
      });
      if (changed) this.upsert(from.userId, changed);
    }
    this.options.log?.info(
      {
        event: 'thread_sealed_reply',
        agent_id: agentId,
        message_id: saved.message.id,
        final: frame.final,
        chunk: frame.sealed.chunk?.index ?? 0,
        length: frame.sealed.body.length,
      },
      'thread_sealed_reply',
    );
    if (saved.complete)
      void this.notifySealedReply(from.userId, agentId, record.name, saved.message);
  }

  /** Sends sealed messages that waited for their computer, oldest first, in order per chat. */
  private async deliverQueuedSealed(): Promise<void> {
    const privateChats = this.options.privateChats;
    if (!privateChats) return;
    const blocked = new Set<string>();
    for (const { userId, agentId, message } of await this.options.store.queuedSealed()) {
      const key = keyOf(userId, agentId);
      if (blocked.has(key) || message.kind !== 'sealed') continue;
      const record = await this.options.agents.get(userId, agentId);
      if (!record || !privateChats.computerSupports(record) || !message.sealed[0]) {
        blocked.add(key);
        continue;
      }
      if (
        privateChats.computerHas?.(record, SEALED_FILES_FEATURE) !== true &&
        this.options.store.hasSealedFiles(userId, message.id)
      ) {
        // The computer came back without the word: its files can't be opened, so the message
        // fails here and is never delivered with them dropped (ADR-045).
        const failed = await this.options.store.updateUserMessage(userId, message.id, {
          status: 'failed',
          errorCode: 'computer_update',
          from: ['queued'],
        });
        if (failed) this.upsert(userId, failed);
        continue;
      }
      // Marked sent before it goes out, and only while still queued: a Stop (or expiry) that
      // landed since the queue was read wins, and the message is never delivered.
      const sent = await this.options.store.updateUserMessage(userId, message.id, {
        status: 'sent',
        from: ['queued'],
      });
      if (!sent) continue;
      if (!privateChats.deliver(record, message.id, message.sealed[0])) {
        const back = await this.options.store.updateUserMessage(userId, message.id, {
          status: 'queued',
          from: ['sent'],
        });
        if (back) this.upsert(userId, back);
        blocked.add(key);
        continue;
      }
      this.watchTurn(record, message.id);
      this.upsert(userId, sent);
    }
  }

  /** Starts the silence clock for a delivered private turn, only for a computer that says it works (ADR-045). */
  private watchTurn(record: AgentRecord, turnId: string): void {
    if (this.options.privateChats?.computerHas?.(record, SEALED_WORKING_FEATURE) === true)
      this.idle.touch(turnId, record.user_id, record.id);
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } catch (error) {
      // Called from timers and finally hooks: it must never reject.
      this.options.log?.warn(
        { event: 'thread_sweep_failed', error: error instanceof Error ? error.name : 'unknown' },
        'thread_sweep_failed',
      );
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(): Promise<void> {
    {
      const queued = await this.options.store.queuedAgents();
      const owners = new Map<string, string>();
      for (const { userId, agentId } of queued)
        for (const message of await this.options.store.queuedMessages(userId, agentId))
          owners.set(message.id, userId);
      for (const { userId, message } of await this.options.store.queuedSealed())
        owners.set(message.id, userId);
      for (const message of await this.options.store.expireQueued()) {
        const owner = owners.get(message.id);
        if (owner) this.upsert(owner, message);
      }
      for (const { userId, agentId } of await this.options.store.queuedAgents()) {
        try {
          const record = await this.options.agents.get(userId, agentId);
          if (
            !record ||
            record.protocol === 'mcp-app' ||
            !(await this.canStart(userId, agentId, record, true))
          )
            continue;
          const [oldest] = await this.options.store.queuedMessages(userId, agentId);
          if (oldest) this.launch(userId, agentId, record, oldest);
        } catch {
          // One agent's failure must not starve the others; it is retried on the next sweep.
        }
      }
      await this.deliverQueuedSealed();
      for (const { userId, turnId } of this.idle.stale()) {
        // Only a live turn: an answer or a Stop that landed since keeps its status.
        const changed = await this.options.store.updateUserMessage(userId, turnId, {
          status: 'interrupted',
          from: ['sent', 'working'],
        });
        if (!changed) continue;
        this.upsert(userId, changed);
        this.options.log?.info(
          { event: 'private_turn_idle', message_id: turnId },
          'private_turn_idle',
        );
      }
      await this.interruptStale();
    }
  }

  /**
   * An AI app never runs a turn here, so an owner message an older gateway stored as `sent` was
   * delivered to its mailbox: it becomes answered (Sent) before a restart interrupts in-flight turns.
   */
  private async settleAppMessages(): Promise<void> {
    const all = new Date(Date.now() + 60_000).toISOString();
    for (const { userId, agentId, message } of await this.options.store.staleInFlight(all)) {
      const protocol = await this.options.agents
        .get(userId, agentId)
        .then((record) => record?.protocol)
        .catch(() => undefined);
      if (protocol !== 'mcp-app') continue;
      const changed = await this.options.store.updateUserMessage(userId, message.id, {
        status: 'answered',
        from: ['sent', 'working'],
      });
      if (changed) this.upsert(userId, changed);
    }
  }

  /**
   * Lease expiry for plain turns: one still `sent` or `working` past the total turn cap plus a
   * margin, with no live run here, lost its run (a crash, a failed write). It becomes interrupted.
   */
  private async interruptStale(): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now - this.timeouts.totalMs - STALE_TURN_MARGIN_MS).toISOString();
    const live = new Set([...this.running.values()].map((run) => run.messageId));
    for (const { userId, agentId, message } of await this.options.store.staleInFlight(cutoff)) {
      if (live.has(message.id)) continue;
      const protocol = await this.options.agents
        .get(userId, agentId)
        .then((record) => record?.protocol)
        .catch(() => undefined);
      // An AI app never runs a turn here: an old row stored as sent was delivered to its mailbox,
      // so it shows Sent (answered), not Interrupted. An answer or a Stop that landed since keeps
      // its status.
      const changed = await this.options.store.updateUserMessage(userId, message.id, {
        status: protocol === 'mcp-app' ? 'answered' : 'interrupted',
        from: ['sent', 'working'],
      });
      if (!changed) continue;
      this.upsert(userId, changed);
      this.options.log?.info(
        {
          event: 'thread_turn_stale',
          message_id: message.id,
          agent_id: agentId,
          protocol: protocol ?? 'unknown',
          age_ms: now - Date.parse(message.updated_at),
        },
        'thread_turn_stale',
      );
    }
  }

  async deleteAgent(userId: string, agentId: string): Promise<number> {
    this.discard(userId, agentId);
    const result = await this.options.store.deleteThread(userId, agentId);
    await this.options.files?.deleteBlobs(result.fileIds);
    return result.messages;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    for (const [key, run] of this.running) if (key.startsWith(`${userId}\0`)) this.discardRun(run);
    const result = await this.options.store.deleteAllForUser(userId);
    await this.options.files?.deleteBlobs(result.fileIds);
    return result.messages;
  }

  /**
   * Deletes one message from Twring only; the agent is never told and may still remember it.
   * Idempotent: a message that is already gone (or never was in this thread) is a success.
   */
  async deleteMessage(userId: string, agentId: string, messageId: string): Promise<void> {
    const deleted = await this.options.store.deleteMessage(userId, agentId, messageId);
    if (deleted.result === 'in_progress') throw new ThreadServiceError('message_in_progress');
    if (deleted.result === 'missing') return;
    await this.options.files?.deleteBlobs(deleted.fileIds);
    this.options.notify(userId, {
      type: 'message.deleted',
      agent_id: agentId,
      message_id: messageId,
    });
    this.options.log?.info(
      {
        event: 'thread_message_deleted',
        agent_id: agentId,
        message_id: messageId,
        files: deleted.fileIds.length,
      },
      'thread_message_deleted',
    );
  }

  async clear(userId: string, agentId: string): Promise<number> {
    this.discard(userId, agentId);
    const result = await this.options.store.clearThread(userId, agentId);
    await this.options.files?.deleteBlobs(result.fileIds);
    this.options.notify(userId, { type: 'thread.cleared', agent_id: agentId });
    return result.messages;
  }

  private discard(userId: string, agentId: string): void {
    const run = this.running.get(keyOf(userId, agentId));
    if (run) this.discardRun(run);
  }

  private discardRun(run: Running): void {
    run.discarded = true;
    this.cancel(run, 'superseded');
  }

  private async canStart(
    userId: string,
    agentId: string,
    record: AgentRecord,
    ignoreQueued = false,
  ): Promise<boolean> {
    return (
      !this.running.has(keyOf(userId, agentId)) &&
      !this.options.hasLiveCallToAgent(userId, agentId) &&
      this.options.agentStatus(userId, record) === 'online' &&
      (ignoreQueued || (await this.options.store.queuedMessages(userId, agentId)).length === 0)
    );
  }

  private launch(
    userId: string,
    agentId: string,
    record: AgentRecord,
    message: ThreadMessage,
  ): void {
    if (message.kind !== 'user_text') return;
    const key = keyOf(userId, agentId);
    if (this.running.has(key)) return;
    const run: Running = {
      messageId: message.id,
      userId,
      turnId: `turn_${randomUUID()}`,
      controller: new AbortController(),
      stopped: false,
      discarded: false,
      timedOut: false,
      requeued: false,
    };
    this.running.set(key, run);
    void this.run(userId, agentId, record, message, run)
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(key);
        if (!run.requeued) void this.sweep();
      });
  }

  private cancel(run: Running, reason: 'superseded' | 'timeout'): void {
    try {
      if (run.adapter) void run.adapter.cancelTurn?.(run.turnId, reason).catch(() => undefined);
    } catch {
      // An adapter's cancellation is best effort; the abort below still stops Twring's turn.
    }
    run.controller.abort();
  }

  private async run(
    userId: string,
    agentId: string,
    record: AgentRecord,
    message: Extract<ThreadMessage, { kind: 'user_text' }>,
    run: Running,
  ): Promise<void> {
    const started = Date.now();
    let reply = '';
    const fileIds: string[] = [];
    const fileEvents = new Set<string>();
    // Fetches and accepted ids both count: an agent cannot make Twring fetch more than five urls.
    let fileAttempts = 0;
    let fileFailure: string | undefined;
    let cut = false;
    let activity: string | undefined;
    let status: UserMessageStatus = 'failed';
    let errorCode: string | undefined;
    let sent = false;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let lastProgress = 0;
    let progressPending = false;
    const progress = () => {
      if (run.discarded || run.stopped) return;
      const now = Date.now();
      if (now - lastProgress >= 250) {
        clearTimeout(progressTimer);
        progressTimer = undefined;
        progressPending = false;
        lastProgress = now;
        this.options.notify(userId, {
          type: 'turn.progress',
          agent_id: agentId,
          message_id: message.id,
          text: reply,
          ...(activity ? { activity } : {}),
        });
      } else {
        progressPending = true;
        progressTimer ??= setTimeout(progress, 250 - (now - lastProgress));
      }
    };
    const timed = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          run.timedOut = true;
          this.cancel(run, 'timeout');
          reject(new Error('agent_timeout'));
        }, ms);
      });
      const aborted = new Promise<never>((_, reject) => {
        if (run.controller.signal.aborted) reject(new Error('aborted'));
        else
          run.controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
      });
      try {
        return await Promise.race([promise, timeout, aborted]);
      } finally {
        clearTimeout(timer);
      }
    };
    this.options.log?.info(
      { event: 'thread_turn_started', agent_id: agentId, message_id: message.id },
      'thread_turn_started',
    );
    try {
      const updated = await this.options.store.updateUserMessage(userId, message.id, {
        status: 'sent',
        turnId: run.turnId,
      });
      if (updated && !run.discarded) this.upsert(userId, updated);
      // Deleted before its turn began: nothing is left to send.
      if (!updated || run.discarded || run.stopped) return;
      const adapterPromise = this.options.agentFactory(userId, record)(message.id);
      void adapterPromise.then(
        (adapter) => {
          if (run.controller.signal.aborted) void adapter.close().catch(() => undefined);
        },
        () => undefined,
      );
      run.adapter = await timed(adapterPromise, this.timeouts.connectMs);
      await timed(
        run.adapter.connect({ callId: message.id, sessionId: agentId }, run.controller.signal),
        this.timeouts.connectMs,
      );
      if (run.stopped || run.discarded) return;
      const at = new Date().toISOString();
      const attached = message.kind === 'user_text' ? (message.attachments ?? []) : [];
      const links: TurnAttachment[] = this.options.files
        ? attached.map((file) => {
            const url = this.options.files!.signedLink(file.id, new Date(at));
            return {
              ...file,
              url,
              expires_at: new Date(
                Number(new URL(url).searchParams.get('exp')) * 1000,
              ).toISOString(),
            };
          })
        : [];
      const visibleText = [
        message.kind === 'user_text' ? message.text : '',
        ...attached.map(
          (file) =>
            `[Attached: ${file.name} (${fileLabels[file.mime_type]}, ${fileSize(file.size_bytes)})]`,
        ),
      ]
        .filter(Boolean)
        .join('\n');
      // From this point the adapter may have handed the turn to the agent, even if it throws.
      sent = true;
      const stream = run.adapter.sendTurn(
        {
          callId: message.id,
          sessionId: agentId,
          turnId: run.turnId,
          role: 'user',
          text:
            message.kind === 'user_text' && message.voice
              ? `[Voice note, transcribed: some words may be wrong]\n${withQuote(message, visibleText)}`
              : withQuote(message, visibleText),
          ...(links.length && { attachments: links }),
          startedAt: at,
          committedAt: at,
          surface: 'text',
        },
        run.controller.signal,
      );
      const events = stream[Symbol.asyncIterator]();
      const deadline = started + this.timeouts.totalMs;
      let first = true;
      while (true) {
        const next = await timed(
          events.next(),
          Math.min(
            first
              ? this.timeouts.firstEventMs
              : run.approval
                ? this.timeouts.totalMs
                : this.timeouts.idleMs,
            Math.max(0, deadline - Date.now()),
          ),
        );
        if (next.done) break;
        first = false;
        const event = next.value;
        if (event.type === 'file') {
          if (fileEvents.has(event.event_id)) continue;
          fileEvents.add(event.event_id);
          if (fileAttempts >= 5) {
            this.options.log?.warn(
              { event: 'agent_file_rejected', code: 'limit' },
              'agent_file_rejected',
            );
            continue;
          }
          try {
            if (!this.options.files) throw new FetchAgentFileError('blocked');
            if (event.file_id) {
              const file = this.options.store.findFile(userId, event.file_id);
              if (
                !file ||
                file.agentId !== agentId ||
                file.direction !== 'agent' ||
                file.messageId
              ) {
                this.options.log?.warn(
                  { event: 'agent_file_rejected', code: 'bad_attachment' },
                  'agent_file_rejected',
                );
                continue;
              }
              if (fileIds.includes(file.id)) continue;
              fileAttempts++;
              fileIds.push(file.id);
            } else if (event.url) {
              fileAttempts++;
              const fetched = await fetchAgentFile(event.url, run.controller.signal, {
                env: this.options.fileFetchEnv ?? 'production',
              });
              const type = sniffFile(fetched.bytes, fetched.contentType, event.name);
              if (!type) throw new FetchAgentFileError('blocked');
              const saved = await this.options.files.upload({
                userId,
                agentId,
                clientId: `${run.turnId}:${event.event_id}`,
                name: event.name,
                mimeType: type.mimeType,
                bytes: fetched.bytes,
                direction: 'agent',
                ...('width' in type && { width: type.width }),
                ...('height' in type && { height: type.height }),
              });
              if (saved.file.messageId || fileIds.includes(saved.file.id)) continue;
              fileIds.push(saved.file.id);
            }
          } catch (cause) {
            const code =
              cause instanceof FileStoreError
                ? cause.code
                : cause instanceof FetchAgentFileError
                  ? cause.code
                  : 'network';
            this.options.log?.warn({ event: 'agent_file_rejected', code }, 'agent_file_rejected');
            fileFailure ??=
              code === 'storage_full'
                ? "A file couldn't be saved: storage is full."
                : code === 'files_daily_limit'
                  ? "A file couldn't be saved: the daily file limit is reached."
                  : "A file couldn't be saved.";
          }
          continue;
        }
        if (event.type === 'run.started') {
          if (event.new_session === true) await this.noteNewSession(userId, agentId);
          const working = await this.options.store.updateUserMessage(userId, message.id, {
            status: 'working',
          });
          if (working && !run.discarded) this.upsert(userId, working);
        } else if (event.type === 'text.delta') {
          const combined = reply + event.delta;
          if (combined.length > MAX_STORED_AGENT_MESSAGE_CHARS) {
            cut = true;
            const end = MAX_STORED_AGENT_MESSAGE_CHARS;
            const last = combined.charCodeAt(end - 1);
            reply = combined.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
          } else {
            reply = combined;
          }
          progress();
        } else if (event.type === 'tool.start' || event.type === 'activity') {
          const safe = sanitizeRingText(
            event.type === 'activity' ? event.label : (event.display_label ?? ''),
          ).slice(0, MAX_ACTIVITY_LABEL_CHARS);
          activity = safe || undefined;
          progress();
        } else if (event.type === 'tool.end') {
          activity = undefined;
          progress();
        } else if (event.type === 'approval.required') {
          if (run.approval) {
            void run.adapter
              .decideApproval?.(run.turnId, event.approval_id, 'deny')
              .catch(() => undefined);
          } else {
            const expiresAt = new Date(Date.now() + APPROVAL_HOLD_MS).toISOString();
            const approval = await this.options.store.appendMessage(userId, agentId, {
              kind: 'approval',
              approval_id: event.approval_id,
              title: event.title,
              description: event.description,
              status: 'pending',
              expires_at: expiresAt,
            });
            if (run.discarded || run.stopped) {
              void run.adapter
                .decideApproval?.(run.turnId, event.approval_id, 'deny')
                .catch(() => undefined);
              // The card was stored while the turn was ending: never leave it pending.
              const expired = await this.options.store.updateApproval(
                userId,
                agentId,
                approval.id,
                'expired',
              );
              if (expired && !run.discarded) this.upsert(userId, expired);
            } else {
              const timer = setTimeout(
                () => void this.expireApproval(run, agentId),
                APPROVAL_HOLD_MS,
              );
              timer.unref();
              run.approval = { messageId: approval.id, approvalId: event.approval_id, timer };
              this.upsert(userId, approval);
              void this.notifyApproval(userId, agentId, record.name, approval);
            }
          }
        } else if (event.type === 'error') {
          errorCode = event.code;
        } else if (event.type === 'done') {
          status =
            event.status === 'completed' && !errorCode
              ? 'answered'
              : event.status === 'cancelled'
                ? 'stopped'
                : 'failed';
          break;
        }
      }
      if (status === 'failed' && !errorCode) errorCode = 'agent_failed';
    } catch (error) {
      if (run.timedOut) errorCode = 'agent_timeout';
      else if (
        !sent &&
        isAdapterError(error) &&
        (error.code === 'agent_offline' || error.code === 'agent_not_on_computer')
      ) {
        status = 'queued';
        run.requeued = true;
      } else errorCode = isAdapterError(error) ? error.code : 'agent_failed';
    } finally {
      await this.expireApproval(run, agentId);
      clearTimeout(progressTimer);
      if (progressPending && !run.discarded && !run.stopped)
        this.options.notify(userId, {
          type: 'turn.progress',
          agent_id: agentId,
          message_id: message.id,
          text: reply,
          ...(activity ? { activity } : {}),
        });
      if (run.stopped) status = 'stopped';
      else if (run.timedOut) status = 'failed';
      if (!run.discarded) {
        if (fileFailure) {
          const budget = MAX_STORED_AGENT_MESSAGE_CHARS - fileFailure.length - (reply ? 1 : 0);
          if (reply.length > budget) {
            reply = reply.slice(0, budget);
            if (/[\uD800-\uDBFF]/u.test(reply.at(-1) ?? '')) reply = reply.slice(0, -1);
            cut = true;
          }
          reply = reply ? `${reply}\n${fileFailure}` : fileFailure;
        }
        if (reply || fileIds.length) {
          try {
            const saved = await this.options.store.appendMessage(userId, agentId, {
              kind: 'agent_text',
              text: reply,
              turn_id: run.turnId,
              partial: status !== 'answered',
              cut,
              attachmentIds: fileIds,
            });
            this.upsert(userId, saved);
            // The owner may have left the chat while the agent worked: tell them, as for a result.
            if (status === 'answered') void this.notifyReply(userId, agentId, record.name, saved);
          } catch {
            // The reply could not be saved: say so rather than report an answer that is not there.
            if (status === 'answered') {
              status = 'failed';
              errorCode = 'thread_save_failed';
            }
          }
        }
        try {
          const final = await this.options.store.updateUserMessage(userId, message.id, {
            status,
            ...(status === 'failed' ? { errorCode: errorCode ?? 'agent_failed' } : {}),
          });
          if (final) this.upsert(userId, final);
        } catch {
          // Left as is; the next start() marks anything still in flight as interrupted.
        }
      }
      // Bounded: an adapter whose close hangs must not hold this agent's run slot forever.
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        run.adapter?.close().catch(() => undefined),
        new Promise<void>((resolve) => (closeTimer = setTimeout(resolve, ADAPTER_CLOSE_MS))),
      ]);
      clearTimeout(closeTimer);
      this.options.log?.info(
        {
          event: 'thread_turn_finished',
          agent_id: agentId,
          message_id: message.id,
          status,
          ...(errorCode ? { code: errorCode } : {}),
          reply_length: reply.length,
          duration_ms: Date.now() - started,
        },
        'thread_turn_finished',
      );
    }
  }

  private async notifyApproval(
    userId: string,
    agentId: string,
    agentName: string,
    message: ThreadMessage,
  ): Promise<void> {
    const ring = this.options.ring;
    if (!ring || message.kind !== 'approval' || (await this.focused(userId, agentId))) return;
    try {
      const settings = await ring.settings(userId);
      await ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: agentName,
        message_id: message.id,
        preview: (await this.options.store.isPrivate(userId, agentId))
          ? PRIVATE_PUSH_TEXT
          : truncateRingText(sanitizeRingText(`Needs your OK: ${message.title}`), 120),
        silent: ownerUnavailable(settings, ring.nowDate()) ? '1' : '0',
      });
    } catch {
      /* The card remains in the chat. */
    }
  }

  /** A message notification for a typed turn's answer, unless that chat is on screen. Never throws. */
  private async notifyReply(
    userId: string,
    agentId: string,
    agentName: string,
    message: ThreadMessage,
  ): Promise<void> {
    const ring = this.options.ring;
    if (!ring || message.kind !== 'agent_text' || (await this.focused(userId, agentId))) return;
    try {
      const settings = await ring.settings(userId);
      await ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: agentName,
        message_id: message.id,
        preview: (await this.options.store.isPrivate(userId, agentId))
          ? PRIVATE_PUSH_TEXT
          : truncateRingText(sanitizeRingText(message.text.split('\n')[0] ?? ''), 120),
        silent: ownerUnavailable(settings, ring.nowDate()) ? '1' : '0',
      });
    } catch {
      // A notification is a convenience: the reply is already saved in the chat.
    }
  }

  /**
   * A message notification for a private chat's reply: the fixed text only, since the server
   * cannot read the reply and must not hint at it (ADR-044). Never throws.
   */
  private async notifySealedReply(
    userId: string,
    agentId: string,
    agentName: string,
    message: ThreadMessage,
  ): Promise<void> {
    const ring = this.options.ring;
    if (!ring || message.kind !== 'sealed' || (await this.focused(userId, agentId))) return;
    try {
      const settings = await ring.settings(userId);
      await ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: agentName,
        message_id: message.id,
        preview: PRIVATE_PUSH_TEXT,
        silent: ownerUnavailable(settings, ring.nowDate()) ? '1' : '0',
      });
    } catch {
      // A notification is a convenience: the reply is already saved in the chat.
    }
  }

  /** Whether the phone shows this chat, so a push would be redundant. Never throws. */
  private async focused(userId: string, agentId: string): Promise<boolean> {
    try {
      return this.options.confirmFocused
        ? await this.options.confirmFocused(userId, agentId)
        : (this.options.isFocused?.(userId, agentId) ?? false);
    } catch {
      return false;
    }
  }

  private upsert(userId: string, message: ThreadMessage): void {
    this.options.notify(userId, { type: 'message.upserted', message });
  }
}
