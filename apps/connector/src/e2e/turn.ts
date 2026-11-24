import {
  base64urlDecode,
  MAX_QUOTE_CHARS,
  MAX_RELAY_MESSAGE_BYTES,
  MAX_STORED_AGENT_MESSAGE_CHARS,
  SCOPED_SESSIONS_FEATURE,
  SEALED_CHAT_FEATURE,
  TEXT_TURN_TAG,
  type RelayConnectorMessage,
  type RelayGatewayMessage,
  type SealedPayload,
} from '@twring/contracts';

import type { LocalAgentAdapter } from '../events';
import type { ResultOutbox } from '../outbox';
import type { E2eConfig } from './keys';
import { openIncoming, ReplayWindow, sealOutgoing, type SealContext } from './sealed';

type SealedMessageFrame = Extract<RelayGatewayMessage, { type: 'sealed.message' }>;
type SealedReplyFrame = Extract<RelayConnectorMessage, { type: 'sealed.reply' }>;

/**
 * Most UTF-16 units of reply text in one chunk. Even at 6 JSON bytes per unit (escaped control
 * characters) the sealed frame stays under MAX_RELAY_MESSAGE_BYTES; each frame is measured too.
 */
export const CHUNK_CHARS = 8_000;
/** A streamed chunk goes out once this much time passed since the last one. */
export const CHUNK_INTERVAL_MS = 700;

export const AGENT_FAILED_TEXT = 'Something went wrong on this computer. Try again.';
export const AGENT_MISSING_TEXT = 'This agent is not on this computer any more.';
export const FILES_NOT_OPENED_TEXT = "This computer can't open files in private chats yet.";

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

/** What this computer says it supports: `sealed_chat` only once it trusts a phone. */
export function helloFeatures(e2e: E2eConfig | undefined): string[] {
  const phones = e2e?.devices.some((device) => device.kind === 'phone') ?? false;
  return phones ? [SCOPED_SESSIONS_FEATURE, SEALED_CHAT_FEATURE] : [SCOPED_SESSIONS_FEATURE];
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
  send: (frame: SealedReplyFrame) => boolean;
  outbox: ResultOutbox;
  log?: (line: string) => void;
  signal?: AbortSignal;
  now?: () => number;
}

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

  async receive(frame: SealedMessageFrame): Promise<void> {
    const log = this.options.log;
    let e2e = this.options.e2e();
    if (e2e === undefined) return;
    let opened = openIncoming(this.context(e2e, frame.agent), frame.sealed);
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
      opened = openIncoming(this.context(e2e, frame.agent), frame.sealed);
    }
    if (!opened.ok) {
      log?.(`private message ${frame.message_id} not opened (${opened.reason})`);
      if (opened.reason !== 'replay')
        await this.reply(frame, async (send) => send({ text: '', notice: 'couldnt_open' }, true));
      return;
    }
    const highest = this.window(e2e).highest();
    await this.options.persist((current) => ({
      ...current,
      seen: { ...current.seen, ...highest },
    }));
    const payload = opened.payload;
    if (payload.text.trim() === '' && (payload.files?.length ?? 0) > 0) {
      log?.(`private message ${frame.message_id} has ${payload.files!.length} files, not opened`);
      await this.reply(frame, async (send) => send({ text: FILES_NOT_OPENED_TEXT }, true));
      return;
    }
    await this.reply(frame, (send) => this.runAgent(frame, payload, send));
  }

  private async runAgent(
    frame: SealedMessageFrame,
    payload: SealedPayload,
    send: (payload: SealedPayload, final: boolean) => Promise<void>,
  ): Promise<void> {
    const { pool } = this.options;
    const adapter = pool.acquire(frame.agent);
    if (adapter === undefined) return send({ text: AGENT_MISSING_TEXT }, true);
    const now = this.options.now ?? Date.now;
    let buffered = '';
    let total = 0;
    let lastSent = now();
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.options.signal?.addEventListener('abort', stop, { once: true });
    try {
      await pool.runExclusive(frame.agent, async () => {
        try {
          for await (const event of adapter.sendTurn(
            `${TEXT_TURN_TAG}\n${privateTurnText(payload)}`,
            controller.signal,
            { surface: 'text' },
          )) {
            if (controller.signal.aborted) break;
            if (event.type === 'approval.required') {
              // Approvals in private chats are not built yet (ADR-044): never approve unseen.
              adapter.decide?.(event.id, 'deny');
              continue;
            }
            if (event.type !== 'text') continue;
            const room = MAX_STORED_AGENT_MESSAGE_CHARS - total;
            let text = event.text.slice(0, Math.max(0, room));
            if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
            total += text.length;
            buffered += text;
            if (buffered.length >= CHUNK_CHARS || now() - lastSent >= CHUNK_INTERVAL_MS) {
              const out = buffered;
              buffered = '';
              lastSent = now();
              await send({ text: out }, false);
            }
          }
        } catch {
          this.options.log?.(`private turn ${frame.message_id} failed`);
          buffered += total === 0 ? AGENT_FAILED_TEXT : `\n\n${AGENT_FAILED_TEXT}`;
        }
      });
    } finally {
      this.options.signal?.removeEventListener('abort', stop);
      pool.release(frame.agent);
    }
    await send({ text: buffered }, true);
  }

  /**
   * One reply to `frame`: every chunk shares one fresh seq (persisted before use) and gets the
   * next chunk index. Once a send fails, the rest is held and goes out after the next reconnect,
   * in order, so the final chunk reaches the server once.
   */
  private async reply(
    frame: SealedMessageFrame,
    body: (send: (payload: SealedPayload, final: boolean) => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const saved = await this.options.persist((current) => ({ ...current, seq: current.seq + 1 }));
    if (saved === undefined) return;
    const seq = saved.seq;
    const ctx = this.context(saved, frame.agent);
    let index = 0;
    const held: SealedReplyFrame[] = [];
    const push = (out: SealedReplyFrame) => {
      if (held.length > 0 || !this.options.send(out)) held.push(out);
    };
    const seal = (payload: SealedPayload, final: boolean) => {
      const pieces = splitText(payload.text, CHUNK_CHARS);
      pieces.forEach((text, i) =>
        sealPiece({ ...payload, text }, final && i === pieces.length - 1),
      );
    };
    const sealPiece = (payload: SealedPayload, final: boolean): void => {
      const out: SealedReplyFrame = {
        type: 'sealed.reply',
        agent: frame.agent,
        turn_id: frame.message_id,
        sealed: sealOutgoing(ctx, payload, seq, { index, final }),
        final,
      };
      if (
        Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_RELAY_MESSAGE_BYTES &&
        payload.text.length > 1
      ) {
        const [a, b] = splitText(payload.text, Math.ceil(payload.text.length / 2));
        sealPiece({ ...payload, text: a! }, false);
        sealPiece({ ...payload, text: b ?? '' }, final);
        return;
      }
      index++;
      push(out);
    };
    await body((payload, final) => {
      seal(payload, final);
      return Promise.resolve();
    });
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
