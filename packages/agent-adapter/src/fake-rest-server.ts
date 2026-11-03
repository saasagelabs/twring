import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { restTurnRequestSchema, type AgentEvent, type RestTurnRequest } from '@twring/contracts';

import type { Sleep } from './adapter';
import { FakeAgentAdapter } from './fake-agent';

export type FakeRestMode =
  | 'streamed'
  | 'instant'
  | 'json'
  | 'slow-first-byte'
  | 'malformed'
  | 'drop-mid-stream'
  | '401'
  | '500';
export const FAKE_REST_MODES: readonly FakeRestMode[] = [
  'streamed',
  'instant',
  'json',
  'slow-first-byte',
  'malformed',
  'drop-mid-stream',
  '401',
  '500',
];

export interface FakeRestTurnContext {
  /** Aborted when Twring closes the request before the reply ended (its cancel). */
  signal: AbortSignal;
  /** Writes one SSE event (headers go out with the first write). */
  event(type: string, data: unknown, options?: { id?: string }): void;
  /** Writes raw bytes into the SSE stream (for malformed tests). */
  raw(text: string): void;
  /** Writes an SSE comment, e.g. a heartbeat. */
  comment(text?: string): void;
  /** Ends the reply with a final JSON body (the non-streaming fallback). */
  json(body: unknown): void;
  /** Ends the reply with an empty body and this status. */
  status(code: number): void;
  /** Kills the connection abruptly, as a crashed agent or dead network would. */
  drop(): void;
  /** Ends the SSE stream. */
  end(): void;
}

/** Scripts one reply. The default replays the FakeAgentAdapter's replies in the chosen mode. */
export type FakeRestScript = (turn: RestTurnRequest, ctx: FakeRestTurnContext) => Promise<void>;

export interface FakeRestServerOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  /** Request path Twring posts turns to. */
  path?: string;
  /** Required bearer token; omit to accept any client. Test value only. */
  token?: string;
  mode?: FakeRestMode;
  script?: FakeRestScript;
}

export interface FakeRestRequestRecord {
  turnId: string;
  idempotencyKey: string | undefined;
  accept: string | undefined;
}

export interface FakeRestServer {
  url: string;
  port: number;
  /** Every valid turn Twring posted, in order. */
  received: RestTurnRequest[];
  /** Header facts about each valid request, in order. */
  requests: FakeRestRequestRecord[];
  /** turn_ids whose request Twring closed before the reply ended. */
  cancelled: string[];
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 65_536;

const instantSleep: Sleep = (_ms, signal) =>
  signal.aborted ? Promise.reject(signal.reason as Error) : Promise.resolve();

/**
 * A reference `cord-rest/1` agent (ADAPTERS §4, §10): serves the FakeAgentAdapter's scripted
 * replies as SSE (or final JSON) so Twring's REST adapter can be developed and tested without a real
 * agent.
 */
export async function startFakeRestServer(
  options: FakeRestServerOptions = {},
): Promise<FakeRestServer> {
  const path = options.path ?? '/cord/turns';
  const mode = options.mode ?? 'streamed';
  const script = options.script ?? defaultScript(mode);
  const received: RestTurnRequest[] = [];
  const requests: FakeRestRequestRecord[] = [];
  const cancelled: string[] = [];
  const open = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (options.token !== undefined && req.headers.authorization !== `Bearer ${options.token}`) {
      res.writeHead(401).end();
      return;
    }
    const body = await readBody(req);
    let turn: RestTurnRequest;
    try {
      turn = restTurnRequestSchema.parse(JSON.parse(body ?? ''));
    } catch {
      res.writeHead(400).end();
      return;
    }
    received.push(turn);
    requests.push({
      turnId: turn.turn_id,
      idempotencyKey: header(req, 'idempotency-key'),
      accept: header(req, 'accept'),
    });
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        cancelled.push(turn.turn_id);
        controller.abort();
      }
    });
    const startSse = () => {
      if (res.headersSent) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.flushHeaders();
    };
    const write = (text: string) => {
      if (res.writableEnded || res.destroyed) return;
      startSse();
      res.write(text);
    };
    const ctx: FakeRestTurnContext = {
      signal: controller.signal,
      event: (type, data, eventOptions) =>
        write(
          `event: ${type}\n${eventOptions?.id === undefined ? '' : `id: ${eventOptions.id}\n`}data: ${JSON.stringify(data)}\n\n`,
        ),
      raw: write,
      comment: (text = '') => write(`: ${text}\n\n`),
      json: (reply) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
      },
      status: (code) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(code).end();
      },
      drop: () => req.socket.destroy(),
      end: () => {
        if (res.writableEnded || res.destroyed) return;
        startSse();
        res.end();
      },
    };
    try {
      await script(turn, ctx);
    } catch {
      // A cancelled or failed script just stops.
    }
    ctx.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}${path}`,
    port,
    received,
    requests,
    cancelled,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', () => resolve(undefined));
  });
}

/** The event body as sent on the wire: `type` rides in `event:`, `event_id` in `id:`. */
function wireBody(event: AgentEvent): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped on purpose
  const { type, event_id, turn_id, ...body } = event;
  return body;
}

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

function defaultScript(mode: FakeRestMode): FakeRestScript {
  return async (turn, ctx) => {
    if (mode === '401' || mode === '500') {
      ctx.status(Number(mode));
      return;
    }
    if (mode === 'slow-first-byte') await sleepFor(3_000, ctx.signal);
    const agent = new FakeAgentAdapter(
      mode === 'instant' || mode === 'json' ? { sleep: instantSleep } : {},
    );
    const stream = agent.sendTurn(
      {
        callId: turn.call_id,
        sessionId: turn.session_id,
        turnId: turn.turn_id,
        role: 'user',
        text: turn.text,
        startedAt: turn.started_at,
        committedAt: turn.committed_at,
      },
      ctx.signal,
    );
    if (mode === 'json') {
      let text = '';
      let failed = false;
      for await (const event of stream) {
        if (event.type === 'text.delta') text += event.delta;
        if (event.type === 'error') failed = true;
      }
      ctx.json(failed ? { text, status: 'failed' } : { text });
      return;
    }
    let sent = 0;
    for await (const event of stream) {
      if (mode === 'malformed' && sent === 1) {
        ctx.raw('event: text.delta\ndata: {"message_id":\n\n');
        return;
      }
      if (mode === 'drop-mid-stream' && sent === 3) {
        ctx.drop();
        return;
      }
      ctx.event(event.type, wireBody(event), { id: event.event_id });
      sent += 1;
    }
  };
}
