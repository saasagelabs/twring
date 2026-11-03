import { createServer, type Server } from 'node:http';
import {
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
} from 'node:net';

import { MAX_REST_RESPONSE_BYTES, MAX_SSE_EVENT_BYTES, type AgentEvent } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { Sleep } from './adapter';
import { conformanceTurn } from './conformance';
import { testAgentConnection } from './connection-test';
import { isAdapterError } from './errors';
import { startFakeRestServer, type FakeRestServer } from './fake-rest-server';
import type { Timers } from './native-adapter';
import { RestSseAdapter } from './rest-sse-adapter';

// Verifier edge cases for RestSseAdapter (Milestone 6): retry safety, timers, limits, content
// types, pinned addresses, abort/late events.

const ctx = { callId: 'call_1', sessionId: 'sess_1' };
const signal = () => new AbortController().signal;
const TOKEN = 'test-token';

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

const within = <T>(ms: number, promise: Promise<T>): Promise<T | 'hung'> =>
  Promise.race([promise, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

let raws: (Server | NetServer)[] = [];
let adapter: RestSseAdapter | undefined;
let fake: FakeRestServer | undefined;
afterEach(async () => {
  await adapter?.close();
  await fake?.close();
  for (const s of raws) {
    if ('closeAllConnections' in s) s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  raws = [];
  adapter = fake = undefined;
});

async function rawServer(
  handler: Parameters<typeof createServer>[1],
  host = '127.0.0.1',
): Promise<{ url: string; port: number }> {
  const s = createServer(handler);
  raws.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, host, resolve);
  });
  const port = (s.address() as AddressInfo).port;
  const h = host.includes(':') ? `[${host}]` : host;
  return { url: `http://${h}:${port}/cord/turns`, port };
}

const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const DONE = sse('done', { status: 'completed' });

