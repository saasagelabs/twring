import type { LookupFunction } from 'node:net';

import {
  agentEventSchema,
  isSupportedNativeProtocol,
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_PROTOCOL,
  nativeControlMessageSchema,
  type AdapterCapabilities,
  type AgentEvent,
  type NativeClientMessage,
  type NativeSessionReady,
  type TurnCancelReason,
  type UserTurn,
} from '@twring/contracts';
import WebSocket from 'ws';

import {
  systemSleep,
  type AgentConnectionContext,
  type TwringAgentAdapter,
  type Sleep,
} from './adapter';
import type { ResolvedAddress } from './endpoint-guard';
import { AdapterError, fromAgentCode } from './errors';
import { AgentStreamGuard, MAX_TEXT_TURN_TEXT_CHARS } from './stream-guard';

export type NativeSocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface NativeWsTimeouts {
  /** TCP + TLS + WebSocket upgrade. */
  connectMs: number;
  /** `session.hello` → `session.ready`. */
  handshakeMs: number;
  /** Idle time between pings. */
  heartbeatMs: number;
  /** How long a ping may go unanswered before the connection is declared dead. */
  pongTimeoutMs: number;
}

export interface NativeWsAdapterOptions {
  url: string;
  /** Sent as `Authorization: Bearer <token>`; never put in the URL. */
  token?: string;
  /** Extra headers; connection-level headers (Host, Upgrade, proxy, Sec-WebSocket-*) are refused. */
  headers?: Record<string, string>;
  /**
   * The address `assertSafeAgentEndpoint` validated. When set, the socket connects to exactly this
   * address (Host/SNI keep the URL's name), so DNS cannot be rebound after validation.
   */
  pinnedAddress?: ResolvedAddress;
  socketFactory?: NativeSocketFactory;
  timeouts?: Partial<NativeWsTimeouts>;
  /** Waits before each reconnect attempt, tried between turns only. */
  reconnectDelaysMs?: readonly number[];
  timers?: Timers;
  sleep?: Sleep;
}

export const DEFAULT_NATIVE_TIMEOUTS: NativeWsTimeouts = {
  connectMs: 10_000,
  handshakeMs: 5_000,
  heartbeatMs: 20_000,
  pongTimeoutMs: 10_000,
};
export const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

const NO_CAPABILITIES: AdapterCapabilities = {
  streamingText: false,
  cancellation: false,
  resumableStream: false,
  activityEvents: false,
  toolEvents: false,
  approvals: false,
  conversationResume: false,
  serverInitiatedCalls: false,
};

const FORBIDDEN_HEADER =
  /^(host|authorization|connection|upgrade|content-length|transfer-encoding|te|trailer|keep-alive|proxy-.*|sec-websocket-.*|x-forwarded-.*|forwarded)$/i;

type TurnItem =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'violation' }
  | { kind: 'fail'; error: AdapterError }
  | { kind: 'aborted' };

/**
 * Events one turn may have waiting for its consumer. An agent that outruns the call by this much
 * is flooding it: the turn fails with `protocol_violation` ("event backlog") instead of growing
 * memory without bound (SECURITY: bounded payloads).
 */
export const MAX_TURN_BACKLOG = 2000;

/** Single-consumer queue between the socket's message handler and a turn's async iterator. */
class TurnQueue {
  private readonly items: TurnItem[] = [];
  private waiter: ((item: TurnItem) => void) | null = null;
  private overflowed = false;

  push(item: TurnItem): void {
    if (this.overflowed) return;
    if (this.waiter !== null) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(item);
      return;
    }
    if (item.kind === 'event' && this.items.length >= MAX_TURN_BACKLOG) {
      // Refused: the consumer sees the events so far, then the failure; later frames are dropped.
      this.overflowed = true;
      this.items.push({
        kind: 'fail',
        error: new AdapterError('protocol_violation', {
          detail: 'event backlog exceeded',
          retryable: false,
        }),
      });
      return;
    }
    this.items.push(item);
  }

  next(): Promise<TurnItem> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => (this.waiter = resolve));
  }
}

interface ActiveTurn {
  turnId: string;
  queue: TurnQueue;
}

/**
 * Twring Native adapter: speaks `cord-agent/1` over one persistent WebSocket (ADAPTERS §3,
 * AGENT_ADAPTER_SPEC §20). One turn at a time; a turn is sent exactly once and is never replayed
 * after a drop. Reconnects happen only between turns, on the next `sendTurn`.
 */
