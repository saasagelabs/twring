import {
  MAX_RELAY_MESSAGE_BYTES,
  NATIVE_PROTOCOL,
  RELAY_CLOSE,
  RELAY_PAIRING_HEADER,
  RELAY_PAIRING_REVOKED,
  RELAY_PROTOCOL,
  relayGatewayMessageSchema,
  SCOPED_SESSIONS_FEATURE,
  type LocalAgent,
  type RelayConnectorMessage,
  type RelayGatewayMessage,
} from '@twring/contracts';
import WebSocket from 'ws';

import type { AgentPool } from './pool';
import { ChannelSession } from './session';
import { uploadFile } from './upload';

/**
 * The longest wait before each reconnect attempt; the last value repeats. The actual wait is
 * random between 0 and it (full jitter), so many computers dropped together do not return at once.
 */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/**
 * After the server closed for a restart (1001 going away, 1012 service restart) it is usually back
 * within a second: the first retry comes after this, plus up to as much again of jitter.
 */
export const RESTART_RETRY_MS = 500;
const RESTART_CLOSE_CODES: ReadonlySet<number> = new Set([1001, 1012]);
/**
 * The gateway pings every 15 s (20 s before 2026-11); this long without any traffic means the link
 * is dead. Above two ping intervals of either, so one late ping is not a drop.
 */
export const SILENCE_TIMEOUT_MS = 42_000;

export type RelayStatus =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected'; name: string }
  | { kind: 'disconnected'; retryInMs: number }
  /** Final: the token was refused, revoked, or another copy took over. */
  | { kind: 'stopped'; reason: 'unauthorized' | 'revoked' | 'replaced' };

export interface RelayClientOptions {
  url: string;
  /** The linked Twring server; only its signed file links are downloaded. */
  server?: string;
  token: string;
  agents: LocalAgent[];
  pool: AgentPool;
  onBackgroundResult(
    agentId: string,
    text: string,
    sessionRef: string | undefined,
    /** `scope`: the person's session on a shared server agent; unset for the owner. */
    turn: { turnId: string; surface: 'call' | 'text'; scope?: string },
  ): void;
  onStatus?(status: RelayStatus): void;
  /** What this computer says it supports, read at each hello (default: scoped sessions). */
  features?: () => string[];
  /** A private chat message (ADR-044); none set means they are ignored. */
  onSealedMessage?(
    frame: Extract<
      RelayGatewayMessage,
      { type: 'sealed.message' | 'sealed.decision' | 'sealed.cancel' }
    >,
  ): void;
  log?: (line: string) => void;
  delaysMs?: readonly number[];
  silenceTimeoutMs?: number;
  random?: () => number;
  version?: string;
}

