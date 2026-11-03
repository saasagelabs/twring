import type { AddressInfo } from 'node:net';

import { MAX_NATIVE_MESSAGE_BYTES, type AgentEvent, type UserTurn } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { isAdapterError } from './errors';
import { startFakeNativeServer, type FakeNativeServer } from './fake-native-server';
import { MAX_TURN_BACKLOG, NativeWsAdapter, type Timers } from './native-adapter';

// Verifier pass (Milestone 5): races around supersede/cancel/close/reconnect and the pinned path.

const TOKEN = 'edge-token';
const ctx = { callId: 'call_edge', sessionId: 'sess_edge' };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const live = () => new AbortController().signal;

function turn(turnId: string): UserTurn {
  const now = new Date().toISOString();
  return {
    callId: 'call_edge',
    sessionId: 'sess_edge',
    turnId,
    role: 'user',
    text: 'hi',
    startedAt: now,
    committedAt: now,
  };
}

const ev = (turnId: string, n: number, body: Record<string, unknown>) => ({
  event_id: `${turnId}_${n}`,
  turn_id: turnId,
  seq: n,
  ...body,
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

class ManualTimers implements Timers {
  private next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
}

/** A bare cord-agent/1 server whose handshake the test answers by hand. */
async function manualServer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const closed: WebSocket[] = [];
  server.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('error', () => undefined);
    ws.on('close', () => closed.push(ws));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    sockets,
    closed,
    ready(ws: WebSocket) {
      ws.send(
        JSON.stringify({
          type: 'session.ready',
          protocol: 'cord-agent/1',
          capabilities: { streaming_text: true, cancel: true },
        }),
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of server.clients) c.terminate();
        server.close(() => resolve());
      }),
  };
}

