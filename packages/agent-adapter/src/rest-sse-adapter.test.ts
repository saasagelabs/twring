import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  MAX_AGENT_DELTA_CHARS,
  MAX_REST_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  type AgentEvent,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { Sleep } from './adapter';
import {
  conformanceTurn,
  runAdapterConformance,
  type ConformanceScenario,
  type MakeConformanceHarness,
} from './conformance';
import { testAgentConnection } from './connection-test';
import { isAdapterError } from './errors';
import {
  startFakeRestServer,
  type FakeRestScript,
  type FakeRestServer,
  type FakeRestServerOptions,
} from './fake-rest-server';
import { RestSseAdapter, type RestSseAdapterOptions } from './rest-sse-adapter';

const TOKEN = 'test-token';

type Frame = { type: string } & Record<string, unknown>;

const ev = (turnId: string, n: number, body: Frame): Frame => ({
  event_id: `evt_${n}`,
  turn_id: turnId,
  seq: n,
  ...body,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Sends events in order as SSE, with a macrotask between so the client sees them separately. */
const frames =
  (build: (turnId: string) => Frame[]): FakeRestScript =>
  async (turn, ctx) => {
    for (const { type, ...body } of build(turn.turn_id)) {
      ctx.event(type, body);
      await tick();
    }
  };

const answer = (turnId: string, parts: string[]): Frame[] => [
  ev(turnId, 1, { type: 'run.started' }),
  ev(turnId, 2, { type: 'text.start', message_id: 'm' }),
  ...parts.map((delta, i) => ev(turnId, 3 + i, { type: 'text.delta', message_id: 'm', delta })),
  ev(turnId, 3 + parts.length, { type: 'text.end', message_id: 'm' }),
  ev(turnId, 4 + parts.length, { type: 'done', status: 'completed' }),
];

const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

const dropAfterStart: FakeRestScript = async (turn, ctx) => {
  if (turn.turn_id === 't_drop' || turn.turn_id === 't_noresume') {
    ctx.event('run.started', {});
    await tick();
    ctx.drop();
    return;
  }
  await frames((id) => answer(id, ['Back ', 'again.']))(turn, ctx);
};

const streamUntilCancelled: FakeRestScript = async (turn, ctx) => {
  ctx.event('run.started', {});
  ctx.event('text.start', { message_id: 'm' });
  for (let n = 0; !ctx.signal.aborted && n < 500; n += 1) {
    ctx.event('text.delta', { message_id: 'm', delta: 'word ' });
    await tick();
  }
};

let supersedeTurns = 0;
const streamUntilCancelledOnce: FakeRestScript = async (turn, ctx) => {
  supersedeTurns += 1;
  if (supersedeTurns > 1) {
    await frames((id) => answer(id, ['Next ', 'answer.']))(turn, ctx);
    return;
  }
  await streamUntilCancelled(turn, ctx);
};

const SCENARIOS: Record<
  ConformanceScenario,
  { server?: FakeRestServerOptions; adapter?: Partial<RestSseAdapterOptions> }
> = {
  streamed: { server: { mode: 'instant' } },
  single_final: { server: { script: frames((id) => answer(id, ['All in one reply.'])) } },
  empty: {
    server: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 2, { type: 'done', status: 'completed' }),
      ]),
    },
  },
  auth_failure: { adapter: { token: 'wrong-token' } },
  timeout: {
    server: {
      script: async (_turn, ctx) => {
        ctx.comment('open');
        await untilAborted(ctx.signal);
      },
    },
    adapter: { timeouts: { idleMs: 100 } },
  },
  malformed: { server: { mode: 'malformed' } },
  oversized: {
    server: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 2, { type: 'activity', label: 'x', pad: 'y'.repeat(MAX_SSE_EVENT_BYTES) }),
      ]),
    },
  },
  duplicate: {
    server: {
      script: frames((id) => {
        const [start, textStart, delta, ...rest] = answer(id, ['Once.']);
        return [start!, textStart!, delta!, delta!, ...rest];
      }),
    },
  },
  out_of_order: {
    server: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 3, { type: 'text.start', message_id: 'm' }),
        ev(id, 2, { type: 'text.delta', message_id: 'm', delta: 'late' }),
      ]),
    },
  },
  cancellation: { server: { script: streamUntilCancelled } },
  supersede: { server: { script: streamUntilCancelledOnce } },
  late_after_done: {
    server: {
      script: frames((id) => [
        ...answer(id, ['Done.']),
        ev(id, 50, { type: 'text.delta', message_id: 'm', delta: 'ghost' }),
        ev(id, 51, { type: 'done', status: 'completed' }),
      ]),
    },
  },
  disconnect: { server: { script: dropAfterStart } },
  resume_not_declared: { server: { script: dropAfterStart } },
};

