import { randomBytes, randomUUID } from 'node:crypto';

import {
  APPROVAL_HOLD_MS,
  base64urlDecode,
  base64urlEncode,
  fileAad,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_QUOTE_CHARS,
  MAX_RELAY_MESSAGE_BYTES,
  MAX_SEALED_APPROVAL_DESCRIPTION_CHARS,
  MAX_SEALED_APPROVAL_TITLE_CHARS,
  MAX_SEALED_REPLY_CHUNKS,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  newFileKey,
  newMessageKey,
  sealFile,
  SCOPED_SESSIONS_FEATURE,
  DEVICES_CHANGED_FEATURE,
  SEALED_CANCEL_FEATURE,
  SEALED_CHAT_FEATURE,
  SEALED_FILES_FEATURE,
  SEALED_WORKING_FEATURE,
  SEALED_WORKING_INTERVAL_MS,
  TEXT_TURN_TAG,
  type RelayConnectorMessage,
  type RelayGatewayMessage,
  type RelaySealedWorking,
  type SealedPayload,
} from '@twring/contracts';

import { LocalAgentError, type LocalAgentAdapter, type LocalAgentEvent } from '../events';
import type { ResultOutbox } from '../outbox';
import { openSealedFiles } from '../sealed-files';
import { cleanName } from '../turn-files';
import { UploadError, uploadFile } from '../upload';
import type { E2eConfig } from './keys';
import {
  openIncoming,
  openIncomingControl,
  ReplayWindow,
  sealOutgoing,
  sealOutgoingControl,
  type SealContext,
} from './sealed';

type SealedMessageFrame = Extract<RelayGatewayMessage, { type: 'sealed.message' }>;
type SealedDecisionFrame = Extract<RelayGatewayMessage, { type: 'sealed.decision' }>;
type SealedCancelFrame = Extract<RelayGatewayMessage, { type: 'sealed.cancel' }>;
type SealedReplyFrame = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;
type SealedApprovalFrame = Extract<RelayConnectorMessage, { type: 'sealed.approval' }>;
type ApprovalEvent = Extract<LocalAgentEvent, { type: 'approval.required' }>;
type AgentFile = Extract<LocalAgentEvent, { type: 'file' }>;

/** An approval sealed to the phone and not answered yet (C3 #11). */
interface PendingApproval {
  agent: string;
  /** The private message whose turn asked. */
  turnId: string;
  /** The agent's own id for it, given back to `adapter.decide`. */
  eventId: string;
  adapter: LocalAgentAdapter;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `apv_` and 26 base32 characters: 130 random bits, made on this computer. */
export function newApprovalId(): string {
  return `apv_${Array.from(randomBytes(26), (b) => BASE32[b & 31]).join('')}`;
}

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function cut(text: string, max: number): string {
  const out = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(out) ? out.slice(0, -1) : out;
}

/**
 * Most UTF-16 units of reply text in one chunk. Even at 6 JSON bytes per unit (escaped control
 * characters) the sealed frame stays under MAX_RELAY_MESSAGE_BYTES; each frame is measured too.
 */
export const CHUNK_CHARS = 8_000;
/** A streamed chunk goes out once this much time passed since the last one. */
export const CHUNK_INTERVAL_MS = 700;
/**
 * Time-based flushes stop at this index; the rest goes out by size only, so a reply stays under
 * the server's MAX_SEALED_REPLY_CHUNKS. The reply cap (MAX_STORED_AGENT_MESSAGE_CHARS) leaves at
 * most 3 size chunks plus the final, with room for relay-size halving.
 */
const TIME_FLUSH_CHUNKS = MAX_SEALED_REPLY_CHUNKS - 8;

export const AGENT_FAILED_TEXT = 'Something went wrong on this computer. Try again.';
export const SIGNED_OUT_TEXT =
  'Claude Code is signed out on this computer. Sign in to Claude Code there, then send your message again.';
export const AGENT_MISSING_TEXT = 'This agent is not on this computer any more.';

/** Messages that did not open, per sender device id per minute, that may cost a write or reply. */
export const UNKNOWN_SENDER_BUDGET = 5;
/** The same across all senders, since a sender id is the sender's own choice. */
export const UNKNOWN_SENDERS_BUDGET = 20;
const BUDGET_WINDOW_MS = 60_000;
const BUDGET_TRACKED_SENDERS = 64;

/**
 * Fixed per-minute budgets for messages that did not open: each may cost a config read and write
 * and a sealed reply (a seq), so a forged flood must not. Memory stays bounded: at most
 * BUDGET_TRACKED_SENDERS senders are tracked; past that, new senders share the overall budget only.
 */
export class FailureBudget {
  private readonly senders = new Map<string, number[]>();
  private all: number[] = [];

