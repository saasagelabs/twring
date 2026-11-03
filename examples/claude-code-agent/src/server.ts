import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_PROTOCOL,
  isSupportedNativeProtocol,
  nativeClientMessageSchema,
  restTurnRequestSchema,
  type AgentEvent,
  type RestTurnRequest,
} from '@twring/contracts';
import { WebSocketServer, type WebSocket } from 'ws';

import type { SpawnClaude } from './claude-command';
import { ClaudeSession } from './session';

export interface ClaudeAgentServerOptions {
  /** Always loopback unless a test says otherwise. */
  host?: string;
  port?: number;
  /** Required bearer token. */
  token: string;
  spawnClaude: SpawnClaude;
  log?(line: string): void;
  initTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** A cord-rest/1 session's Claude process is killed after this long without a turn (10 min). */
  restIdleMs?: number;
  /** SSE heartbeat comment interval while a REST turn runs (15 s). */
  restHeartbeatMs?: number;
  /** A REST request body must arrive within this long (10 s). */
  restBodyTimeoutMs?: number;
}

export interface ClaudeAgentServer {
  /** cord-agent/1 WebSocket endpoint. */
  url: string;
  /** cord-rest/1 turn endpoint, on the same port. */
  restUrl: string;
  port: number;
  close(): Promise<void>;
}

export const REST_TURNS_PATH = '/cord/turns';
const MAX_REST_BODY_BYTES = 65_536;
/** turn_ids remembered per REST session for duplicate refusal; older ones are forgotten. */
const MAX_SEEN_TURN_IDS = 256;

