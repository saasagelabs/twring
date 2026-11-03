import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';

import {
  agentEventSchema,
  MAX_AGENT_DELTA_CHARS,
  MAX_REST_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  REST_PROTOCOL,
  restFinalResponseSchema,
  type AdapterCapabilities,
  type AgentEvent,
  type RestTurnRequest,
  type UserTurn,
} from '@twring/contracts';

import {
  systemSleep,
  type AgentConnectionContext,
  type TwringAgentAdapter,
  type Sleep,
} from './adapter';
import type { ResolvedAddress } from './endpoint-guard';
import { AdapterError } from './errors';
import { pinnedLookup, systemTimers, type Timers } from './native-adapter';
import { AgentStreamGuard, MAX_TEXT_TURN_TEXT_CHARS } from './stream-guard';
import { SseParser, type SseEvent } from './sse-parser';

export interface RestSseTimeouts {
  /** TCP (+ TLS) connect. Time to the response is the caller's first-event budget. */
  connectMs: number;
  /** Silence allowed between response bytes (SSE heartbeat comments count). */
  idleMs: number;
}

export const DEFAULT_REST_TIMEOUTS: RestSseTimeouts = { connectMs: 10_000, idleMs: 30_000 };
/** Wait before the single automatic retry of a request that never connected. */
export const DEFAULT_REST_RETRY_DELAY_MS = 250;

export interface RestSseAdapterOptions {
  /** The agent's `cord-rest/1` turn endpoint (`POST`). */
  url: string;
  /** Sent as `Authorization: Bearer <token>`; never put in the URL. */
  token?: string;
  /** Extra headers; protocol and connection-level headers are refused. */
  headers?: Record<string, string>;
  /**
   * The address `assertSafeAgentEndpoint` validated. When set, every request connects to exactly
   * this address (Host/SNI keep the URL's name), so DNS cannot be rebound after validation.
   */
  pinnedAddress?: ResolvedAddress;
  timeouts?: Partial<RestSseTimeouts>;
  retryDelayMs?: number;
  timers?: Timers;
  sleep?: Sleep;
}

const FORBIDDEN_HEADER =
  /^(host|authorization|content-type|content-length|accept|idempotency-key|connection|upgrade|transfer-encoding|te|trailer|keep-alive|expect|proxy-.*|x-forwarded-.*|forwarded)$/i;

/** Errors that mean the request never reached the agent, so one retry cannot duplicate it. */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

type TurnItem =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'fail'; error: AdapterError }
  /** The response ended cleanly but without a terminal event. */
  | { kind: 'end' }
  | { kind: 'aborted' };

/** Single-consumer queue between the HTTP response handlers and a turn's async iterator. */
class TurnQueue {
  private readonly items: TurnItem[] = [];
  private waiter: ((item: TurnItem) => void) | null = null;

  push(item: TurnItem): void {
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  next(): Promise<TurnItem> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

interface Exchange {
  /** Stops the exchange for good: no retry, no more items. */
  stop(): void;
}

/**
 * REST + SSE adapter: speaks `cord-rest/1` (ADAPTERS §4, AGENT_ADAPTER_SPEC §21). One HTTP request
 * per committed turn, answered with an SSE stream of AgentEvents or a final JSON body. Aborting the
 * turn destroys the request: that is the cancel. A request is retried at most once, and only when
 * it failed to connect, so the agent never sees a turn twice because of Twring.
 */
export class RestSseAdapter implements TwringAgentAdapter {
  readonly name = 'cord-rest';
  private context: AgentConnectionContext | null = null;
  private closed = false;
  /** Cleared for the rest of the session once the agent answers with final JSON. */
  private streaming = true;
  private readonly url: URL;
  private readonly headers: Record<string, string>;
  private readonly timeouts: RestSseTimeouts;
  private readonly timers: Timers;
  private readonly sleep: Sleep;
  private readonly inflight = new Set<{ queue: TurnQueue; exchange: Exchange | null }>();

  constructor(private readonly options: RestSseAdapterOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new AdapterError('endpoint_rejected', { detail: 'not a valid URL', retryable: false });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AdapterError('endpoint_rejected', {
        detail: 'unsupported scheme',
        retryable: false,
      });
    }
    this.url = url;
    this.timeouts = { ...DEFAULT_REST_TIMEOUTS, ...options.timeouts };
    this.timers = options.timers ?? systemTimers;
    this.sleep = options.sleep ?? systemSleep;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (FORBIDDEN_HEADER.test(key)) throw new Error(`Header "${key}" cannot be configured`);
      headers[key] = value;
    }
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    this.headers = headers;
  }

  /**
   * An HTTP agent can't declare capabilities up front: streaming is assumed until the agent answers
   * with final JSON; activity and tool events are shown if they arrive (the UI degrades on its own).
   */
  get capabilities(): AdapterCapabilities {
    return {
      streamingText: this.streaming,
      cancellation: true,
      resumableStream: false,
      activityEvents: true,
      toolEvents: true,
      approvals: false,
      conversationResume: false,
      serverInitiatedCalls: false,
    };
  }