  take(sender: string, now: number): boolean {
    const since = now - BUDGET_WINDOW_MS;
    this.all = this.all.filter((t) => t > since);
    if (this.all.length >= UNKNOWN_SENDERS_BUDGET) return false;
    for (const [id, times] of this.senders) {
      const left = times.filter((t) => t > since);
      if (left.length === 0) this.senders.delete(id);
      else this.senders.set(id, left);
    }
    const mine = this.senders.get(sender) ?? [];
    if (mine.length >= UNKNOWN_SENDER_BUDGET) return false;
    if (mine.length === 0 && this.senders.size >= BUDGET_TRACKED_SENDERS) return false;
    this.senders.set(sender, [...mine, now]);
    this.all.push(now);
    return true;
  }
}

/**
 * What this computer says it supports: `sealed_chat` (and `sealed_cancel`, Stop for a private
 * turn, and `devices_changed`, a prompt device sync) only once it trusts a phone.
 */
export function helloFeatures(e2e: E2eConfig | undefined): string[] {
  const phones = e2e?.devices.some((device) => device.kind === 'phone') ?? false;
  return phones
    ? [
        SCOPED_SESSIONS_FEATURE,
        SEALED_CHAT_FEATURE,
        SEALED_CANCEL_FEATURE,
        DEVICES_CHANGED_FEATURE,
        SEALED_WORKING_FEATURE,
        SEALED_FILES_FEATURE,
      ]
    : [SCOPED_SESSIONS_FEATURE];
}

/**
 * The agent's text for a private message, in the format the server's `withQuote` gives plain
 * chats, so an agent reads a quoted reply the same way in both.
 */
export function privateTurnText(payload: SealedPayload): string {
  if (payload.quote === undefined) return payload.text;
  const quoted = payload.quote.text
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MAX_QUOTE_CHARS + 1);
  const whose = payload.quote.from === 'agent' ? 'your' : 'my';
  return `Replying to ${whose} earlier message: "${quoted}"\n\n${payload.text}`;
}

export interface PrivateChatsOptions {
  /** The AAD's account binding: this computer's connector id (see sealed.ts). */
  connectorId: string;
  /** The private chat config as last read or written. */
  e2e: () => E2eConfig | undefined;
  /** Changes and saves it (read fresh first); resolves the saved config. */
  persist: (change: (current: E2eConfig) => E2eConfig) => Promise<E2eConfig | undefined>;
  pool: {
    acquire(agentId: string): LocalAgentAdapter | undefined;
    release(agentId: string): void;
    runExclusive(agentId: string, fn: () => Promise<void>): Promise<void>;
  };
  /** Sends one frame now; false when the link is down. */
  send: (frame: SealedReplyFrame | SealedApprovalFrame | RelaySealedWorking) => boolean;
  /**
   * Whether the connected gateway listed this feature in its ready. The working frame goes only
   * to one that did: an older gateway drops the socket on a frame type it does not know.
   */
  gatewaySupports?: (feature: string) => boolean;
  /**
   * Where this computer reads the sealed files of a private message: the gateway and this
   * computer's token. Without it every file reaches the agent as could not be opened.
   */
  files?: { server: string; token: string; fetch?: typeof fetch };
  outbox: ResultOutbox;
  log?: (line: string) => void;
  signal?: AbortSignal;
  now?: () => number;
  /** Waits between tries to reserve a reply seq; tests pass zeros. */
  seqRetryDelaysMs?: readonly number[];
}

/**
 * Waits between tries to reserve a reply seq when the config is busy or its write failed. They
 * add up to more than LOCK_STALE_MS (store.ts), so a lock left by a killed process is taken over.
 */
export const SEQ_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * Private chat turns on this computer (ADR-044): opens a sealed message from a trusted phone,
 * runs the agent on it exactly once, and streams the answer back sealed. A message that does not
 * open never reaches the agent; the phone gets a sealed "could not open" notice instead. Logs
 * carry ids, counts and reasons only, never text or keys.
 */