/** Counts live timers so a test can prove every exit path cleans up. */
function countingTimers() {
  const live = new Set<ReturnType<typeof setTimeout>>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(() => {
        live.delete(handle);
        fn();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle === null || handle === undefined) return;
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      live.delete(handle as ReturnType<typeof setTimeout>);
    },
  };
  return { timers, live };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('RestSseAdapter edge cases', () => {
  // BUG: SseParser.end() throws SseLimitError for an unterminated line of exactly the limit
  // followed by a partial UTF-8 byte; the adapter calls it in res.on('end') with no try/catch.
  // The throw escapes as an uncaught exception (would take down the gateway process) and the turn
  // never settles: the idle timer was already cleared and 'end' is never queued.
  it('a stream ending in an unterminated max-length line with a partial code point fails the turn', async () => {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const body = Buffer.alloc(MAX_SSE_EVENT_BYTES + 1, 0x78);
      body[MAX_SSE_EVENT_BYTES] = 0xe2;
      res.end(body);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const result = await within(
      2_000,
      errorOf(collect(adapter.sendTurn(conformanceTurn('t_endthrow'), signal()))),
    );
    expect(result !== 'hung' && isAdapterError(result) && result.code).toBe('protocol_violation');
  });

  it('never retries when the socket connected and was then reset before any response', async () => {
    let connections = 0;
    const s = createNetServer((socket) => {
      connections += 1;
      socket.resetAndDestroy();
    });
    raws.push(s);
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
    const port = (s.address() as AddressInfo).port;
    let sleeps = 0;
    adapter = new RestSseAdapter({
      url: `http://127.0.0.1:${port}/cord/turns`,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_rst'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_failed');
    expect(sleeps).toBe(0);
    expect(connections).toBe(1);
  });

  it('never retries when the agent read the request and hung up without answering', async () => {
    let bodies = 0;
    const { url } = await rawServer((req) => {
      req.on('data', () => undefined);
      req.on('end', () => {
        bodies += 1;
        req.socket.destroy();
      });
    });
    let sleeps = 0;
    adapter = new RestSseAdapter({
      url,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_hup'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_failed');
    expect(sleeps).toBe(0);
    expect(bodies).toBe(1);
  });

  it('an abort during the retry wait never makes the second attempt, even if sleep ignores it', async () => {
    const port = await freePort();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const sleep: Sleep = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    adapter = new RestSseAdapter({ url: `http://127.0.0.1:${port}/cord/turns`, sleep });
    await adapter.connect(ctx, signal());
    const done = collect(adapter.sendTurn(conformanceTurn('t_abort_retry'), controller.signal));
    await expect.poll(() => release !== undefined).toBe(true);
    fake = await startFakeRestServer({ port, mode: 'instant' });
    controller.abort('barge_in');
    expect(await done).toEqual([]);
    release!();
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.received).toHaveLength(0);
  });

  it('clears every timer on completion, abort, failure, and close', async () => {
    const { timers, live } = countingTimers();
    fake = await startFakeRestServer({
      token: TOKEN,
      script: async (turn, c) => {
        if (turn.turn_id === 't_hold' || turn.turn_id === 't_close') {
          c.event('run.started', {});
          await new Promise<void>((resolve) => c.signal.addEventListener('abort', () => resolve()));
          return;
        }
        if (turn.turn_id === 't_500') {
          c.status(500);
          return;
        }
        c.event('run.started', {});
        c.event('done', { status: 'completed' });
        await Promise.resolve();
      },
    });
    adapter = new RestSseAdapter({ url: fake.url, token: TOKEN, timers });
    await adapter.connect(ctx, signal());

    await collect(adapter.sendTurn(conformanceTurn('t_ok'), signal()));
    expect(live.size).toBe(0);

    await errorOf(collect(adapter.sendTurn(conformanceTurn('t_500'), signal())));
    expect(live.size).toBe(0);

    const controller = new AbortController();
    const holding = adapter.sendTurn(conformanceTurn('t_hold'), controller.signal);
    const it1 = holding[Symbol.asyncIterator]();
    await it1.next();
    controller.abort('barge_in');
    expect(await it1.next()).toMatchObject({ done: true });
    expect(live.size).toBe(0);

    const it2 = adapter.sendTurn(conformanceTurn('t_close'), signal())[Symbol.asyncIterator]();
    await it2.next();
    await adapter.close();
    await errorOf(it2.next());
    expect(live.size).toBe(0);
  });

  it('a consumer that breaks early destroys the request and leaves no timers', async () => {
    const { timers, live } = countingTimers();
    fake = await startFakeRestServer({
      script: async (_turn, c) => {
        c.event('run.started', {});
        c.event('text.start', { message_id: 'm' });
        await new Promise<void>((resolve) => c.signal.addEventListener('abort', () => resolve()));
      },
    });
    adapter = new RestSseAdapter({ url: fake.url, timers });
    await adapter.connect(ctx, signal());
    for await (const event of adapter.sendTurn(conformanceTurn('t_break'), signal())) {
      if (event.type === 'run.started') break;
    }
    expect(live.size).toBe(0);
    await expect.poll(() => fake!.cancelled).toEqual(['t_break']);
  });

  it('no event leaks after an abort mid-stream, and the next turn is answered', async () => {
    let turns = 0;
    fake = await startFakeRestServer({
      script: async (turn, c) => {
        turns += 1;
        c.event('run.started', {});
        c.event('text.start', { message_id: 'm' });
        if (turns === 1) {
          for (let i = 0; i < 200 && !c.signal.aborted; i += 1) {
            c.event('text.delta', { message_id: 'm', delta: `w${i} ` });
            await new Promise((r) => setTimeout(r, 2));
          }
          return;
        }
        c.event('text.delta', { message_id: 'm', delta: 'second' });
        c.event('text.end', { message_id: 'm' });
        c.event('done', { status: 'completed' });
        await Promise.resolve();
      },
    });
    const a = new RestSseAdapter({ url: fake.url });
    adapter = a;
    await a.connect(ctx, signal());
    const controller = new AbortController();
    const seen: AgentEvent[] = [];
    const first = (async () => {
      for await (const event of a.sendTurn(conformanceTurn('t_a'), controller.signal)) {
        seen.push(event);
        if (event.type === 'text.delta') controller.abort('superseded');
      }
    })();
    await first;
    const after = seen.length;
    const second = await collect(adapter.sendTurn(conformanceTurn('t_b'), signal()));
    expect(seen.length).toBe(after);
    expect(seen.filter((e) => e.type === 'text.delta')).toHaveLength(1);
    expect(second.every((e) => e.turn_id === 't_b')).toBe(true);
    expect(second.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    await expect.poll(() => fake!.cancelled).toEqual(['t_a']);
  });

  it.each([
    ['text/event-stream; charset=utf-8', DONE],
    ['Text/Event-Stream;charset=UTF-8', DONE],
    ['application/json; charset=utf-8', '{"text":"hi"}'],
    ['APPLICATION/JSON', '{"text":"hi"}'],
  ])('accepts content type %s', async (type, body) => {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': type }).end(body);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_ct'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it.each([
    ['no content type', undefined],
    ['text/plain', 'text/plain'],
    ['application/json-seq', 'application/json-seq'],
    ['application/problem+json', 'application/problem+json'],
  ])('%s is a protocol violation', async (_name, type) => {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, type === undefined ? {} : { 'Content-Type': type }).end(DONE);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_badct'), signal())));
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
  });

  it('a final JSON body over 1 MiB is a protocol violation and the request is destroyed', async () => {
    let closedEarly = false;
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.on('close', () => (closedEarly = !res.writableEnded));
      const chunk = 'x'.repeat(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (sent <= 4 * MAX_REST_RESPONSE_BYTES && !res.destroyed) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        if (!res.destroyed) res.end();
      };
      res.write('{"text":"');
      pump();
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_bigjson'), signal())));
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
    await expect.poll(() => closedEarly).toBe(true);
    // Only a final JSON body that validates proves the agent doesn't stream.
    expect(adapter.capabilities.streamingText).toBe(true);
  });

  it('a JSON body of exactly 1 MiB is accepted (extra fields ignored)', async () => {
    const prefix = '{"text":"hi","pad":"';
    const suffix = '"}';
    const pad = 'y'.repeat(MAX_REST_RESPONSE_BYTES - prefix.length - suffix.length);
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(`${prefix}${pad}${suffix}`);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_1mib'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it('non-2xx bodies and redirect targets never reach the error', async () => {
    for (const [status, headers] of [
      [302, { Location: 'http://169.254.169.254/latest/meta-data' }],
      [429, { 'Retry-After': '1' }],
      [401, {}],
    ] as const) {
      const { url } = await rawServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'text/plain', ...headers }).end('secret-body-xyz');
      });
      const a = new RestSseAdapter({ url, token: 'secret-token-abc' });
      await a.connect(ctx, signal());
      const error = await errorOf(collect(a.sendTurn(conformanceTurn('t_s'), signal())));
      const dump = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
      expect(dump).not.toContain('secret-body-xyz');
      expect(dump).not.toContain('169.254');
      expect(dump).not.toContain('secret-token-abc');
      expect(dump).not.toContain('127.0.0.1');
      await a.close();
    }
  });

  it('an SSE event id and turn_id from the agent win over the defaults; a foreign turn_id is dropped', async () => {
    const { url } = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: run.started\nid: agent_1\ndata: {}\n\n`);
      res.write(sse('text.start', { message_id: 'm', turn_id: 'someone_else' }));
      res.end(DONE);
    });
    adapter = new RestSseAdapter({ url });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_ids'), signal()));
    expect(events.map((e) => [e.type, e.event_id])).toEqual([
      ['run.started', 'agent_1'],
      ['done', 'cord-auto-3'],
    ]);
  });

  it('connects to a pinned IPv6 address while keeping the URL host name', async (context) => {
    let host: string | undefined;
    let server: { url: string; port: number };
    try {
      server = await rawServer((req, res) => {
        host = req.headers.host;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"text":"hi"}');
      }, '::1');
    } catch {
      context.skip();
      return;
    }
    adapter = new RestSseAdapter({
      url: `http://agent.invalid:${server.port}/cord/turns`,
      pinnedAddress: { address: '::1', family: 6 },
    });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_v6'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(host).toBe(`agent.invalid:${server.port}`);
  });

  it('a pinned address is used for every attempt, including the retry (no DNS)', async () => {
    const port = await freePort();
    let sleeps = 0;
    adapter = new RestSseAdapter({
      url: `http://agent.invalid:${port}/cord/turns`,
      pinnedAddress: { address: '127.0.0.1', family: 4 },
      sleep: async () => {
        sleeps += 1;
        fake = await startFakeRestServer({ port, mode: 'instant' });
      },
    });
    await adapter.connect(ctx, signal());
    const events = await collect(adapter.sendTurn(conformanceTurn('t_pinretry'), signal()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(sleeps).toBe(1);
  });

  it('two concurrent turns on one adapter do not cross streams', async () => {
    fake = await startFakeRestServer({
      script: async (turn, c) => {
        c.event('run.started', {});
        await new Promise((r) => setTimeout(r, turn.turn_id === 't_x' ? 30 : 5));
        c.event('done', { status: 'completed' });
      },
    });
    adapter = new RestSseAdapter({ url: fake.url });
    await adapter.connect(ctx, signal());
    const [x, y] = await Promise.all([
      collect(adapter.sendTurn(conformanceTurn('t_x'), signal())),
      collect(adapter.sendTurn(conformanceTurn('t_y'), signal())),
    ]);
    expect(x.every((e) => e.turn_id === 't_x')).toBe(true);
    expect(y.every((e) => e.turn_id === 't_y')).toBe(true);
  });

  // Minor: a REST agent that accepts the connection but never answers is reported by the
  // connection test as `authenticated: true`, although no response (and so no auth verdict) came.
  it('the connection test does not claim authentication when the agent never answered', async () => {
    const { url } = await rawServer((req) => {
      req.resume();
    });
    const result = await testAgentConnection(() => new RestSseAdapter({ url }), {
      probeTimeoutMs: 200,
    });
    expect(result.authenticated).toBe(false);
  });
});
