import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { phoneSocketFrameSchema, type ThreadSocketFrame } from '@twring/contracts';
import { WebSocket, WebSocketServer } from 'ws';

import type { RequestAuth } from '../auth';
import { clientIp, rejectUpgrade, type TrustProxy } from '../connectors/routes';
import { FixedWindowLimiter } from '../rate-limit';

export const PHONE_SOCKET_PATH = '/v1/me/socket';
/** Frames are skipped for a socket with more than this still unsent. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface PhoneConnection {
  ws: WebSocket;
  focus: string | null;
  alive: boolean;
  /** When the ping that `alive` waits for went out. */
  pingedAt: number;
  expires: ReturnType<typeof setTimeout>;
}

export interface PhoneSocketOptions {
  auth: Pick<RequestAuth, 'authenticateHeaders'>;
  /** Connects per minute for each signed-in person. */
  ratePerMinute: number;
  /**
   * Connects per minute for each address before sign-in is checked; generous (default 10 times
   * `ratePerMinute`) because many people can share one address (review finding 6).
   */
  ipRatePerMinute?: number;
  trustProxy: TrustProxy;
  pingIntervalMs?: number;
  /**
   * A ping unanswered this long (default 5 s) makes its socket the first pushed out at the
   * per-person cap; a shorter wait could push out a live socket whose pong is on the way.
   */
  unansweredPingMs?: number;
  lifetimeMs?: number;
  log?: { debug(obj: Record<string, unknown>, msg: string): void };
}