export class PrivateChats {
  private seen: ReplayWindow | undefined;
  private readonly failures = new FailureBudget();
  private refused = 0;
  /** Sealed approvals waiting for the phone, by the id inside the sealed request. */
  private readonly approvals = new Map<string, PendingApproval>();
  private ignoredDecisions = 0;
  /** Private turns received and not over yet, by message id, so the phone's Stop can end them. */
  private readonly turns = new Map<string, { agent: string; controller: AbortController }>();

  constructor(private readonly options: PrivateChatsOptions) {}

  private window(e2e: E2eConfig): ReplayWindow {
    this.seen ??= new ReplayWindow(e2e.seen ?? {});
    return this.seen;
  }

  private context(e2e: E2eConfig, agentId: string): SealContext {
    return {
      accountId: this.options.connectorId,
      agentId,
      myDeviceId: e2e.device_id,
      myPublic: e2e.public_key,
      myPrivate: base64urlDecode(e2e.private_key),
      trusted: e2e.devices,
      seen: this.window(e2e),
    };
  }

  async receive(
    frame: SealedMessageFrame | SealedDecisionFrame | SealedCancelFrame,
  ): Promise<void> {
    switch (frame.type) {
      case 'sealed.message': {
        // Kept from the first moment, so a Stop that arrives while this turn waits is not lost.
        const controller = new AbortController();
        this.turns.set(frame.message_id, { agent: frame.agent, controller });
        // Tells the server this turn is alive, also while it waits behind another of this agent.
        // A failed send is dropped, never held: the next beat says the same.
        const beat = setInterval(() => {
          if (controller.signal.aborted) return;
          if (this.options.gatewaySupports?.(SEALED_WORKING_FEATURE) !== true) return;
          this.options.send({
            type: 'sealed.working',
            agent: frame.agent,
            turn_id: frame.message_id,
          });
        }, SEALED_WORKING_INTERVAL_MS);
        beat.unref?.();
        try {
          return await this.receiveMessage(frame, controller.signal);
        } finally {
          clearInterval(beat);
          if (this.turns.get(frame.message_id)?.controller === controller)
            this.turns.delete(frame.message_id);
        }
      }
      case 'sealed.decision':
        return this.receiveDecision(frame);
      case 'sealed.cancel':
        return this.cancel(frame);
      default: {
        const never: never = frame;
        return never;
      }
    }
  }

  /**
   * The phone stopped a private turn (C3 #11). A running turn is aborted and ends with what it
   * has; one still waiting is dropped. Its pending approvals are denied. Unknown turns and other
   * agents' turns are ignored.
   */
  private cancel(frame: SealedCancelFrame): void {
    const turn = this.turns.get(frame.turn_id);
    if (turn === undefined || turn.agent !== frame.agent) {
      this.options.log?.(`private stop for ${frame.turn_id} ignored (unknown turn)`);
      return;
    }
    turn.controller.abort();
    for (const [id, pending] of this.approvals)
      if (pending.turnId === frame.turn_id) this.settle(id, 'deny');
    this.options.log?.(`private turn ${frame.turn_id} stopped`);
  }

  private async receiveMessage(frame: SealedMessageFrame, stopped: AbortSignal): Promise<void> {
    const log = this.options.log;
    let e2e = this.options.e2e();
    if (e2e === undefined) return;
    // The replay window moves only once a reply seq is reserved, so a message this computer
    // could not answer (config busy) still runs when the phone sends it again.
    const defer = { accept: false };
    let opened = openIncoming(this.context(e2e, frame.agent), frame.sealed, defer);
    if (!opened.ok && opened.reason !== 'replay') {
      // Each failure may cost a config write and a reply seq: a flood is dropped quietly.
      const now = (this.options.now ?? Date.now)();
      if (!this.failures.take(frame.sealed.sender_device, now)) {
        if (this.refused++ % 100 === 0)
          log?.(`private messages not opened and dropped: ${this.refused}`);
        return;
      }
    }
    if (!opened.ok && opened.reason === 'unknown_sender') {
      // A phone paired by `private pair` while this copy ran: read the saved list once more.
      e2e = (await this.options.persist((current) => current)) ?? e2e;
      opened = openIncoming(this.context(e2e, frame.agent), frame.sealed, defer);
    }
    if (!opened.ok) {
      log?.(`private message ${frame.message_id} not opened (${opened.reason})`);
      if (opened.reason !== 'replay')
        await this.reply(frame, async (send) => send({ text: '', notice: 'couldnt_open' }, true));
      return;
    }
    const reserved = await this.reserveSeq(frame);
    if (reserved === undefined) return;
    const { sender_device, sender_seq } = frame.sealed;
    // Another delivery of the same message took it while this one waited.
    if (!this.window(e2e).accept(sender_device, sender_seq)) {
      log?.(`private message ${frame.message_id} not opened (replay)`);
      return;
    }
    const highest = this.window(e2e).highest();
    await this.options.persist((current) => ({
      ...current,
      seen: { ...current.seen, ...highest },
    }));
    const payload = opened.payload;
    if (stopped.aborted) return;
    await this.reply(
      frame,
      (send, chunks) => this.runAgent(frame, payload, send, chunks, stopped),
      reserved,
    );
  }