  /** Configuration only: no request is made until the first turn. */
  connect(context: AgentConnectionContext, signal: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new AdapterError('not_connected', { retryable: false }));
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    this.context = context;
    return Promise.resolve();
  }

  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.closed || this.context === null) {
      throw new AdapterError('not_connected', { retryable: false });
    }
    if (signal.aborted) return;
    const body: RestTurnRequest = {
      protocol: REST_PROTOCOL,
      session_id: turn.sessionId,
      call_id: this.context.callId,
      turn_id: turn.turnId,
      text: turn.text,
      ...(turn.surface !== undefined && { surface: turn.surface }),
      ...(turn.attachments?.length && { attachments: turn.attachments }),
      started_at: turn.startedAt,
      committed_at: turn.committedAt,
    };
    const entry: { queue: TurnQueue; exchange: Exchange | null } = {
      queue: new TurnQueue(),
      exchange: null,
    };
    this.inflight.add(entry);
    const onAbort = () => {
      entry.exchange?.stop();
      entry.queue.push({ kind: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      entry.exchange = this.start(turn.turnId, JSON.stringify(body), entry.queue, signal);
      const guard = new AgentStreamGuard(
        turn.turnId,
        turn.surface === 'text' ? MAX_TEXT_TURN_TEXT_CHARS : undefined,
      );
      for (;;) {
        const item = await entry.queue.next();
        if (item.kind === 'aborted') return;
        if (item.kind === 'fail') throw item.error;
        if (item.kind === 'end') throw new AdapterError('connection_lost');
        const result = guard.accept(item.event);
        if (result.kind === 'ignored') continue;
        if (result.kind === 'violation') throw violation();
        const terminal = result.event.type === 'done' || result.event.type === 'error';
        if (terminal) {
          // Finished: nothing left to cancel, so a later abort must not count as one.
          signal.removeEventListener('abort', onAbort);
          entry.exchange.stop();
        }
        yield result.event;
        if (terminal) return;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Stopped early (abort, consumer break, failure): destroying the request is the cancel.
      entry.exchange?.stop();
      this.inflight.delete(entry);
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    for (const entry of this.inflight) {
      entry.exchange?.stop();
      entry.queue.push({
        kind: 'fail',
        error: new AdapterError('not_connected', { retryable: false }),
      });
    }
    this.inflight.clear();
    return Promise.resolve();
  }

  /** Sends the turn's request (retrying once if it never connected) and feeds `queue`. */
  private start(turnId: string, body: string, queue: TurnQueue, signal: AbortSignal): Exchange {
    let stopped = false;
    let current: http.ClientRequest | null = null;
    let connectTimer: unknown = null;
    let idleTimer: unknown = null;

    const clearTimers = () => {
      this.timers.clearTimeout(connectTimer);
      this.timers.clearTimeout(idleTimer);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimers();
      current?.destroy();
      current = null;
    };
    const fail = (error: AdapterError) => {
      if (stopped) return;
      stop();
      queue.push({ kind: 'fail', error });
    };
    const emit = (event: AgentEvent) => {
      if (!stopped) queue.push({ kind: 'event', event });
    };

    const attempt = (n: number) => {
      if (stopped) return;
      const secure = this.url.protocol === 'https:';
      const pinned = this.options.pinnedAddress;
      const options: https.RequestOptions = {
        method: 'POST',
        agent: false,
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          'Idempotency-Key': turnId,
          'Content-Length': String(Buffer.byteLength(body)),
        },
        ...(pinned === undefined ? {} : { lookup: pinnedLookup(pinned) }),
      };
      const req = (secure ? https : http).request(this.url, options);
      current = req;
      let connected = false;
      let responded = false;
      connectTimer = this.timers.setTimeout(
        () => fail(new AdapterError('timeout', { detail: 'connect' })),
        this.timeouts.connectMs,
      );
      const onConnected = () => {
        connected = true;
        this.timers.clearTimeout(connectTimer);
      };
      req.on('socket', (socket: Socket) => {
        if (!socket.connecting) onConnected();
        else socket.once(secure ? 'secureConnect' : 'connect', onConnected);
        // Any TCP connection may already have carried request bytes.
        socket.once('connect', () => (connected = true));
      });
      req.on('error', (error: Error & { code?: string }) => {
        if (stopped || current !== req) return;
        if (!connected && n === 0 && NOT_SENT_CODES.has(error.code ?? '')) {
          // Never reached the agent: one retry with the same Idempotency-Key.
          this.timers.clearTimeout(connectTimer);
          current = null;
          this.sleep(this.options.retryDelayMs ?? DEFAULT_REST_RETRY_DELAY_MS, signal).then(
            () => attempt(1),
            () => undefined,
          );
          return;
        }
        fail(new AdapterError(responded ? 'connection_lost' : 'connection_failed'));
      });
      req.on('response', (res: http.IncomingMessage) => {
        try {
          onResponse(res);
        } catch {
          res.resume();
          fail(violation());
        }
      });
      const onResponse = (res: http.IncomingMessage) => {
        responded = true;
        onConnected();
        res.on('error', () => undefined);
        const status = res.statusCode ?? 0;
        if (status < 200 || status > 299) {
          res.resume();
          fail(
            status === 401 || status === 403
              ? new AdapterError('auth_failed', { retryable: false, httpStatus: status })
              : new AdapterError('agent_error', { detail: `HTTP ${status}`, httpStatus: status }),
          );
          return;
        }
        const mediaType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (mediaType !== 'text/event-stream' && mediaType !== 'application/json') {
          fail(violation());
          return;
        }
        const json = mediaType === 'application/json';
        const parser = new SseParser({ maxEventBytes: MAX_SSE_EVENT_BYTES });
        const chunks: Buffer[] = [];
        let total = 0;
        let count = 0;
        const armIdle = () => {
          this.timers.clearTimeout(idleTimer);
          idleTimer = this.timers.setTimeout(
            () => fail(new AdapterError('timeout', { detail: 'idle' })),
            this.timeouts.idleMs,
          );
        };
        const deliver = (events: SseEvent[]) => {
          for (const sse of events) {
            count += 1;
            const event = toAgentEvent(sse, turnId, count);
            if (event === undefined) {
              fail(violation());
              return;
            }
            emit(event);
          }
        };
        armIdle();
        // Every listener below is guarded: anything thrown fails this turn, never the process.
        res.on('data', (chunk: Buffer) => {
          if (stopped) return;
          try {
            total += chunk.byteLength;
            if (total > MAX_REST_RESPONSE_BYTES) {
              fail(violation());
              return;
            }
            armIdle();
            if (json) {
              chunks.push(chunk);
              return;
            }
            deliver(parser.push(chunk));
          } catch {
            // SseLimitError, or anything unexpected: the stream can't be trusted.
            fail(violation());
          }
        });
        res.on('end', () => {
          if (stopped) return;
          try {
            this.timers.clearTimeout(idleTimer);
            if (json) {
              const events = finalJsonEvents(Buffer.concat(chunks), turnId);
              if (events === undefined) {
                fail(violation());
                return;
              }
              // Only a body that validated proves the agent answers without streaming.
              this.streaming = false;
              events.forEach(emit);
            } else {
              deliver(parser.end());
              // The stream was cut inside an event: what the agent sent can't be read.
              if (parser.truncated) fail(violation());
            }
            if (!stopped) queue.push({ kind: 'end' });
          } catch {
            fail(violation());
          }
        });
        res.on('close', () => {
          if (!res.complete) fail(new AdapterError('connection_lost'));
        });
      };
      req.end(body);
    };

    attempt(0);
    return { stop };
  }
}

/**
 * Prefix of the event ids Twring assigns when an SSE event has neither `event_id` nor `id:`
 * (AGENT_ADAPTER_SPEC §21); chosen so it can't collide with an agent's own ids in practice.
 */
export const AUTO_EVENT_ID_PREFIX = 'cord-auto-';

function violation(): AdapterError {
  return new AdapterError('protocol_violation', { retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One SSE event → one AgentEvent. `event:` names the type (a `type` in `data` must agree);
 * `turn_id` defaults to the request's, `event_id` to the block's SSE `id:` or the response
 * sequence. Undefined when the event isn't a valid AgentEvent.
 */
function toAgentEvent(sse: SseEvent, turnId: string, n: number): AgentEvent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(sse.data);
  } catch {
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const type = sse.type === 'message' ? data.type : sse.type;
  if (data.type !== undefined && data.type !== type) return undefined;
  const parsed = agentEventSchema.safeParse({
    ...data,
    type,
    turn_id: data.turn_id ?? turnId,
    event_id:
      data.event_id ??
      (sse.hasId && sse.lastEventId !== '' ? sse.lastEventId : `${AUTO_EVENT_ID_PREFIX}${n}`),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A final JSON body → the same events a streamed reply of one message would produce. */
function finalJsonEvents(body: Buffer, turnId: string): AgentEvent[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = restFinalResponseSchema.safeParse(data);
  if (!parsed.success) return undefined;
  const { text, status } = parsed.data;
  let n = 0;
  const next = () => {
    n += 1;
    return { event_id: `json_${n}`, turn_id: turnId, seq: n };
  };
  const messageId = `msg_${turnId}`;
  const events: AgentEvent[] = [];
  if (text !== '') {
    events.push({ type: 'text.start', ...next(), message_id: messageId });
    for (const delta of splitText(text, MAX_AGENT_DELTA_CHARS)) {
      events.push({ type: 'text.delta', ...next(), message_id: messageId, delta });
    }
    events.push({ type: 'text.end', ...next(), message_id: messageId });
  }
  events.push({ type: 'done', ...next(), status: status ?? 'completed' });
  return events;
}

/** Splits text into pieces of at most `max` UTF-16 units without breaking a surrogate pair. */
function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let from = 0;
  while (from < text.length) {
    let to = Math.min(from + max, text.length);
    const last = text.charCodeAt(to - 1);
    if (to < text.length && last >= 0xd800 && last <= 0xdbff) to -= 1;
    parts.push(text.slice(from, to));
    from = to;
  }
  return parts;
}