export class PhoneSocketHub {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024,
    perMessageDeflate: false,
  });
  private readonly limiter: FixedWindowLimiter;
  private readonly userLimiter: FixedWindowLimiter;
  private readonly users = new Map<string, PhoneConnection[]>();
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private readonly probes = new Map<string, Promise<boolean>>();

  constructor(private readonly options: PhoneSocketOptions) {
    this.limiter = new FixedWindowLimiter(
      options.ipRatePerMinute ?? options.ratePerMinute * 10,
      60_000,
    );
    this.userLimiter = new FixedWindowLimiter(options.ratePerMinute, 60_000);
    this.pingTimer = setInterval(() => this.ping(), options.pingIntervalMs ?? 20_000);
    this.pingTimer.unref();
  }

  upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => undefined);
    if (!this.limiter.tryAcquire(clientIp(request, this.options.trustProxy))) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== 'string' ||
      authorization.length > 8199 ||
      !/^Bearer +\S+$/i.test(authorization.trim())
    ) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    let authenticated: Promise<string | { id: string }>;
    try {
      authenticated = this.options.auth.authenticateHeaders(request.headers);
    } catch {
      // A throwing authenticator must never become an uncaught 'upgrade' exception.
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    authenticated.then(
      (user) => {
        if (socket.destroyed) return;
        const userId = typeof user === 'string' ? user : user.id;
        if (!this.userLimiter.tryAcquire(userId)) {
          rejectUpgrade(socket, 429, 'Too Many Requests');
          return;
        }
        this.wss.handleUpgrade(request, socket, head, (ws) => this.accept(userId, ws));
      },
      (error: unknown) => {
        if (socket.destroyed) return;
        rejectUpgrade(
          socket,
          error instanceof Error && 'status' in error && error.status === 503 ? 503 : 401,
          error instanceof Error && 'status' in error && error.status === 503
            ? 'Service Unavailable'
            : 'Unauthorized',
        );
      },
    );
  };

  private accept(userId: string, ws: WebSocket): void {
    const entries = this.users.get(userId) ?? [];
    // Evicted at once, not when its close handshake ends, so a slow client can't hold the limit. A
    // socket that left its last ping unanswered for 5 s (often one a phone lost on a network
    // change) goes before a live one, whose pong may just be on the way; otherwise the oldest.
    while (entries.length >= 3) {
      const now = Date.now();
      const unanswered = this.options.unansweredPingMs ?? 5_000;
      const stale = entries.findIndex(
        (entry) =>
          entry.ws.readyState !== WebSocket.OPEN ||
          (!entry.alive && now - entry.pingedAt > unanswered),
      );
      entries.splice(stale === -1 ? 0 : stale, 1)[0]?.ws.close(4409, 'Too many connections');
    }
    const connection: PhoneConnection = {
      ws,
      focus: null,
      alive: true,
      pingedAt: 0,
      expires: setTimeout(
        () => ws.close(4401, 'Reconnect with a fresh token'),
        this.options.lifetimeMs ?? 55 * 60_000,
      ),
    };
    connection.expires.unref();
    entries.push(connection);
    this.users.set(userId, entries);
    this.options.log?.debug(
      { event: 'phone_socket_connect', count: entries.length },
      'phone socket connected',
    );
    ws.on('pong', () => {
      connection.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'Binary frames are unsupported');
        return;
      }
      try {
        const text = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8');
        const frame = phoneSocketFrameSchema.safeParse(JSON.parse(text));
        if (frame.success) connection.focus = frame.data.agent_id;
      } catch {
        /* Malformed frames do not affect the connection. */
      }
    });
    ws.on('close', () => {
      clearTimeout(connection.expires);
      const current = this.users.get(userId);
      if (!current) return;
      const index = current.indexOf(connection);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.users.delete(userId);
      this.options.log?.debug(
        { event: 'phone_socket_close', count: current.length },
        'phone socket closed',
      );
    });
    ws.on('error', () => undefined);
  }

  private ping(): void {
    for (const entries of this.users.values()) {
      for (const connection of entries) {
        if (connection.ws.readyState !== WebSocket.OPEN) continue;
        if (!connection.alive) {
          connection.ws.terminate();
          continue;
        }
        connection.alive = false;
        connection.pingedAt = Date.now();
        connection.ws.ping();
      }
    }
  }

  publish(userId: string, frame: ThreadSocketFrame): void {
    try {
      const payload = JSON.stringify(frame);
      for (const connection of this.users.get(userId) ?? []) {
        // A phone that stops reading is skipped, not buffered without bound; it catches up over REST.
        if (
          connection.ws.readyState === WebSocket.OPEN &&
          connection.ws.bufferedAmount <= MAX_BUFFERED_BYTES
        ) {
          try {
            connection.ws.send(payload, () => undefined);
          } catch {
            /* A closed socket catches up over REST. */
          }
        }
      }
    } catch {
      /* Publishing must never disrupt the turn. */
    }
  }

  /**
   * A socket whose last ping went unanswered past `unansweredPingMs` (often one a phone lost when
   * Wi-Fi dropped) no longer counts, the same rule eviction uses in `accept`.
   */
  isFocused(userId: string, agentId: string): boolean {
    return this.focusedConnections(userId, agentId).length > 0;
  }

  /**
   * Whether a phone showing this chat answers a ping within `timeoutMs`, checked just before a
   * push is skipped: a dead socket otherwise counts as focused until the heartbeat reaps it and
   * the reply never reaches the phone. Sockets that stay silent are terminated. Concurrent checks
   * for one chat share a probe; with no focused socket it resolves false at once. The timeout
   * defaults to `unansweredPingMs`, so a slow link the heartbeat keeps is not cut here either.
   */
  confirmFocused(
    userId: string,
    agentId: string,
    timeoutMs = this.options.unansweredPingMs ?? 5_000,
  ): Promise<boolean> {
    const connections = this.focusedConnections(userId, agentId);
    if (connections.length === 0) return Promise.resolve(false);
    const key = `${userId} ${agentId}`;
    const pending = this.probes.get(key);
    if (pending) return pending;
    const probe = new Promise<boolean>((resolve) => {
      const answered = new Set<PhoneConnection>();
      const listeners = new Map<PhoneConnection, () => void>();
      const finish = (result: boolean): void => {
        clearTimeout(timer);
        for (const [connection, listener] of listeners) connection.ws.off('pong', listener);
        resolve(result);
      };
      const timer = setTimeout(() => {
        for (const connection of connections)
          if (!answered.has(connection)) connection.ws.terminate();
        finish(false);
      }, timeoutMs);
      timer.unref();
      for (const connection of connections) {
        // A one-shot listener: the heartbeat's `alive`/`pingedAt` are left to the heartbeat.
        const listener = (): void => {
          answered.add(connection);
          finish(true);
        };
        listeners.set(connection, listener);
        connection.ws.once('pong', listener);
        try {
          connection.ws.ping();
        } catch {
          /* A socket that cannot be pinged stays unanswered. */
        }
      }
    }).finally(() => this.probes.delete(key));
    this.probes.set(key, probe);
    return probe;
  }

  private focusedConnections(userId: string, agentId: string): PhoneConnection[] {
    const now = Date.now();
    const unanswered = this.options.unansweredPingMs ?? 5_000;
    return (this.users.get(userId) ?? []).filter(
      (connection) =>
        connection.ws.readyState === WebSocket.OPEN &&
        connection.focus === agentId &&
        (connection.alive || now - connection.pingedAt <= unanswered),
    );
  }

  closeUser(userId: string): void {
    const entries = this.users.get(userId) ?? [];
    // Forgotten at once: nothing more is published to them while they finish closing.
    this.users.delete(userId);
    for (const connection of entries) {
      clearTimeout(connection.expires);
      connection.ws.close(4403, 'Account data deleted');
    }
  }

  closeAll(): void {
    clearInterval(this.pingTimer);
    for (const entries of this.users.values())
      for (const connection of entries) {
        clearTimeout(connection.expires);
        connection.ws.terminate();
      }
    this.users.clear();
    this.wss.close();
  }
}