const makeHarness: MakeConformanceHarness = async (scenario) => {
  supersedeTurns = 0;
  const config = SCENARIOS[scenario];
  const server = await startFakeRestServer({ token: TOKEN, ...config.server });
  const adapter = new RestSseAdapter({ url: server.url, token: TOKEN, ...config.adapter });
  return {
    adapter,
    failuresSurfaceOn: 'turn',
    receivedTurns: () => server.received.map((t) => t.turn_id),
    receivedCancels: () => [...server.cancelled],
    dispose: () => server.close(),
  };
};

runAdapterConformance('RestSseAdapter', makeHarness);

const ctx = { callId: 'call_1', sessionId: 'sess_1' };
const signal = () => new AbortController().signal;

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

let server: FakeRestServer | undefined;
let raw: Server | undefined;
let adapter: RestSseAdapter | undefined;
afterEach(async () => {
  await adapter?.close();
  await server?.close();
  if (raw !== undefined) {
    raw.closeAllConnections();
    await new Promise((resolve) => raw!.close(resolve));
  }
  adapter = server = raw = undefined;
});

async function setup(
  serverOptions: FakeRestServerOptions,
  adapterOptions: Partial<RestSseAdapterOptions> = {},
) {
  server = await startFakeRestServer({ token: TOKEN, ...serverOptions });
  adapter = new RestSseAdapter({ url: server.url, token: TOKEN, ...adapterOptions });
  await adapter.connect(ctx, signal());
  return { server, adapter };
}