  /**
   * Reserves the next seq for a reply, trying again for longer than a stale lock lives. Undefined
   * when it still failed; that is logged with the message id only.
   */
  private async reserveSeq(frame: SealedMessageFrame): Promise<E2eConfig | undefined> {
    const delays = this.options.seqRetryDelaysMs ?? SEQ_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const saved = await this.options.persist((current) => ({ ...current, seq: current.seq + 1 }));
      if (saved !== undefined) return saved;
      const delay = delays[attempt];
      if (delay === undefined || this.options.signal?.aborted === true) break;
      // Unref'd: a connector that is shutting down exits at once instead of waiting out a retry.
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
    }
    this.options.log?.(`private message ${frame.message_id} not answered (config busy)`);
    return undefined;
  }

  private async runAgent(
    frame: SealedMessageFrame,
    payload: SealedPayload,
    send: (payload: SealedPayload, final: boolean, fileIds?: string[]) => Promise<void>,
    chunks: () => number,
    stopped: AbortSignal,
  ): Promise<void> {
    const { pool } = this.options;
    const adapter = pool.acquire(frame.agent);
    if (adapter === undefined) return send({ text: AGENT_MISSING_TEXT }, true);
    const now = this.options.now ?? Date.now;
    let buffered = '';
    let total = 0;
    let lastSent = now();
    let dropped = false;
    // Files the agent sent: the first MAX_ATTACHMENTS_PER_MESSAGE are kept, the rest only by name.
    const agentFiles: AgentFile[] = [];
    const overflow: string[] = [];
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.options.signal?.addEventListener('abort', stop, { once: true });
    stopped.addEventListener('abort', stop, { once: true });
    let cleanup: (() => Promise<void>) | undefined;
    try {
      await pool.runExclusive(frame.agent, async () => {
        // Stopped while it waited behind another turn of this agent: never run, nothing sent.
        if (stopped.aborted) {
          dropped = true;
          return;
        }
        try {
          const opened = await this.openFiles(frame, payload, controller.signal);
          cleanup = opened?.cleanup;
          if (controller.signal.aborted) return;
          const text = [privateTurnText(payload), ...(opened?.lines ?? [])]
            .filter((part) => part !== '')
            .join('\n');
          for await (const event of adapter.sendTurn(
            `${TEXT_TURN_TAG}\n${text}`,
            controller.signal,
            {
              surface: 'text',
              ...(opened !== undefined && opened.files.length > 0 && { files: opened.files }),
            },
          )) {
            if (controller.signal.aborted) break;
            if (event.type === 'approval.required') {
              await this.askApproval(frame, adapter, event);
              continue;
            }
            if (event.type === 'file') {
              if (agentFiles.length < MAX_ATTACHMENTS_PER_MESSAGE) agentFiles.push(event);
              else overflow.push(event.name);
              continue;
            }
            if (event.type !== 'text') continue;
            const room = MAX_STORED_AGENT_MESSAGE_CHARS - total;
            let text = event.text.slice(0, Math.max(0, room));
            if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
            total += text.length;
            buffered += text;
            const timeUp = now() - lastSent >= CHUNK_INTERVAL_MS && chunks() < TIME_FLUSH_CHUNKS;
            if (buffered.length >= CHUNK_CHARS || timeUp) {
              const out = buffered;
              buffered = '';
              lastSent = now();
              await send({ text: out }, false);
            }
          }
        } catch (error) {
          // An agent that throws on its abort signal was stopped, not broken.
          if (!stopped.aborted) {
            this.options.log?.(`private turn ${frame.message_id} failed`);
            const failed =
              error instanceof LocalAgentError && error.code === 'agent_signed_out'
                ? SIGNED_OUT_TEXT
                : AGENT_FAILED_TEXT;
            buffered += total === 0 ? failed : `\n\n${failed}`;
          }
        } finally {
          // The turn is over: anything still waiting for the phone is denied.
          for (const [id, pending] of this.approvals)
            if (pending.turnId === frame.message_id) this.settle(id, 'deny');
        }
      });
    } finally {
      await cleanup?.();
      pool.release(frame.agent);
    }
    // Stop and shutdown stay wired until the uploads are done.
    let sent: Awaited<ReturnType<typeof this.sealAgentFiles>>;
    try {
      if (dropped) return;
      sent = await this.sealAgentFiles(frame, agentFiles, overflow, controller.signal);
    } finally {
      this.options.signal?.removeEventListener('abort', stop);
      stopped.removeEventListener('abort', stop);
    }
    if (sent.lines.length > 0)
      buffered = [buffered, sent.lines.join('\n')].filter((part) => part !== '').join('\n\n');
    await send(
      { text: buffered, ...(sent.files.length > 0 && { files: sent.files }) },
      true,
      sent.files.length > 0 ? sent.files.map((file) => file.file_id) : undefined,
    );
  }

  /**
   * Seals each file the agent sent with its own key and uploads the blob. A file is listed only
   * once the gateway answered with its id, because a reply that names a file the gateway does
   * not hold is dropped whole. One that cannot be sent becomes a line of text instead. Without
   * `sealed_files` from the gateway the files are dropped. Logs carry counts only.
   */
  private async sealAgentFiles(
    frame: SealedMessageFrame,
    files: readonly AgentFile[],
    overflow: readonly string[],
    signal: AbortSignal,
  ): Promise<{ files: NonNullable<SealedPayload['files']>; lines: string[] }> {
    const none = { files: [], lines: [] };
    const total = files.length + overflow.length;
    if (total === 0 || signal.aborted) return none;
    const target = this.options.files;
    if (target === undefined || this.options.gatewaySupports?.(SEALED_FILES_FEATURE) !== true) {
      this.options.log?.(`e2e_file_dropped: ${total} files in ${frame.message_id}`);
      return none;
    }
    const out: NonNullable<SealedPayload['files']> = [];
    const lines: string[] = [];
    const aad = fileAad({ accountId: this.options.connectorId, agentId: frame.agent });
    for (const file of files) {
      const name = cleanName(file.name);
      if (file.data.byteLength === 0) {
        lines.push(`Could not send ${name}: it is empty.`);
        continue;
      }
      if (file.data.byteLength > MAX_FILE_BYTES) {
        lines.push(`Could not send ${name}: it is larger than 10 MB.`);
        continue;
      }
      try {
        const key = newFileKey();
        const id = await uploadFile({
          server: target.server,
          token: target.token,
          localAgent: frame.agent,
          bytes: sealFile(key, file.data, aad),
          name,
          sealed: true,
          clientId: randomUUID(),
          signal,
          ...(target.fetch !== undefined && { fetch: target.fetch }),
        });
        out.push({
          file_id: id,
          key: base64urlEncode(key),
          name,
          mime: file.mimeType,
          size: file.data.byteLength,
        });
      } catch (error) {
        // Stopped mid-upload: the stopped path sends what it has, no lines for cancelled files.
        if (signal.aborted) return none;
        this.options.log?.(
          `private file in ${frame.message_id} not sent (${error instanceof UploadError ? error.code : 'seal_failed'})`,
        );
        lines.push(`Could not send ${name}.`);
      }
    }
    for (const name of overflow)
      lines.push(
        `Could not send ${cleanName(name)}: at most ${MAX_ATTACHMENTS_PER_MESSAGE} files go in one reply.`,
      );
    if (signal.aborted) return none;
    return { files: out, lines };
  }

  /**
   * Opens the files a private message carries into a temp folder the turn removes. Logs carry
   * counts only. Undefined when the message has no files.
   */
  private async openFiles(frame: SealedMessageFrame, payload: SealedPayload, signal: AbortSignal) {
    const refs = payload.files ?? [];
    if (refs.length === 0) return undefined;
    const target = this.options.files;
    const opened = await openSealedFiles(
      refs,
      {
        accountId: this.options.connectorId,
        agentId: frame.agent,
        // Nothing to download from: every file fails the same way and none is fetched.
        server: target?.server ?? '',
        token: target?.token ?? '',
        signal: target === undefined ? AbortSignal.abort() : signal,
      },
      target?.fetch === undefined ? {} : { fetch: target.fetch },
    );
    this.options.log?.(
      `private message ${frame.message_id}: ${opened.files.length} of ${refs.length} files opened`,
    );
    return opened;
  }

  /**
   * Seals the agent's approval request to every trusted phone (C3 #11) under a fresh seq of its
   * own, never a reply chunk. The server stores it but cannot read the title or description. If
   * it cannot be sent now, it is denied at once.
   */
  private async askApproval(
    frame: SealedMessageFrame,
    adapter: LocalAgentAdapter,
    event: ApprovalEvent,
  ): Promise<void> {
    if (adapter.decide === undefined) return;
    const deny = () => adapter.decide?.(event.id, 'deny');
    const saved = await this.options.persist((current) => ({ ...current, seq: current.seq + 1 }));
    if (saved === undefined) return deny();
    const expiresAt = (this.options.now ?? Date.now)() + APPROVAL_HOLD_MS;
    const id = newApprovalId();
    const expires_at = new Date(expiresAt).toISOString();
    const description =
      event.description === undefined
        ? undefined
        : cut(event.description, MAX_SEALED_APPROVAL_DESCRIPTION_CHARS);
    const out: SealedApprovalFrame = {
      type: 'sealed.approval',
      agent: frame.agent,
      turn_id: frame.message_id,
      sealed: sealOutgoingControl(
        this.context(saved, frame.agent),
        {
          kind: 'approval',
          approval_id: id,
          title: cut(event.title, MAX_SEALED_APPROVAL_TITLE_CHARS),
          ...(description !== undefined && { description }),
          expires_at,
        },
        saved.seq,
      ),
      expires_at,
    };
    if (!this.options.send(out)) {
      this.options.log?.(`private approval in ${frame.message_id} not sent, denied`);
      return deny();
    }
    // Same hold as a plain chat's approval card (APPROVAL_HOLD_MS): no answer in time is a no.
    const timer = setTimeout(() => this.settle(id, 'deny'), APPROVAL_HOLD_MS);
    timer.unref?.();
    this.approvals.set(id, {
      agent: frame.agent,
      turnId: frame.message_id,
      eventId: event.id,
      adapter,
      expiresAt,
      timer,
    });
    this.options.log?.(`private approval ${id} asked in ${frame.message_id}`);
  }

  /** Answers a waiting approval once; a later call for the same id does nothing. */
  private settle(id: string, decision: 'approve' | 'deny'): void {
    const pending = this.approvals.get(id);
    if (pending === undefined) return;
    this.approvals.delete(id);
    clearTimeout(pending.timer);
    pending.adapter.decide?.(pending.eventId, decision);
  }

  /**
   * The phone's sealed answer (C3 #11). Taken only when a trusted phone sealed it, it is not a
   * replay, it names an approval of this agent still waiting, and it has not expired. Anything
   * else is ignored and counted; logs carry ids and counts, never the answer.
   */
  private async receiveDecision(frame: SealedDecisionFrame): Promise<void> {
    const ignore = (reason: string) => {
      this.ignoredDecisions++;
      this.options.log?.(
        `private approval answer ${frame.message_id} ignored (${reason}), ${this.ignoredDecisions} so far`,
      );
    };
    const e2e = this.options.e2e();
    if (e2e === undefined) return ignore('no_keys');
    const opened = openIncomingControl(this.context(e2e, frame.agent), frame.sealed);
    if (!opened.ok) return ignore(opened.reason);
    const highest = this.window(e2e).highest();
    await this.options.persist((current) => ({
      ...current,
      seen: { ...current.seen, ...highest },
    }));
    if (opened.sender.kind !== 'phone') return ignore('not_a_phone');
    const payload = opened.payload;
    switch (payload.kind) {
      case 'approval':
      case 'trust_add':
        return ignore('not_a_decision');
      case 'approval_decision': {
        const pending = this.approvals.get(payload.approval_id);
        if (pending === undefined || pending.agent !== frame.agent) return ignore('unknown');
        if ((this.options.now ?? Date.now)() >= pending.expiresAt) {
          this.settle(payload.approval_id, 'deny');
          return ignore('expired');
        }
        this.settle(payload.approval_id, payload.decision);
        this.options.log?.(`private approval ${payload.approval_id} answered`);
        return;
      }
      default: {
        const never: never = payload;
        return never;
      }
    }
  }

  /**
   * One reply to `frame`: every chunk shares one fresh seq (persisted before use) and gets the
   * next chunk index. Once a send fails, the rest is held and goes out after the next reconnect,
   * in order, so the final chunk reaches the server once.
   *
   * Every chunk is sealed with one message key, so a phone approved later gets the whole reply
   * from one re-wrap (ADR-044). Each piece wraps to the devices trusted now: a device removed
   * while the agent answers gets none of the pieces sealed after the sync that dropped it
   * (C3 #11 P4a), and those pieces get a new key it never held (ADR-045 notes the exception).
   */
  private async reply(
    frame: SealedMessageFrame,
    body: (
      send: (payload: SealedPayload, final: boolean, fileIds?: string[]) => Promise<void>,
      chunks: () => number,
    ) => Promise<void>,
    reserved?: E2eConfig,
  ): Promise<void> {
    const saved = reserved ?? (await this.reserveSeq(frame));
    if (saved === undefined) return;
    const seq = saved.seq;
    const ctx = this.context(saved, frame.agent);
    const current = (): SealContext => ({
      ...ctx,
      trusted: this.options.e2e()?.devices ?? ctx.trusted,
    });
    let key = newMessageKey();
    // Every device this key was wrapped to so far.
    const holders = new Set<string>();
    const keyFor = (trusted: readonly { id: string }[]): Uint8Array => {
      const ids = new Set(trusted.map((device) => device.id));
      if ([...holders].some((id) => !ids.has(id))) {
        key = newMessageKey();
        holders.clear();
      }
      for (const id of ids) holders.add(id);
      return key;
    };
    let index = 0;
    const held: SealedReplyFrame[] = [];
    const push = (out: SealedReplyFrame) => {
      if (held.length > 0 || !this.options.send(out)) held.push(out);
    };
    // Files ride the final piece only, in its payload and as `file_ids` on its frame.
    const seal = (payload: SealedPayload, final: boolean, fileIds?: string[]) => {
      const pieces = splitText(payload.text, CHUNK_CHARS);
      pieces.forEach((text, i) => {
        const last = final && i === pieces.length - 1;
        sealPiece(
          last ? { ...payload, text } : { ...withoutFiles(payload), text },
          last,
          last ? fileIds : undefined,
        );
      });
    };
    const sealPiece = (payload: SealedPayload, final: boolean, fileIds?: string[]): void => {
      const now = current();
      const out: SealedReplyFrame = {
        type: 'sealed.reply',
        agent: frame.agent,
        turn_id: frame.message_id,
        sealed: sealOutgoing(now, payload, seq, { index, final }, keyFor(now.trusted)),
        final,
        ...(fileIds !== undefined && fileIds.length > 0 && { file_ids: fileIds }),
      };
      if (
        Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_RELAY_MESSAGE_BYTES &&
        payload.text.length > 1
      ) {
        const [a, b] = splitText(payload.text, Math.ceil(payload.text.length / 2));
        sealPiece({ ...withoutFiles(payload), text: a! }, false);
        sealPiece({ ...payload, text: b ?? '' }, final, fileIds);
        return;
      }
      index++;
      push(out);
    };
    await body(
      (payload, final, fileIds) => {
        seal(payload, final, fileIds);
        return Promise.resolve();
      },
      () => index,
    );
    this.options.log?.(
      `private reply to ${frame.message_id}: ${index} parts${held.length > 0 ? `, ${held.length} held` : ''}`,
    );
    if (held.length === 0) return;
    const deliver = () => {
      while (held.length > 0) {
        if (!this.options.send(held[0]!)) return Promise.resolve('retry' as const);
        held.shift();
      }
      return Promise.resolve('delivered' as const);
    };
    this.options.outbox.hold(`sealed:${frame.message_id}`, deliver);
    // The link may already be back (it came back while the agent was still answering).
    void this.options.outbox.flush();
  }
}

function withoutFiles(payload: SealedPayload): SealedPayload {
  const rest = { ...payload };
  delete rest.files;
  return rest;
}

/** Pieces of at most `size` UTF-16 units, never splitting a surrogate pair; at least one piece. */
export function splitText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (text.length - start > size) {
    let end = start + size;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    pieces.push(text.slice(start, end));
    start = end;
  }
  pieces.push(text.slice(start));
  return pieces;
}
