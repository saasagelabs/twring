import { EventEmitter } from 'node:events';

import {
  isSupportedNativeProtocol,
  isSupportedRelayProtocol,
  MAX_RELAY_CHANNELS,
  MAX_RELAY_MESSAGE_BYTES,
  RELAY_CLOSE,
  RELAY_PROTOCOL,
  relayConnectorMessageSchema,
  SCOPED_SESSIONS_FEATURE,
  type LocalAgent,
  type RelayGatewayMessage,
} from '@twring/contracts';
import type WebSocket from 'ws';

import { newChannelId } from './pairing';

/**
 * The live connector sockets (ADR-023), in memory: `connectorId → socket`. One gateway process
 * (BACKEND_SPEC §1), so no cross-process routing; see ADR-023 for what scaling out would need.
 */

export interface HubLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

export interface ConnectorHubOptions {
  features?: string[];
  /** Server ping interval; a ping unanswered by the next one ends the socket. */
  heartbeatMs?: number;
  /** How long a new socket may take to send `connector.hello`. */
  helloTimeoutMs?: number;
  /**
   * Runs after a valid hello: records the agents offered and the time. Resolves false when the
   * connector was revoked meanwhile, which closes the socket.
   */
  onHello?: (connectorId: string, agents: LocalAgent[]) => Promise<boolean>;
  logger?: HubLogger;
}

/** Who a socket authenticated as. */
export interface ConnectorIdentity {
  connectorId: string;
  userId: string;
  name: string;
  /** The address the socket came from (compared on replacement, never logged). */
  address?: string;
}

/**
 * The `ws`-shaped end of one relay channel that `NativeWsAdapter` drives as if it were a direct
 * agent socket: its `cord-agent/1` frames are wrapped in `channel.message` envelopes and carried
 * over the connector's socket. Everything the adapter enforces (handshake, heartbeat, the stream
 * guard, size limits, never resending a turn) applies unchanged.
 */
export class RelayChannelSocket extends EventEmitter {
  private closed = false;

  constructor(
    readonly channel: string,
    private readonly forward: (frame: RelayGatewayMessage) => void,
    private readonly onClosed: () => void,
  ) {
    super();
    queueMicrotask(() => {
      if (!this.closed) this.emit('open');
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(data: string): void {
    if (this.closed) throw new Error('relay channel closed');
    const message = JSON.parse(data) as Record<string, unknown>;
    this.forward({ type: 'channel.message', channel: this.channel, message });
  }

  close(): void {
    this.shut(true);
  }

  terminate(): void {
    this.shut(true);
  }

  /** A frame from the connector for this channel; the adapter validates it. */
  deliver(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.emit('message', Buffer.from(JSON.stringify(message), 'utf8'), false);
  }

  /** The connector closed the channel, or its socket went away. */
  remoteClosed(): void {
    this.shut(false);
  }

  private shut(notify: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.onClosed();
    if (notify) {
      try {
        this.forward({ type: 'channel.close', channel: this.channel });
      } catch {
        // The connector socket is already gone.
      }
    }
    queueMicrotask(() => this.emit('close', 1000, Buffer.alloc(0)));
  }
}

/**
 * Stands in for a channel when the computer is not connected: it answers `session.hello` with
 * `session.error agent_offline`, so every connect path reports the same stable code. With
 * `agent_not_on_computer`, the computer is connected but its latest hello left the agent out.
 */
export class OfflineSocket extends EventEmitter {
  constructor(private readonly code: 'agent_offline' | 'agent_not_on_computer' = 'agent_offline') {
    super();
    queueMicrotask(() => this.emit('open'));
  }

  send(data: string): void {
    const message = JSON.parse(data) as { type?: unknown };
    if (message.type !== 'session.hello') return;
    queueMicrotask(() =>
      this.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'session.error', code: this.code })),
        false,
      ),
    );
  }

  close(): void {
    // Nothing to close.
  }

  terminate(): void {
    // Nothing to close.
  }
}

interface LiveConnector extends ConnectorIdentity {
  ws: WebSocket;
  ready: boolean;
  agents: LocalAgent[];
  /** What the computer said it supports in its latest hello. */
  features: ReadonlySet<string>;
  channels: Map<string, RelayChannelSocket>;
  heartbeat?: ReturnType<typeof setInterval>;
  helloTimer?: ReturnType<typeof setTimeout>;
  awaitingPong: boolean;
}

export class ConnectorHub {
  private readonly live = new Map<string, LiveConnector>();
  /** When each computer last dropped, since this server started (re-link staleness). */
  private readonly dropped = new Map<string, number>();
  private readonly heartbeatMs: number;
  private readonly helloTimeoutMs: number;
  private onReplaced?: (identity: ConnectorIdentity) => void;