/** A bare HTTP server for responses the fake agent never sends. */
async function rawServer(handler: Parameters<typeof createServer>[1]): Promise<string> {
  raw = createServer(handler);
  await new Promise<void>((resolve) => raw!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(raw.address() as AddressInfo).port}/cord/turns`;
}

describe('RestSseAdapter', () => {
  it('sends surface only when set and accepts a 50,000-character text reply', async () => {
    const { server: agent, adapter: a } = await setup({
      script: frames((id) =>
        answer(
          id,
          Array.from({ length: 13 }, (_, i) => 'x'.repeat(i === 12 ? 2000 : 4000)),
        ),
      ),
    });
    const callError = await errorOf(collect(a.sendTurn(conformanceTurn('t_call'), signal())));
    expect(isAdapterError(callError) && callError.code).toBe('protocol_violation');
    const events = await collect(
      a.sendTurn({ ...conformanceTurn('t_text'), surface: 'text' }, signal()),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(agent.received[0]).not.toHaveProperty('surface');
    expect(agent.received[1]).toHaveProperty('surface', 'text');
  });
  it('posts the cord-rest/1 request with the turn as the Idempotency-Key', async () => {
    const { server: agent, adapter: a } = await setup({ mode: 'instant' });
    const events = await collect(a.sendTurn(conformanceTurn('t_req', 'hello'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(agent.received).toEqual([
      {
        protocol: 'cord-rest/1',
        session_id: 'sess_conf',
        call_id: 'call_1',
        turn_id: 't_req',
        text: 'hello',
        started_at: '2026-09-26T00:00:00.000Z',
        committed_at: '2026-09-26T00:00:01.000Z',
      },
    ]);
    expect(agent.requests[0]).toMatchObject({
      idempotencyKey: 't_req',
      accept: 'text/event-stream, application/json',
    });
    // The wire body left out type/turn_id/event_id: the adapter filled them in.
    expect(events.every((e) => e.turn_id === 't_req')).toBe(true);
    expect(events[0]?.event_id).toBe('evt_1');
    expect(a.capabilities.streamingText).toBe(true);
  });

  it('makes no request at connect and refuses turns before connect or after close', async () => {
    server = await startFakeRestServer({ token: TOKEN });
    adapter = new RestSseAdapter({ url: server.url, token: TOKEN });
    const before = await errorOf(collect(adapter.sendTurn(conformanceTurn('t0'), signal())));
    expect(isAdapterError(before) && before.code).toBe('not_connected');
    await adapter.connect(ctx, signal());
    expect(server.received).toHaveLength(0);
    await adapter.close();
    const after = await errorOf(collect(adapter.sendTurn(conformanceTurn('t1'), signal())));
    expect(isAdapterError(after) && after.code).toBe('not_connected');
  });

  it('rejects non-HTTP URLs', () => {
    expect(() => new RestSseAdapter({ url: 'ws://127.0.0.1/x' })).toThrow(/not allowed/);
    expect(() => new RestSseAdapter({ url: 'not a url' })).toThrow(/not allowed/);
  });

  it('falls back to final JSON and stops claiming streaming for the session', async () => {
    const { adapter: a } = await setup({ mode: 'json' });
    const events = await collect(a.sendTurn(conformanceTurn('t_json', 'hello'), signal()));
    expect(events.map((e) => e.type)).toEqual(['text.start', 'text.delta', 'text.end', 'done']);
    const reply = events[1]?.type === 'text.delta' ? events[1].delta : '';
    expect(reply).toContain("Twring's demo agent");
    expect(a.capabilities.streamingText).toBe(false);
  });

  it('splits a long JSON reply into bounded deltas and maps status failed', async () => {
    const text = 'a'.repeat(MAX_AGENT_DELTA_CHARS * 2 + 5);
    const { adapter: a } = await setup({
      script: (_turn, c) => {
        c.json({ text, status: 'failed' });
        return Promise.resolve();
      },
    });
    const events = await collect(a.sendTurn(conformanceTurn('t_long'), signal()));
    const deltas = events.flatMap((e) => (e.type === 'text.delta' ? [e.delta] : []));
    expect(deltas.map((d) => d.length)).toEqual([MAX_AGENT_DELTA_CHARS, MAX_AGENT_DELTA_CHARS, 5]);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed' });
  });

  it('an empty JSON reply is just done', async () => {
    const { adapter: a } = await setup({
      script: (_turn, c) => {
        c.json({ text: '' });
        return Promise.resolve();
      },
    });
    const events = await collect(a.sendTurn(conformanceTurn('t_e'), signal()));
    expect(events.map((e) => e.type)).toEqual(['done']);
  });

  it.each([
    ['invalid JSON body', 'application/json', '{"text":'],
    ['JSON without text', 'application/json', '{"reply":"hi"}'],
    ['an unexpected content type', 'text/html', '<p>hi</p>'],
  ])('%s is a protocol violation', async (_name, type, body) => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': type }).end(body);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_x'), signal())));
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
  });

  it('maps 500 to agent_error with only the status, never the body', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end('secret stack trace');
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_500'), signal())));
    expect(isAdapterError(error) && error.code).toBe('agent_error');
    expect(String((error as Error).message)).toContain('HTTP 500');
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('does not follow redirects', async () => {
    let hits = 0;
    const url = await rawServer((req, res) => {
      hits += 1;
      res.writeHead(307, { Location: '/elsewhere' }).end();
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_307'), signal())));
    expect(isAdapterError(error) && error.code).toBe('agent_error');
    expect(hits).toBe(1);
  });

  it('maps 403 to auth_failed', async () => {
    const url = await rawServer((_req, res) => res.writeHead(403).end());
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_403'), signal())));
    expect(isAdapterError(error) && error.code).toBe('auth_failed');
  });

  it('an SSE stream that ends without done fails as connection_lost', async () => {
    const { adapter: a } = await setup({
      script: (_turn, c) => {
        c.event('run.started', {});
        return Promise.resolve();
      },
    });
    const error = await errorOf(collect(a.sendTurn(conformanceTurn('t_short'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_lost');
  });

  it('rejects an unknown event type and a type that disagrees with data', async () => {
    for (const bad of [
      'event: thinking\ndata: {}\n\n',
      'event: text.delta\ndata: {"type":"done","status":"completed"}\n\n',
      'data: {"no":"type"}\n\n',
    ]) {
      const { adapter: a } = await setup({
        script: (_turn, c) => {
          c.raw(bad);
          return Promise.resolve();
        },
      });
      const error = await errorOf(collect(a.sendTurn(conformanceTurn('t_bad'), signal())));
      expect(isAdapterError(error) && error.code, bad).toBe('protocol_violation');
      await adapter!.close();
      await server!.close();
    }
    adapter = server = undefined;
  });

  it('accepts the type inside data on a default message event', async () => {
    const { adapter: a } = await setup({
      script: (_turn, c) => {
        c.raw('data: {"type":"done","status":"completed"}\n\n');
        return Promise.resolve();
      },
    });
    const events = await collect(a.sendTurn(conformanceTurn('t_msg'), signal()));
    expect(events).toEqual([
      { type: 'done', status: 'completed', turn_id: 't_msg', event_id: 'cord-auto-1' },
    ]);
  });

  it('heartbeat comments keep a slow turn alive past the idle timeout', async () => {
    const { adapter: a } = await setup(
      {
        script: async (turn, c) => {
          for (let i = 0; i < 6; i += 1) {
            c.comment('hb');
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
          await frames((id) => answer(id, ['Slow but fine.']))(turn, c);
        },
      },
      { timeouts: { idleMs: 150 } },
    );
    const events = await collect(a.sendTurn(conformanceTurn('t_hb'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it('a response larger than the byte limit is a protocol violation', async () => {
    const { server: agent, adapter: a } = await setup({
      script: async (_turn, c) => {
        const chunk = `: ${'x'.repeat(60_000)}\n\n`;
        // Keep writing until Twring hangs up (bounded so a broken test cannot run forever).
        for (let sent = 0; sent <= 20 * MAX_REST_RESPONSE_BYTES && !c.signal.aborted;) {
          c.raw(chunk);
          sent += chunk.length;
          await tick();
        }
      },
    });
    const error = await errorOf(collect(a.sendTurn(conformanceTurn('t_huge'), signal())));
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
    await expect.poll(() => agent.cancelled).toEqual(['t_huge']);
  });

  it('retries once, with the same Idempotency-Key, when the first connection is refused', async () => {
    // Find a free port, then leave it closed until the retry.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    let sleeps = 0;
    const sleep: Sleep = async () => {
      sleeps += 1;
      server = await startFakeRestServer({ token: TOKEN, port, mode: 'instant' });
    };
    adapter = new RestSseAdapter({
      url: `http://127.0.0.1:${port}/cord/turns`,
      token: TOKEN,
      sleep,
    });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_retry'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(sleeps).toBe(1);
    expect(server!.requests.map((r) => r.idempotencyKey)).toEqual(['t_retry']);
  });

  it('gives up after one retry when the agent stays unreachable', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    let sleeps = 0;
    adapter = new RestSseAdapter({
      url: `http://127.0.0.1:${port}/cord/turns`,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_down'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_failed');
    expect(isAdapterError(error) && error.retryable).toBe(true);
    expect(sleeps).toBe(1);
  });

  it('never retries once the request may have reached the agent', async () => {
    const { server: agent, adapter: a } = await setup({ mode: 'drop-mid-stream' });
    const error = await errorOf(collect(a.sendTurn(conformanceTurn('t_mid', 'hello'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_lost');
    expect(agent.received.map((t) => t.turn_id)).toEqual(['t_mid']);
  });

  it('connects to the pinned address while keeping the URL host name', async () => {
    let host: string | undefined;
    const url = await rawServer((req, res) => {
      host = req.headers.host;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"text":"hi"}');
    });
    const port = new URL(url).port;
    adapter = new RestSseAdapter({
      url: `http://agent.invalid:${port}/cord/turns`,
      pinnedAddress: { address: '127.0.0.1', family: 4 },
    });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_pin'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(host).toBe(`agent.invalid:${port}`);
  });

  it('close() fails an in-flight turn with not_connected and destroys the request', async () => {
    const { server: agent, adapter: a } = await setup({ script: streamUntilCancelled });
    const iterator = a.sendTurn(conformanceTurn('t_close'), signal())[Symbol.asyncIterator]();
    await iterator.next();
    await a.close();
    const error = await errorOf(
      (async () => {
        for (;;) if ((await iterator.next()).done === true) return;
      })(),
    );
    expect(isAdapterError(error) && error.code).toBe('not_connected');
    await expect.poll(() => agent.cancelled).toEqual(['t_close']);
  });

  it('an abort before the response arrives ends the turn quietly and cancels the request', async () => {
    const { server: agent, adapter: a } = await setup({ mode: 'slow-first-byte' });
    const controller = new AbortController();
    const done = collect(a.sendTurn(conformanceTurn('t_early'), controller.signal));
    await expect.poll(() => agent.received.length).toBe(1);
    controller.abort('barge_in');
    expect(await done).toEqual([]);
    await expect.poll(() => agent.cancelled).toEqual(['t_early']);
  });

  it('refuses protocol headers in the extra headers', () => {
    expect(
      () => new RestSseAdapter({ url: 'http://127.0.0.1/x', headers: { 'Idempotency-Key': 'x' } }),
    ).toThrow(/cannot be configured/);
  });

  it('the connection test reports streaming, final-JSON, and bad-token agents', async () => {
    server = await startFakeRestServer({ token: TOKEN, mode: 'instant' });
    const url = server.url;
    const ok = await testAgentConnection(() => new RestSseAdapter({ url, token: TOKEN }));
    expect(ok).toMatchObject({ reachable: true, authenticated: true, streamingObserved: true });
    const denied = await testAgentConnection(() => new RestSseAdapter({ url, token: 'nope' }));
    expect(denied).toMatchObject({ reachable: true, authenticated: false });
    expect(denied.safeMessage).not.toContain('nope');
    await server.close();
    server = await startFakeRestServer({ token: TOKEN, mode: 'json' });
    const jsonUrl = server.url;
    const json = await testAgentConnection(
      () => new RestSseAdapter({ url: jsonUrl, token: TOKEN }),
    );
    expect(json).toMatchObject({ authenticated: true, streamingObserved: false });
  });
});
