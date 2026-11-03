import type { AddressInfo } from 'node:net';

import {
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_PROTOCOL,
  nativeClientMessageSchema,
  type NativeClientMessage,
  type NativeSessionReady,
} from '@twring/contracts';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Sleep } from './adapter';
import { FakeAgentAdapter } from './fake-agent';

export type FakeNativeMode = 'streamed' | 'instant' | 'delayed' | 'malformed' | 'drop-mid-turn';
export const FAKE_NATIVE_MODES: readonly FakeNativeMode[] = [
  'streamed',
  'instant',
  'delayed',
  'malformed',
  'drop-mid-turn',
];

type UserTurnMessage = Extract<NativeClientMessage, { type: 'user.turn' }>;

export interface FakeTurnContext {
  /** Aborted when Twring sends `turn.cancel` for this turn or the socket closes. */
  signal: AbortSignal;
  /** Sends a frame: objects are JSON-encoded, strings are sent raw (for malformed tests). */
  send(frame: unknown): void;
  /** Kills the connection abruptly, as a crashed agent or dead network would. */
  drop(): void;
}

/** Scripts one reply. The default replays the FakeAgentAdapter's replies in the chosen mode. */
export type FakeTurnScript = (turn: UserTurnMessage, ctx: FakeTurnContext) => Promise<void>;

export interface FakeNativeServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Required bearer token; omit to accept any client. Test value only. */
  token?: string;
  mode?: FakeNativeMode;
  /** How the agent answers `session.hello`. */
  handshake?: 'ok' | 'silent' | 'bad_protocol' | 'session_error';
  capabilities?: NativeSessionReady['capabilities'];
  script?: FakeTurnScript;
  /** Answer pings (default true); false lets tests exercise the pong timeout. */
  answerPings?: boolean;
}

export interface FakeNativeServer {
  url: string;
  port: number;
  /** Every valid message Twring sent, in order. */
  received: NativeClientMessage[];
  /** Drops every open connection. */
  dropClients(): void;
  close(): Promise<void>;
}

const instantSleep: Sleep = (_ms, signal) =>
  signal.aborted ? Promise.reject(signal.reason as Error) : Promise.resolve();

/**
 * A reference `cord-agent/1` agent (ADAPTERS §10): serves the FakeAgentAdapter's scripted replies
 * over the native protocol so Twring can be developed and tested without a real agent.
 */
export async function startFakeNativeServer(
  options: FakeNativeServerOptions = {},
): Promise<FakeNativeServer> {
  const received: NativeClientMessage[] = [];
  const mode = options.mode ?? 'streamed';
  const script = options.script ?? defaultScript(mode);
  const server = new WebSocketServer({
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    maxPayload: MAX_NATIVE_MESSAGE_BYTES,
    verifyClient: (info, done) => {
      if (options.token === undefined) return done(true);
      const auth = info.req.headers.authorization;
      if (auth === `Bearer ${options.token}`) return done(true);
      done(false, 401, 'Unauthorized');
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  server.on('connection', (ws: WebSocket) => {
    ws.on('error', () => undefined);
    const turns = new Map<string, AbortController>();
    const send = (frame: unknown) => {
      if (ws.readyState === ws.OPEN)
        ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    };
    ws.on('close', () => {
      for (const controller of turns.values()) controller.abort();
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
      received.push(message);
      switch (message.type) {
        case 'session.hello':
          handshake(message.protocol);
          return;
        case 'ping':
          if (options.answerPings !== false) send({ type: 'pong', id: message.id });
          return;
        case 'turn.cancel':
          turns.get(message.turn_id)?.abort();
          return;
        case 'approval.decision':
          return;
        case 'user.turn': {
          const controller = new AbortController();
          turns.set(message.turn_id, controller);
          script(message, { signal: controller.signal, send, drop: () => ws.terminate() })
            .catch(() => undefined)
            .finally(() => turns.delete(message.turn_id));
          return;
        }
      }
    });

    function handshake(protocol: string) {
      switch (options.handshake ?? 'ok') {
        case 'silent':
          return;
        case 'session_error':
          send({ type: 'session.error', code: 'auth_failed', message: 'token expired' });
          return;
        case 'bad_protocol':
          send({ type: 'session.ready', protocol: 'cord-agent/2', capabilities: {} });
          return;
        case 'ok':
          send({
            type: 'session.ready',
            protocol: protocol.startsWith('cord-agent/1') ? protocol : NATIVE_PROTOCOL,
            capabilities: options.capabilities ?? {
              streaming_text: true,
              cancel: true,
              activity: true,
              tools: true,
              resume: false,
            },
          });
      }
    }
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://${options.host ?? '127.0.0.1'}:${port}`,
    port,
    received,
    dropClients: () => {
      for (const client of server.clients) client.terminate();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  };
}

function defaultScript(mode: FakeNativeMode): FakeTurnScript {
  return async (turn, ctx) => {
    const agent = new FakeAgentAdapter(
      mode === 'instant' ? { sleep: instantSleep } : mode === 'delayed' ? { thinkMs: 3_000 } : {},
    );
    let sent = 0;
    const stream = agent.sendTurn(
      {
        callId: turn.session_id,
        sessionId: turn.session_id,
        turnId: turn.turn_id,
        role: 'user',
        text: turn.text,
        startedAt: turn.started_at,
        committedAt: turn.committed_at,
      },
      ctx.signal,
    );
    try {
      for await (const event of stream) {
        if (mode === 'malformed' && sent === 1) {
          ctx.send('{"type":"text.delta","turn_id":');
          return;
        }
        if (mode === 'drop-mid-turn' && sent === 3) {
          ctx.drop();
          return;
        }
        ctx.send(event);
        sent += 1;
      }
    } catch {
      if (ctx.signal.aborted) {
        ctx.send({
          type: 'done',
          event_id: 'evt_cancelled',
          turn_id: turn.turn_id,
          status: 'cancelled',
        });
      }
    }
  };
}