export class NativeWsAdapter implements TwringAgentAdapter {
  readonly name = 'cord-native';
  private caps: AdapterCapabilities = NO_CAPABILITIES;
  private socket: WebSocket | null = null;
  private context: AgentConnectionContext | null = null;
  private active: ActiveTurn | null = null;
  private closed = false;
  private heartbeatTimer: unknown = null;
  private pongTimer: unknown = null;
  private pendingPing: string | null = null;
  private pingCount = 0;
  /** Fails the in-flight handshake, if any (close() during connect). */
  private abortOpen: ((error: Error) => void) | null = null;
  private readonly timeouts: NativeWsTimeouts;
  private readonly timers: Timers;
  private readonly sleep: Sleep;
  private readonly socketFactory: NativeSocketFactory;
  private readonly headers: Record<string, string>;

  constructor(private readonly options: NativeWsAdapterOptions) {
    this.timeouts = { ...DEFAULT_NATIVE_TIMEOUTS, ...options.timeouts };
    this.timers = options.timers ?? systemTimers;
    this.sleep = options.sleep ?? systemSleep;
    this.socketFactory = options.socketFactory ?? ((url, opts) => new WebSocket(url, opts));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      if (FORBIDDEN_HEADER.test(key)) throw new Error(`Header "${key}" cannot be configured`);
      headers[key] = value;
    }
    if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
    this.headers = headers;
  }

  /** What the agent declared in `session.ready`; all false until connected. */
  get capabilities(): AdapterCapabilities {
    return this.caps;
  }

  async connect(context: AgentConnectionContext, signal: AbortSignal): Promise<void> {
    if (this.closed) throw new AdapterError('not_connected', { retryable: false });
    this.context = context;
    if (this.socket === null) await this.open(signal);
  }

  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.active !== null) throw new Error('NativeWsAdapter: a turn is already in progress');
    if (signal.aborted) return;
    const socket = await this.ensureConnected(signal);
    if (signal.aborted) return;
    if (this.active !== null) throw new Error('NativeWsAdapter: a turn is already in progress');
    const active: ActiveTurn = { turnId: turn.turnId, queue: new TurnQueue() };
    this.active = active;
    // Aborting ends the turn locally at once: the slot frees synchronously so a superseding turn
    // can start immediately, and the old turn's late frames no longer match the active turn_id.
    const onAbort = () => this.endTurn(turn.turnId, cancelReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    let finished = false;
    try {
      // Sent exactly once. Any failure after this point surfaces; the turn is never resent.
      this.send(socket, {
        type: 'user.turn',
        session_id: turn.sessionId,
        turn_id: turn.turnId,
        text: turn.text,
        ...(turn.surface !== undefined && { surface: turn.surface }),
        ...(turn.attachments?.length && { attachments: turn.attachments }),
        started_at: turn.startedAt,
        committed_at: turn.committedAt,
      });
      const guard = new AgentStreamGuard(
        turn.turnId,
        turn.surface === 'text' ? MAX_TEXT_TURN_TEXT_CHARS : undefined,
      );
      for (;;) {
        const item = await active.queue.next();
        if (item.kind === 'aborted') return;
        if (item.kind === 'fail') {
          finished = true;
          throw item.error;
        }
        if (item.kind === 'violation') throw violation();
        const result = guard.accept(item.event);
        if (result.kind === 'ignored') continue;
        if (result.kind === 'violation') throw violation();
        // Set before yielding: a consumer that stops at the terminal event must not cancel it.
        // The turn is also freed and its abort listener removed first, so a consumer that aborts
        // while handling the terminal event sends no turn.cancel for a finished turn.
        const terminal = result.event.type === 'done' || result.event.type === 'error';
        if (terminal) {
          finished = true;
          signal.removeEventListener('abort', onAbort);
          if (this.active === active) this.active = null;
        }
        yield result.event;
        if (terminal) return;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      // Stopped early (abort, consumer break, violation): ask the agent to stop too.
      if (!finished) this.endTurn(turn.turnId, cancelReason(signal));
      else if (this.active === active) this.active = null;
    }
  }

  cancelTurn(turnId: string, reason: TurnCancelReason): Promise<void> {
    this.endTurn(turnId, reason);
    return Promise.resolve();
  }

  decideApproval(turnId: string, approvalId: string, decision: 'approve' | 'deny'): Promise<void> {
    if (this.active?.turnId === turnId && this.socket !== null) {
      this.send(this.socket, {
        type: 'approval.decision',
        turn_id: turnId,
        approval_id: approvalId,
        decision,
      });
    }
    return Promise.resolve();
  }

  /**
   * Ends `turnId` locally (frees the slot, wakes its iterator) and sends `turn.cancel` once.
   * Only the active turn can be ended, so this is idempotent and a finished turn is never cancelled.
   */
  private endTurn(turnId: string, reason: TurnCancelReason): void {
    const active = this.active;
    if (active?.turnId !== turnId) return;
    this.active = null;
    active.queue.push({ kind: 'aborted' });
    if (!this.caps.cancellation || this.socket === null) return;
    try {
      this.send(this.socket, { type: 'turn.cancel', turn_id: turnId, reason });
    } catch {
      // The connection is going away; the drop handler reports it.
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.abortOpen?.(new AdapterError('not_connected', { retryable: false }));
    const socket = this.socket;
    this.detach(new AdapterError('not_connected', { retryable: false }));
    if (socket !== null) {
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.close(1000, 'client closing');
    }
    return Promise.resolve();
  }

  private async ensureConnected(signal: AbortSignal): Promise<WebSocket> {
    if (this.socket !== null) return this.socket;
    if (this.closed || this.context === null) {
      throw new AdapterError('not_connected', { retryable: false });
    }
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    let lastError: unknown = new AdapterError('connection_failed');
    for (const delay of delays) {
      await this.sleep(delay, signal);
      try {
        return await this.open(signal);
      } catch (error) {
        if (signal.aborted || !(error instanceof AdapterError) || !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  private open(signal: AbortSignal): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      if (this.closed) {
        reject(new AdapterError('not_connected', { retryable: false }));
        return;
      }
      const context = this.context!;
      const pinned = this.options.pinnedAddress;
      const ws = this.socketFactory(this.options.url, {
        headers: this.headers,
        followRedirects: false,
        maxPayload: MAX_NATIVE_MESSAGE_BYTES,
        handshakeTimeout: this.timeouts.connectMs,
        perMessageDeflate: false,
        ...(pinned === undefined ? {} : { lookup: pinnedLookup(pinned) }),
      });
      let settled = false;
      let timer = this.timers.setTimeout(
        () => fail(new AdapterError('timeout')),
        this.timeouts.connectMs,
      );

      const cleanup = () => {
        this.timers.clearTimeout(timer);
        if (this.abortOpen === fail) this.abortOpen = null;
        signal.removeEventListener('abort', onAbort);
        ws.off('open', onOpen);
        ws.off('message', onMessage);
        ws.off('close', onClose);
        ws.off('error', onError);
        ws.off('unexpected-response', onUnexpected);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        ws.on('error', () => undefined);
        try {
          ws.terminate();
        } catch {
          // Already gone.
        }
        reject(error);
      };
      const onAbort = () => fail(signal.reason as Error);
      // ws enforces maxPayload by erroring (1009): an oversized handshake frame is a violation.
      const onError = (error: Error & { code?: string }) =>
        fail(
          error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
            ? violation()
            : new AdapterError('connection_failed'),
        );
      const onClose = () => fail(new AdapterError('connection_failed'));
      const onUnexpected = (req: { destroy(): void }, res: { statusCode?: number }) => {
        const status = res.statusCode ?? 0;
        fail(
          status === 401 || status === 403
            ? new AdapterError('auth_failed', { retryable: false })
            : new AdapterError('connection_failed', { detail: `HTTP ${status}` }),
        );
        req.destroy();
      };
      const onOpen = () => {
        this.timers.clearTimeout(timer);
        timer = this.timers.setTimeout(
          () => fail(new AdapterError('timeout')),
          this.timeouts.handshakeMs,
        );
        try {
          this.send(ws, {
            type: 'session.hello',
            protocol: NATIVE_PROTOCOL,
            session_id: context.sessionId,
            call_id: context.callId,
            capabilities_requested: [
              'streaming_text',
              'cancel',
              'activity',
              'tools',
              'approvals',
              'resume',
            ],
          });
        } catch {
          fail(new AdapterError('connection_failed'));
        }
      };
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        const parsed = parseFrame(data, isBinary);
        const control =
          parsed === undefined ? undefined : nativeControlMessageSchema.safeParse(parsed);
        if (control === undefined || !control.success) {
          fail(violation());
          return;
        }
        const message = control.data;
        if (message.type === 'session.error') {
          fail(fromAgentCode(message.code));
          return;
        }
        if (message.type !== 'session.ready') {
          fail(violation());
          return;
        }
        if (!isSupportedNativeProtocol(message.protocol)) {
          fail(new AdapterError('protocol_unsupported', { retryable: false }));
          return;
        }
        settled = true;
        cleanup();
        this.attach(ws, message);
        resolve(ws);
      };

      this.abortOpen = fail;
      signal.addEventListener('abort', onAbort, { once: true });
      ws.on('open', onOpen);
      // A throw in a socket listener would escape to the process: it fails the handshake instead.
      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        try {
          onMessage(data, isBinary);
        } catch {
          fail(violation());
        }
      });
      ws.on('close', onClose);
      ws.on('error', onError);
      ws.on('unexpected-response', onUnexpected);
    });
  }

  /** Moves a handshaken socket into the steady state. */
  private attach(ws: WebSocket, ready: NativeSessionReady): void {
    const declared = ready.capabilities;
    this.caps = {
      ...NO_CAPABILITIES,
      streamingText: declared.streaming_text === true,
      cancellation: declared.cancel === true,
      activityEvents: declared.activity === true,
      toolEvents: declared.tools === true,
      approvals: declared.approvals === true,
      // Stream resume isn't implemented by this adapter yet; never claim it (§4).
      resumableStream: false,
    };
    this.socket = ws;
    let dropError: AdapterError | null = null;
    ws.on('error', (error: Error & { code?: string }) => {
      // ws enforces maxPayload by erroring and closing (1009): that is the agent's violation.
      dropError =
        error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
          ? violation()
          : new AdapterError('connection_lost');
    });
    ws.on('close', () => {
      if (this.socket === ws) this.detach(dropError ?? new AdapterError('connection_lost'));
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // Anything thrown while handling a frame drops this connection, never the process.
      try {
        this.onMessage(ws, data, isBinary);
      } catch {
        this.drop(ws, violation());
      }
    });
    this.scheduleHeartbeat(ws);
  }

  private onMessage(ws: WebSocket, data: WebSocket.RawData, isBinary: boolean): void {
    const parsed = parseFrame(data, isBinary);
    const control = nativeControlMessageSchema.safeParse(parsed);
    if (control.success) {
      const message = control.data;
      if (message.type === 'pong') {
        if (message.id === this.pendingPing) {
          this.pendingPing = null;
          this.timers.clearTimeout(this.pongTimer);
          this.scheduleHeartbeat(ws);
        }
      } else if (message.type === 'session.error') {
        this.drop(ws, fromAgentCode(message.code));
      }
      // A repeated session.ready is harmless and ignored.
      return;
    }
    const event = agentEventSchema.safeParse(parsed);
    const active = this.active;
    if (active === null) return; // Late or stray frames between turns are dropped.
    if (!event.success) {
      active.queue.push({ kind: 'violation' });
      return;
    }
    if (event.data.turn_id === active.turnId)
      active.queue.push({ kind: 'event', event: event.data });
  }

  private scheduleHeartbeat(ws: WebSocket): void {
    this.timers.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = this.timers.setTimeout(() => {
      if (this.socket !== ws) return;
      this.pingCount += 1;
      const id = `ping_${this.pingCount}`;
      this.pendingPing = id;
      this.pongTimer = this.timers.setTimeout(
        () => this.drop(ws, new AdapterError('connection_lost')),
        this.timeouts.pongTimeoutMs,
      );
      try {
        this.send(ws, { type: 'ping', id });
      } catch {
        this.drop(ws, new AdapterError('connection_lost'));
      }
    }, this.timeouts.heartbeatMs);
  }

  /** Declares `ws` dead now (without waiting for a close handshake) and fails any active turn. */
  private drop(ws: WebSocket, error: AdapterError): void {
    if (this.socket !== ws) return;
    this.detach(error);
    ws.removeAllListeners();
    ws.on('error', () => undefined);
    ws.terminate();
  }

  private detach(error: AdapterError): void {
    this.socket = null;
    this.pendingPing = null;
    this.timers.clearTimeout(this.heartbeatTimer);
    this.timers.clearTimeout(this.pongTimer);
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.active?.queue.push({ kind: 'fail', error });
  }

  private send(ws: WebSocket, message: NativeClientMessage): void {
    ws.send(JSON.stringify(message));
  }
}

function violation(): AdapterError {
  return new AdapterError('protocol_violation', { retryable: false });
}

/** Decodes one frame; `undefined` for binary, oversized, or non-JSON frames. */
function parseFrame(data: WebSocket.RawData, isBinary: boolean): unknown {
  if (isBinary) return undefined;
  const buffer = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
  if (buffer.byteLength > MAX_NATIVE_MESSAGE_BYTES) return undefined;
  try {
    return JSON.parse(buffer.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const CANCEL_REASONS: readonly TurnCancelReason[] = [
  'superseded',
  'barge_in',
  'call_ended',
  'timeout',
];

function cancelReason(signal: AbortSignal): TurnCancelReason {
  const raw: unknown = signal.reason;
  // The gateway aborts with `new Error(reason)`; accept either form.
  const reason = raw instanceof Error ? raw.message : raw;
  return typeof reason === 'string' && (CANCEL_REASONS as readonly string[]).includes(reason)
    ? (reason as TurnCancelReason)
    : 'superseded';
}

/** A DNS lookup that always answers with the pre-validated address (anti-rebinding). */
export function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options.all === true) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  }) as unknown as LookupFunction;
}
