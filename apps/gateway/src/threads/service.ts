import { randomUUID } from 'node:crypto';

import { isAdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import {
  APPROVAL_HOLD_MS,
  MAX_ACTIVITY_LABEL_CHARS,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  sanitizeRingText,
  truncateRingText,
  userRef,
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

export interface ThreadTurnTimeouts {
  connectMs: number;
  firstEventMs: number;
  idleMs: number;
  totalMs: number;
}
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
  notify(userId: string, frame: ThreadSocketFrame): void;
  log?: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
  };
  timeouts?: Partial<ThreadTurnTimeouts>;
  sweepIntervalMs?: number;
}
export class ThreadServiceError extends Error {
  constructor(
    readonly code:
      | 'agent_not_found'
      | 'queue_full'
      | 'bad_attachment'
      | 'approval_conflict'
      | 'approval_not_found',
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

export class ThreadService {
  private readonly running = new Map<string, Running>();
  private readonly newSessionNotices = new Map<string, number>();
  private readonly sendLocks = new Map<string, Promise<void>>();
  private readonly timeouts: ThreadTurnTimeouts;
  private timer?: ReturnType<typeof setInterval>;
  private starting?: Promise<void>;
  private epoch = 0;
  private sweeping = false;

  constructor(private readonly options: ThreadServiceOptions) {
    this.timeouts = { ...THREAD_TURN_TIMEOUTS, ...options.timeouts };
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
    let delivery: 'ring' | 'push' | 'none' = 'none';
    if (!this.options.hasLiveCallToAgent(userId, agentId) && this.options.ring) {
      const settings = await this.options.ring.settings(userId);
      if (
        input.origin === 'call_turn' &&
        input.text.trim() !== '' &&
        (settings.after_call_result ?? 'ring') === 'ring'
      ) {
        const clean = input.text
          .replace(/⟪[^⟫]*⟫/gu, '')
          .replace(/\s+/gu, ' ')
          .replace(/\s+([.!?])/gu, '$1')
          .trim();
        const end = /[.!?](?= |$)/u.exec(clean);
        const reason = truncateRingText(
          sanitizeRingText(end ? clean.slice(0, end.index + 1) : clean),
          140,
        );
        const result = await this.options.ring.ring({
          userId,
          agentId,
          ...(input.target.connectorId !== undefined && { connectorId: input.target.connectorId }),
          ...(input.target.localAgent !== undefined && { localAgent: input.target.localAgent }),
          agentName: input.target.agentName,
          reason,
          messageId,
          ...(input.sessionRef && { sessionRef: input.sessionRef }),
        });
        if ('invite' in result) delivery = 'ring';
      }
      if (delivery === 'none' && !this.options.isFocused?.(userId, agentId)) {
        const attempted = await this.options.ring.pushMessage(userId, {
          type: 'cord.message',
          user_ref: userRef(userId),
          agent_id: agentId,
          agent_name: input.target.agentName,
          message_id: messageId,
          preview: truncateRingText(sanitizeRingText(input.text.split('\n')[0] ?? ''), 120),
          silent: ownerUnavailable(settings, this.options.ring.nowDate()) ? '1' : '0',
        });
        if (attempted > 0) delivery = 'push';
      }
    }
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

  async recordRing(invite: {
    user_id: string;
    agent_id: string;
    id: string;
    reason: string;
    status: 'answered' | 'declined' | 'missed' | 'cancelled';
    note?: string;
  }): Promise<void> {
    const message = await this.options.store.appendMessage(invite.user_id, invite.agent_id, {
      kind: 'ring',
      invite_id: invite.id,
      reason: invite.reason,
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
      this.options.isFocused?.(invite.user_id, invite.agent_id)
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
      preview: truncateRingText(sanitizeRingText(result.text.split('\n')[0] ?? ''), 120),
      silent: ownerUnavailable(settings, this.options.ring.nowDate()) ? '1' : '0',
    });
  }

  start(): Promise<void> {
    if (this.timer) return Promise.resolve();
    // Concurrent starts share one run; a stop() in between cancels it (epoch), so no interval leaks.
    this.starting ??= (async () => {
      const epoch = this.epoch;
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

  async decideApproval(
    userId: string,
    agentId: string,
    messageId: string,
    decision: 'approve' | 'deny',
  ): Promise<ThreadMessage> {
    const current = await this.options.store.findMessageById(userId, agentId, messageId);
    if (current?.kind !== 'approval') throw new ThreadServiceError('approval_not_found');
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
    },
  ): Promise<{ message: ThreadMessage; created: boolean }> {
    const record = await this.options.agents.get(userId, agentId);
    if (!record) throw new ThreadServiceError('agent_not_found');
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
        status: mcpApp || ready ? 'sent' : 'queued',
      });
    } catch (error) {
      if (error instanceof ThreadStoreError && error.code === 'queue_full')
        throw new ThreadServiceError('queue_full');
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
      if (run.discarded || run.stopped) return;
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
              ? `[Voice note, transcribed: some words may be wrong]\n${visibleText}`
              : visibleText,
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
    if (!ring || message.kind !== 'approval' || this.options.isFocused?.(userId, agentId)) return;
    try {
      const settings = await ring.settings(userId);
      await ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: agentName,
        message_id: message.id,
        preview: truncateRingText(sanitizeRingText(`Needs your OK: ${message.title}`), 120),
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
    if (!ring || message.kind !== 'agent_text' || this.options.isFocused?.(userId, agentId)) return;
    try {
      const settings = await ring.settings(userId);
      await ring.pushMessage(userId, {
        type: 'cord.message',
        user_ref: userRef(userId),
        agent_id: agentId,
        agent_name: agentName,
        message_id: message.id,
        preview: truncateRingText(sanitizeRingText(message.text.split('\n')[0] ?? ''), 120),
        silent: ownerUnavailable(settings, ring.nowDate()) ? '1' : '0',
      });
    } catch {
      // A notification is a convenience: the reply is already saved in the chat.
    }
  }

  private upsert(userId: string, message: ThreadMessage): void {
    this.options.notify(userId, { type: 'message.upserted', message });
  }
}