describe('NativeWsAdapter edge cases (verifier)', () => {
  let server: FakeNativeServer | null = null;
  let adapter: NativeWsAdapter | null = null;
  const extra: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await adapter?.close();
    await server?.close();
    for (const c of extra.splice(0)) await c();
    adapter = null;
    server = null;
  });

  it('fails a turn whose agent floods events faster than the call reads them (bounded backlog)', async () => {
    server = await startFakeNativeServer({
      token: TOKEN,
      script: async (t, c) => {
        c.send(ev(t.turn_id, 0, { type: 'run.started' }));
        for (let n = 1; n <= MAX_TURN_BACKLOG + 50; n++) {
          c.send(ev(t.turn_id, n, { type: 'activity', label: 'Working' }));
        }
        await tick();
      },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, live());
    const iterator = adapter.sendTurn(turn('t_flood'), live())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'run.started' });
    // The consumer stalls while the agent keeps sending.
    await tick(300);
    let seen = 1;
    const error = await errorOf(
      (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done === true) return;
          seen += 1;
        }
      })(),
    );
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
    expect(seen).toBeLessThanOrEqual(MAX_TURN_BACKLOG + 1);
  });

  it('connects to the pinned address, not whatever the host name resolves to (anti-rebinding)', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'instant' });
    // `.invalid` never resolves (RFC 2606): the socket only works if the pinned lookup is used.
    adapter = new NativeWsAdapter({
      url: `ws://agent.rebind.invalid:${server.port}`,
      token: TOKEN,
      pinnedAddress: { address: '127.0.0.1', family: 4 },
      reconnectDelaysMs: [0],
    });
    await adapter.connect(ctx, live());
    const events = await collect(adapter.sendTurn(turn('t_pin'), live()));
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    // Reconnects stay pinned too.
    server.dropClients();
    await tick(20);
    const again = await collect(adapter.sendTurn(turn('t_pin2'), live()));
    expect(again.at(-1)).toMatchObject({ type: 'done' });
  });

  it('BUG: a consumer that aborts while handling a terminal error event sends turn.cancel for a finished turn', async () => {
    // The gateway does exactly this: on `error` (or `done: failed`) finishAgent() aborts the turn's
    // signal while the adapter's abort listener is still attached (it is removed only in finally).
    server = await startFakeNativeServer({
      token: TOKEN,
      script: async (t, c) => {
        c.send(ev(t.turn_id, 1, { type: 'run.started' }));
        await tick();
        c.send(ev(t.turn_id, 2, { type: 'error', code: 'boom' }));
      },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, live());
    const controller = new AbortController();
    for await (const e of adapter.sendTurn(turn('t_err'), controller.signal)) {
      if (e.type === 'error') controller.abort(new Error('turn finished'));
    }
    await tick(30);
    const cancels = server.received.filter((m) => m.type === 'turn.cancel');
    // AGENT_ADAPTER_SPEC §20 / endTurn doc: "a finished turn is never cancelled".
    expect(cancels).toEqual([]);
  });

  it('BUG: an Error abort reason (as the gateway passes) always goes on the wire as "superseded"', async () => {
    server = await startFakeNativeServer({
      token: TOKEN,
      script: async (t, c) => {
        c.send(ev(t.turn_id, 1, { type: 'run.started' }));
        await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
      },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, live());
    const controller = new AbortController();
    const stream = adapter.sendTurn(turn('t_end'), controller.signal)[Symbol.asyncIterator]();
    await stream.next();
    // ConversationController.stopTurn: `turn.controller.abort(new Error(reason))`, then
    // cancelTurn(id, reason), which is a no-op because the abort already freed the slot.
    controller.abort(new Error('call_ended'));
    await adapter.cancelTurn('t_end', 'call_ended');
    await tick(30);
    const cancel = server.received.find((m) => m.type === 'turn.cancel');
    expect(cancel).toMatchObject({ turn_id: 't_end', reason: 'call_ended' });
  });

  it('a turn superseded while waiting to reconnect is never sent; the next turn reconnects once', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'instant' });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN, reconnectDelaysMs: [40] });
    await adapter.connect(ctx, live());
    server.dropClients();
    await tick(20);
    const a = new AbortController();
    const turnA = errorOf(collect(adapter.sendTurn(turn('t_a'), a.signal)));
    await tick();
    a.abort(new Error('superseded'));
    const b = await collect(adapter.sendTurn(turn('t_b'), live()));
    await turnA;
    expect(b.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    await tick(60);
    const sent = server.received.flatMap((m) =>
      m.type === 'user.turn' ? [m.turn_id] : m.type === 'session.hello' ? ['hello'] : [],
    );
    expect(sent).toEqual(['hello', 'hello', 't_b']);
  });

  it('a mid-turn session.error fails the turn with the mapped code; the next turn reconnects', async () => {
    let n = 0;
    server = await startFakeNativeServer({
      token: TOKEN,
      script: async (t, c) => {
        n += 1;
        c.send(ev(t.turn_id, 1, { type: 'run.started' }));
        await tick();
        if (n === 1) {
          c.send({ type: 'session.error', code: 'rate_limited', message: 'secret detail' });
          return;
        }
        c.send(ev(t.turn_id, 2, { type: 'done', status: 'completed' }));
      },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN, reconnectDelaysMs: [0] });
    await adapter.connect(ctx, live());
    const error = await errorOf(collect(adapter.sendTurn(turn('t1'), live())));
    expect(isAdapterError(error) && error.code).toBe('agent_error');
    expect(String((error as Error).message)).not.toContain('secret detail');
    const next = await collect(adapter.sendTurn(turn('t2'), live()));
    expect(next.at(-1)).toMatchObject({ type: 'done' });
    expect(server.received.filter((m) => m.type === 'user.turn')).toHaveLength(2);
  });

  it('late frames of a superseded turn, even after the next turn starts, never reach it', async () => {
    let first = true;
    server = await startFakeNativeServer({
      token: TOKEN,
      script: async (t, c) => {
        if (first) {
          first = false;
          c.send(ev(t.turn_id, 1, { type: 'run.started' }));
          await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
          await tick(10); // turn B is live by now
          for (let i = 2; i < 6; i += 1)
            c.send(ev(t.turn_id, i, { type: 'text.delta', message_id: 'm', delta: 'LATE' }));
          c.send(ev(t.turn_id, 9, { type: 'done', status: 'completed' }));
          return;
        }
        await tick(30);
        c.send(ev(t.turn_id, 1, { type: 'text.delta', message_id: 'm', delta: 'fresh' }));
        c.send(ev(t.turn_id, 2, { type: 'done', status: 'completed' }));
      },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, live());
    const a = new AbortController();
    const itA = adapter.sendTurn(turn('t_a'), a.signal)[Symbol.asyncIterator]();
    await itA.next();
    a.abort('superseded');
    const b = await collect(adapter.sendTurn(turn('t_b'), live()));
    expect(b.map((e) => (e.type === 'text.delta' ? e.delta : e.type))).toEqual(['fresh', 'done']);
    expect(await itA.next()).toMatchObject({ done: true });
  });

  it('RISK: close() while the handshake is in flight leaves the socket open and a heartbeat armed', async () => {
    const manual = await manualServer();
    extra.push(() => manual.close());
    const timers = new ManualTimers();
    adapter = new NativeWsAdapter({ url: manual.url, token: TOKEN, timers });
    const connecting = errorOf(adapter.connect(ctx, live()));
    for (let i = 0; i < 50 && manual.sockets.length === 0; i += 1) await tick();
    await tick(10); // session.hello has been sent
    await adapter.close();
    manual.ready(manual.sockets[0]!);
    await connecting;
    await tick(30);
    // After close() nothing may stay open or scheduled.
    expect(manual.closed).toHaveLength(1);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([]);
  });

  it('an oversized frame during the handshake fails with protocol_violation (spec §20)', async () => {
    const manual = await manualServer();
    extra.push(() => manual.close());
    adapter = new NativeWsAdapter({ url: manual.url, token: TOKEN });
    const connecting = errorOf(adapter.connect(ctx, live()));
    for (let i = 0; i < 50 && manual.sockets.length === 0; i += 1) await tick();
    await tick(10);
    manual.sockets[0]!.send(
      JSON.stringify({ type: 'session.ready', pad: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES) }),
    );
    const error = await connecting;
    expect(isAdapterError(error) && error.code).toBe('protocol_violation');
  });

  it('an agent answering session.ready twice and pinging junk between turns does not break the next turn', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'instant' });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, live());
    const events = await collect(adapter.sendTurn(turn('t1'), live()));
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    // A second turn on the same socket works and the first turn's slot was freed.
    const second = await collect(adapter.sendTurn(turn('t2'), live()));
    expect(second.every((e) => e.turn_id === 't2')).toBe(true);
    expect(server.received.filter((m) => m.type === 'session.hello')).toHaveLength(1);
  });
});