interface RestSession {
  session: ClaudeSession;
  ready: Promise<void>;
  /** Where each running turn's events go (its open SSE response). */
  sinks: Map<string, (event: AgentEvent) => void>;
  /**
   * The last `MAX_SEEN_TURN_IDS` turn_ids accepted (insertion-ordered): a repeated Idempotency-Key
   * is refused, never run twice.
   */
  seen: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * An agent whose brain is the machine's logged-in Claude Code, on one port:
 *
 * - `cord-agent/1` over WebSocket: one Claude process per connection, started at `session.hello`;
 *   `session.ready` is sent only once it is up.
 * - `cord-rest/1` at `POST /cord/turns`: one Claude process per `session_id`, kept across turns and
 *   killed after `restIdleMs` without a turn. Closing a turn's request interrupts that turn.
 */
export async function startClaudeAgentServer(
  options: ClaudeAgentServerOptions,
): Promise<ClaudeAgentServer> {
  if (options.token === '') throw new Error('A bearer token is required');
  const host = options.host ?? '127.0.0.1';
  const sessions = new Set<ClaudeSession>();
  const restSessions = new Map<string, RestSession>();
  const restIdleMs = options.restIdleMs ?? 10 * 60_000;
  const restHeartbeatMs = options.restHeartbeatMs ?? 15_000;
  const restBodyTimeoutMs = options.restBodyTimeoutMs ?? 10_000;
  const expectedAuth = Buffer.from(`Bearer ${options.token}`, 'utf8');
  /** Constant-time for equal lengths; the length itself isn't secret enough to hide. */
  const authorized = (header: string | undefined): boolean => {
    if (header === undefined) return false;
    const given = Buffer.from(header, 'utf8');
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
  };

  const armIdle = (sessionId: string, entry: RestSession) => {
    clearTimeout(entry.idleTimer);
    if (entry.sinks.size > 0) return;
    entry.idleTimer = setTimeout(() => {
      if (entry.sinks.size > 0) return;
      options.log?.('rest session idle; closing its Claude process');
      entry.session.close();
      if (restSessions.get(sessionId) === entry) restSessions.delete(sessionId);
    }, restIdleMs);
  };

  const restSession = (sessionId: string): RestSession => {
    const existing = restSessions.get(sessionId);
    if (existing !== undefined) return existing;
    const sinks = new Map<string, (event: AgentEvent) => void>();
    const session = new ClaudeSession({
      spawnClaude: options.spawnClaude,
      emit: (event) => sinks.get(event.turn_id)?.(event),
      log: (line) => options.log?.(line),
      initTimeoutMs: options.initTimeoutMs,
      interruptTimeoutMs: options.interruptTimeoutMs,
    });
    const entry: RestSession = { session, ready: session.start(), sinks, seen: new Set() };
    entry.ready.catch(() => {
      if (restSessions.get(sessionId) === entry) restSessions.delete(sessionId);
    });
    restSessions.set(sessionId, entry);
    return entry;
  };

  const handleRest = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== REST_TURNS_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    const body = await readBody(req, restBodyTimeoutMs);
    if (body.kind !== 'ok') {
      // Stop reading: answer (when the socket still can), then drop the connection.
      const status = body.kind === 'too_large' ? 413 : 408;
      if (body.kind !== 'error' && !res.headersSent) {
        res.writeHead(status, { Connection: 'close' }).end(() => req.destroy());
      } else {
        req.destroy();
      }
      return;
    }
    let turn: RestTurnRequest;
    try {
      turn = restTurnRequestSchema.parse(JSON.parse(body.text));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const entry = restSession(turn.session_id);
    const turnId = turn.turn_id;
    if (entry.seen.has(turnId)) {
      res.writeHead(409).end();
      return;
    }
    entry.seen.add(turnId);
    if (entry.seen.size > MAX_SEEN_TURN_IDS) {
      const oldest = entry.seen.values().next().value;
      if (oldest !== undefined) entry.seen.delete(oldest);
    }
    clearTimeout(entry.idleTimer);
    let finished = false;
    const heartbeat: { timer?: ReturnType<typeof setInterval> } = {};
    // Registered before Claude is ready so an early hang-up still frees the session for idling.
    entry.sinks.set(turnId, () => undefined);
    res.on('close', () => {
      clearInterval(heartbeat.timer);
      if (finished) return;
      finished = true;
      entry.sinks.delete(turnId);
      // Twring closed the request before `done`: that is its cancel.
      entry.session.cancel(turnId);
      armIdle(turn.session_id, entry);
    });
    try {
      await entry.ready;
    } catch {
      options.log?.('claude failed to start');
      if (!finished) {
        finished = true;
        entry.sinks.delete(turnId);
        res.writeHead(503).end();
      }
      return;
    }
    if (finished) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.flushHeaders();
    heartbeat.timer = setInterval(() => res.write(': hb\n\n'), restHeartbeatMs);
    entry.sinks.set(turnId, (event) => {
      if (finished) return;
      res.write(`event: ${event.type}\nid: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type !== 'done') return;
      finished = true;
      clearInterval(heartbeat.timer);
      entry.sinks.delete(turnId);
      res.end();
      armIdle(turn.session_id, entry);
    });
    entry.session.userTurn(turnId, turn.text);
  };

  const http = createServer((req, res) => void handleRest(req, res));
  const server = new WebSocketServer({
    server: http,
    maxPayload: MAX_NATIVE_MESSAGE_BYTES,
    verifyClient: (info, done) => {
      if (authorized(info.req.headers.authorization)) return done(true);
      done(false, 401, 'Unauthorized');
    },
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, host, () => resolve());
  });

  server.on('connection', (ws: WebSocket) => {
    ws.on('error', () => undefined);
    const send = (frame: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    let session: ClaudeSession | null = null;
    let ready = false;
    ws.on('close', () => {
      if (session !== null) {
        session.close();
        sessions.delete(session);
      }
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      const result = nativeClientMessageSchema.safeParse(parsed);
      if (!result.success) return;
      const message = result.data;
      switch (message.type) {
        case 'ping':
          send({ type: 'pong', id: message.id });
          return;
        case 'session.hello': {
          if (session !== null) return;
          if (!isSupportedNativeProtocol(message.protocol)) {
            send({ type: 'session.error', code: 'protocol_unsupported' });
            return;
          }
          const created = new ClaudeSession({
            spawnClaude: options.spawnClaude,
            emit: send,
            log: (line) => options.log?.(line),
            initTimeoutMs: options.initTimeoutMs,
            interruptTimeoutMs: options.interruptTimeoutMs,
          });
          session = created;
          sessions.add(created);
          created.start().then(
            () => {
              ready = true;
              send({
                type: 'session.ready',
                protocol: message.protocol.startsWith('cord-agent/1')
                  ? message.protocol
                  : NATIVE_PROTOCOL,
                capabilities: {
                  streaming_text: true,
                  cancel: true,
                  activity: false,
                  tools: true,
                  resume: false,
                },
              });
            },
            () => {
              options.log?.('claude failed to start');
              send({ type: 'session.error', code: 'agent_unavailable' });
              ws.close();
            },
          );
          return;
        }
        case 'user.turn':
          if (ready) session?.userTurn(message.turn_id, message.text);
          return;
        case 'turn.cancel':
          session?.cancel(message.turn_id);
          return;
        case 'approval.decision':
          return;
      }
    });
  });

  const port = (http.address() as AddressInfo).port;
  return {
    url: `ws://${host}:${port}`,
    restUrl: `http://${host}:${port}${REST_TURNS_PATH}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sessions) s.close();
        sessions.clear();
        for (const entry of restSessions.values()) {
          clearTimeout(entry.idleTimer);
          entry.session.close();
        }
        restSessions.clear();
        for (const client of server.clients) client.terminate();
        server.close();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

type BodyResult =
  { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'timeout' } | { kind: 'error' };

/** Reads a bounded body within `timeoutMs`; stops reading as soon as it is over the limit. */
function readBody(req: IncomingMessage, timeoutMs: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      if (result.kind !== 'ok') req.pause();
      resolve(result);
    };
    const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs);
    const onData = (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_REST_BODY_BYTES) settle({ kind: 'too_large' });
      else chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => settle({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ kind: 'error' }));
  });
}