  constructor(private readonly options: ConnectorHubOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? 20_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  }

  /**
   * Self-hosted only: told when a live computer link is replaced by a socket from another address
   * (its token may be in someone else's hands). Hosted Twring sets none, so nothing changes there.
   */
  setReplacedListener(listener: (identity: ConnectorIdentity) => void): void {
    this.onReplaced = listener;
  }

  /** Takes over an authenticated socket. A second socket for the same connector replaces the first. */
  accept(ws: WebSocket, identity: ConnectorIdentity): void {
    const previous = this.live.get(identity.connectorId);
    if (previous !== undefined) {
      this.drop(previous, RELAY_CLOSE.replaced, 'replaced');
      if (
        this.onReplaced !== undefined &&
        previous.address !== undefined &&
        identity.address !== undefined &&
        previous.address !== identity.address
      ) {
        this.options.logger?.warn(
          { event: 'connector_replaced', connector_id: identity.connectorId },
          'a computer link was opened from another address',
        );
        this.onReplaced(identity);
      }
    }
    const entry: LiveConnector = {
      ...identity,
      ws,
      ready: false,
      agents: [],
      features: new Set(),
      channels: new Map(),
      awaitingPong: false,
    };
    this.live.set(identity.connectorId, entry);
    entry.helloTimer = setTimeout(
      () => this.drop(entry, RELAY_CLOSE.protocolError, 'no hello'),
      this.helloTimeoutMs,
    );
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      try {
        this.onMessage(entry, data, isBinary);
      } catch {
        this.drop(entry, RELAY_CLOSE.protocolError, 'bad frame');
      }
    });
    ws.on('pong', () => {
      entry.awaitingPong = false;
    });
    ws.on('error', () => undefined);
    ws.on('close', () => this.release(entry));
    entry.heartbeat = setInterval(() => {
      if (entry.awaitingPong) {
        ws.terminate();
        return;
      }
      entry.awaitingPong = true;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, this.heartbeatMs);
  }

  /** True when the user's own connector is connected and has said hello. */
  /** When this computer last dropped, if it has since this server started. */
  droppedAt(connectorId: string): number | undefined {
    return this.dropped.get(connectorId);
  }

  /**
   * Whether a connected computer supports `feature` (from its hello); undefined when it is not
   * connected, so nothing is known.
   */
  supports(connectorId: string, feature: string): boolean | undefined {
    const entry = this.live.get(connectorId);
    return entry === undefined || !entry.ready ? undefined : entry.features.has(feature);
  }

  isOnline(userId: string, connectorId: string): boolean {
    const entry = this.live.get(connectorId);
    return entry !== undefined && entry.ready && entry.userId === userId;
  }

  /**
   * Whether a call to `localAgent` on the user's connector can start: `online`, `offline` (not
   * connected, or not this user's), or `agent_missing` (connected, but its latest hello does not
   * offer that agent any more).
   */
  agentStatus(
    userId: string,
    connectorId: string,
    localAgent: string,
  ): 'online' | 'offline' | 'agent_missing' {
    const entry = this.live.get(connectorId);
    if (entry === undefined || !entry.ready || entry.userId !== userId) return 'offline';
    return entry.agents.some((agent) => agent.id === localAgent) ? 'online' : 'agent_missing';
  }

  /**
   * The socket a `cord-connector` adapter drives for one call. Never another user's connector:
   * an unknown, foreign, or offline connector gets an `OfflineSocket`.
   */
  socketFor(
    userId: string,
    connectorId: string,
    localAgent: string,
    resumeRef?: string,
    freshSession = false,
    sessionScope?: string,
  ): RelayChannelSocket | OfflineSocket {
    const entry = this.live.get(connectorId);
    if (entry === undefined || !entry.ready || entry.userId !== userId) return new OfflineSocket();
    // Someone else's session on a computer that cannot keep one apart: never the owner's session.
    if (sessionScope !== undefined && !entry.features.has(SCOPED_SESSIONS_FEATURE)) {
      return new OfflineSocket();
    }
    if (entry.channels.size >= MAX_RELAY_CHANNELS) return new OfflineSocket();
    if (!entry.agents.some((agent) => agent.id === localAgent)) {
      return new OfflineSocket('agent_not_on_computer');
    }
    const channel = newChannelId();
    const send = (frame: RelayGatewayMessage) => {
      if (this.live.get(connectorId) !== entry) throw new Error('connector gone');
      entry.ws.send(JSON.stringify(frame));
    };
    const socket = new RelayChannelSocket(channel, send, () => entry.channels.delete(channel));
    entry.channels.set(channel, socket);
    try {
      send({
        type: 'channel.open',
        channel,
        agent: localAgent,
        ...(freshSession
          ? { fresh_session: true as const }
          : resumeRef !== undefined
            ? { resume_ref: resumeRef }
            : {}),
        ...(sessionScope !== undefined && { session_scope: sessionScope }),
      });
    } catch {
      socket.remoteClosed();
    }
    return socket;
  }

  /** Ends a connector's socket (revoked). Resolves nothing; calls on it fail as connection lost. */
  disconnect(connectorId: string, code: number = RELAY_CLOSE.revoked): void {
    const entry = this.live.get(connectorId);
    if (entry !== undefined) this.drop(entry, code, 'revoked');
  }

  disconnectUser(userId: string): void {
    for (const entry of [...this.live.values()]) {
      if (entry.userId === userId) this.drop(entry, RELAY_CLOSE.revoked, 'revoked');
    }
  }

  /** Every socket, at shutdown. */
  closeAll(): void {
    for (const entry of [...this.live.values()]) this.drop(entry, 1001, 'shutting down');
  }

  private onMessage(entry: LiveConnector, data: WebSocket.RawData, isBinary: boolean): void {
    if (isBinary) throw new Error('binary frame');
    const buffer = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data);
    if (buffer.byteLength > MAX_RELAY_MESSAGE_BYTES) throw new Error('oversized frame');
    const parsed = relayConnectorMessageSchema.safeParse(JSON.parse(buffer.toString('utf8')));
    if (!parsed.success) throw new Error('malformed frame');
    const message = parsed.data;
    if (!entry.ready) {
      if (
        message.type !== 'connector.hello' ||
        !isSupportedRelayProtocol(message.protocol) ||
        !isSupportedNativeProtocol(message.agent_protocol)
      ) {
        throw new Error('expected hello');
      }
      clearTimeout(entry.helloTimer);
      entry.agents = message.agents;
      entry.features = new Set(message.features ?? []);
      void this.greet(entry, message.agents);
      return;
    }
    switch (message.type) {
      case 'connector.hello':
        // A repeated hello updates the agent list (in memory now, and in the store so the app
        // sees it) and changes nothing else.
        entry.agents = message.agents;
        entry.features = new Set(message.features ?? []);
        void this.persistAgents(entry, message.agents);
        return;
      case 'channel.message':
        entry.channels.get(message.channel)?.deliver(message.message);
        return;
      case 'channel.close':
        entry.channels.get(message.channel)?.remoteClosed();
        return;
    }
  }

  private async greet(entry: LiveConnector, agents: LocalAgent[]): Promise<void> {
    let allowed: boolean;
    try {
      allowed = (await this.options.onHello?.(entry.connectorId, agents)) ?? true;
    } catch {
      allowed = true; // A store hiccup must not block the connector; auth already passed.
    }
    if (this.live.get(entry.connectorId) !== entry) return;
    if (!allowed) {
      this.drop(entry, RELAY_CLOSE.revoked, 'revoked');
      return;
    }
    entry.ready = true;
    const ready: RelayGatewayMessage = {
      type: 'connector.ready',
      ...(this.options.features && { features: this.options.features }),
      protocol: RELAY_PROTOCOL,
      connector_id: entry.connectorId,
      name: entry.name,
    };
    entry.ws.send(JSON.stringify(ready));
    this.options.logger?.info(
      { event: 'connector_connected', connector_id: entry.connectorId, agents: agents.length },
      'connector connected',
    );
  }

  /** Records a repeated hello's agent list; a connector revoked meanwhile is closed. */
  private async persistAgents(entry: LiveConnector, agents: LocalAgent[]): Promise<void> {
    let allowed: boolean;
    try {
      allowed = (await this.options.onHello?.(entry.connectorId, agents)) ?? true;
    } catch {
      return; // A store hiccup must not drop a working connector.
    }
    if (!allowed && this.live.get(entry.connectorId) === entry) {
      this.drop(entry, RELAY_CLOSE.revoked, 'revoked');
    }
  }

  private drop(entry: LiveConnector, code: number, reason: string): void {
    this.release(entry);
    try {
      entry.ws.close(code, reason);
    } catch {
      entry.ws.terminate();
    }
  }

  private release(entry: LiveConnector): void {
    clearTimeout(entry.helloTimer);
    clearInterval(entry.heartbeat);
    if (this.live.get(entry.connectorId) !== entry) return;
    this.live.delete(entry.connectorId);
    for (const channel of [...entry.channels.values()]) channel.remoteClosed();
    entry.channels.clear();
    if (entry.ready) {
      this.dropped.set(entry.connectorId, Date.now());
      this.options.logger?.info(
        { event: 'connector_disconnected', connector_id: entry.connectorId },
        'connector disconnected',
      );
    }
  }
}