/**
 * The connector's link to the gateway: dials out (no inbound port), authenticates with the token
 * in the upgrade request, says hello, and runs one `ChannelSession` per call. It reconnects with
 * backoff after a drop, and stops for good when the gateway refuses or revokes it. A turn that was
 * running when the link drops continues in the pool, never resent.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private readonly sessions = new Map<
    string,
    { session: ChannelSession; agent: string; scope?: string }
  >();
  private stopped = false;
  private features = new Set<string>();
  private readonly stopController = new AbortController();
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private finished!: () => void;
  /** Resolves once the client stops (Ctrl+C, revoked, replaced, or refused). */
  readonly done: Promise<void>;

  constructor(private readonly options: RelayClientOptions) {
    this.done = new Promise((resolve) => (this.finished = resolve));
  }

  start(): void {
    this.connect();
  }

  /** A call open to this agent in this person's session (no scope: the owner's). */
  hasOpenChannel(agentId: string, scope?: string): boolean {
    return [...this.sessions.values()].some(
      (open) => open.agent === agentId && open.scope === scope,
    );
  }

  supports(feature: string): boolean {
    return this.features.has(feature);
  }

  get stopSignal(): AbortSignal {
    return this.stopController.signal;
  }

  /** Disconnects cleanly and detaches running turns. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopController.abort();
    clearTimeout(this.retryTimer);
    clearTimeout(this.silenceTimer);
    this.closeSessions();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.close(1000, 'connector stopping');
    }
    this.finished();
  }

  private connect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.options.onStatus?.({ kind: 'connecting', attempt: this.attempt });
    const ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: MAX_RELAY_MESSAGE_BYTES,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 15_000,
    });
    this.ws = ws;
    let fatal: 'unauthorized' | 'revoked' | 'replaced' | undefined;

    ws.on('unexpected-response', (req, res) => {
      // Only the gateway's explicit word unpairs. A bare 401 or 403 can come from a proxy, a
      // deploy in progress, or a clock problem: it is retried like any other refusal.
      if (
        (res.statusCode === 401 || res.statusCode === 403) &&
        res.headers[RELAY_PAIRING_HEADER] === RELAY_PAIRING_REVOKED
      )
        fatal = 'unauthorized';
      req.destroy();
      ws.terminate();
    });
    ws.on('error', () => undefined);
    ws.on('open', () => {
      this.touch(ws);
      this.hello(ws);
    });
    ws.on('ping', () => this.touch(ws));
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.touch(ws);
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText(data));
      } catch {
        return;
      }
      const frame = relayGatewayMessageSchema.safeParse(parsed);
      if (frame.success) this.onFrame(ws, frame.data);
    });
    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.silenceTimer);
      this.closeSessions('link');
      if (code === RELAY_CLOSE.revoked) fatal = 'revoked';
      if (code === RELAY_CLOSE.replaced) fatal = 'replaced';
      if (fatal !== undefined) {
        this.options.onStatus?.({ kind: 'stopped', reason: fatal });
        this.stop();
        return;
      }
      this.scheduleReconnect(RESTART_CLOSE_CODES.has(code));
    });
  }

  private onFrame(ws: WebSocket, frame: ReturnType<typeof relayGatewayMessageSchema.parse>): void {
    switch (frame.type) {
      case 'connector.ready':
        this.attempt = 0;
        this.features = new Set(frame.features ?? []);
        this.options.onStatus?.({ kind: 'connected', name: frame.name });
        return;
      case 'channel.open': {
        this.closeChannel(frame.channel);
        const channel = frame.channel;
        const scope = frame.session_scope;
        const adapter = this.options.pool.acquire(
          frame.agent,
          frame.resume_ref,
          frame.fresh_session,
          scope,
        );
        const session = new ChannelSession({
          adapter,
          ...(this.options.server !== undefined && { server: this.options.server }),
          ...(this.options.server !== undefined && {
            uploadFile: (
              file: Parameters<
                NonNullable<ConstructorParameters<typeof ChannelSession>[0]['uploadFile']>
              >[0],
            ) =>
              uploadFile({
                ...file,
                server: this.options.server!,
                token: this.options.token,
                localAgent: frame.agent,
                sessionScope: scope,
              }),
          }),
          send: (message) => this.send(ws, { type: 'channel.message', channel, message }),
          log: (line) => this.options.log?.(line),
          ...(adapter !== undefined && {
            runExclusive: (fn: () => Promise<void>) =>
              this.options.pool.runExclusive(frame.agent, fn, scope),
          }),
          onBackgroundResult: (text, turn) =>
            this.options.onBackgroundResult(
              frame.agent,
              text,
              this.options.pool.sessionRef(frame.agent, scope),
              { ...turn, ...(scope !== undefined && { scope }) },
            ),
        });
        this.sessions.set(channel, {
          session,
          agent: frame.agent,
          ...(scope !== undefined && { scope }),
        });
        this.options.log?.(
          `call started (${frame.agent}${frame.resume_ref === undefined ? '' : ', resuming a session'})`,
        );
        return;
      }
      case 'channel.message':
        this.sessions.get(frame.channel)?.session.handle(frame.message);
        return;
      case 'channel.close':
        if (this.closeChannel(frame.channel)) this.options.log?.('call ended');
        return;
      case 'sealed.message':
      case 'sealed.decision':
      case 'sealed.cancel':
        // Private chats (ADR-044): opened and answered by `PrivateChats` (e2e/turn.ts).
        this.options.onSealedMessage?.(frame);
        return;
    }
  }

  private hello(ws: WebSocket): void {
    this.send(ws, {
      type: 'connector.hello',
      protocol: RELAY_PROTOCOL,
      agent_protocol: NATIVE_PROTOCOL,
      agents: this.options.agents,
      ...(this.options.version !== undefined && { version: this.options.version }),
      features: this.options.features?.() ?? [SCOPED_SESSIONS_FEATURE],
    });
  }

  /** Says hello again on the open link, e.g. once private chats were turned on here. */
  rehello(): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.hello(this.ws);
  }

  /** Sends a frame now; false when the link is down or the frame was too big to send. */
  sendFrame(frame: RelayConnectorMessage): boolean {
    return this.ws !== null && this.send(this.ws, frame);
  }

  private send(ws: WebSocket, frame: RelayConnectorMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN || this.ws !== ws) return false;
    const text = JSON.stringify(frame);
    // An agent frame too big for the relay is dropped here; the gateway's own limit would
    // otherwise close the whole socket.
    if (Buffer.byteLength(text, 'utf8') > MAX_RELAY_MESSAGE_BYTES) return false;
    ws.send(text);
    return true;
  }

  private touch(ws: WebSocket): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.ws === ws) ws.terminate();
    }, this.options.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS);
  }

  private scheduleReconnect(serverRestart: boolean): void {
    if (this.stopped) return;
    const random = (this.options.random ?? Math.random)();
    const delays = this.options.delaysMs ?? RECONNECT_DELAYS_MS;
    const ceiling = delays[Math.max(0, Math.min(this.attempt, delays.length) - 1)] ?? 1_000;
    // A restart close on a link that was up (attempt 1 after a ready) comes back fast.
    const wait =
      serverRestart && this.attempt <= 1
        ? Math.round(RESTART_RETRY_MS * (1 + random))
        : Math.round(ceiling * random);
    this.options.onStatus?.({ kind: 'disconnected', retryInMs: wait });
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private closeSessions(reason: 'hangup' | 'link' = 'hangup'): void {
    for (const channel of this.sessions.keys()) this.closeChannel(channel, reason);
  }

  private closeChannel(channel: string, reason: 'hangup' | 'link' = 'hangup'): boolean {
    const entry = this.sessions.get(channel);
    if (entry === undefined) return false;
    entry.session.close(reason);
    this.options.pool.release(entry.agent, entry.scope);
    this.sessions.delete(channel);
    return true;
  }
}

function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(data).toString('utf8');
}
