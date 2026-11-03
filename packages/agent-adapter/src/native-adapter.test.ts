import { MAX_NATIVE_MESSAGE_BYTES, type AgentEvent } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  conformanceTurn,
  runAdapterConformance,
  type ConformanceScenario,
  type MakeConformanceHarness,
} from './conformance';
import { testAgentConnection } from './connection-test';
import { isAdapterError } from './errors';
import {
  startFakeNativeServer,
  type FakeNativeServer,
  type FakeNativeServerOptions,
  type FakeTurnScript,
} from './fake-native-server';
import { NativeWsAdapter, type NativeWsAdapterOptions, type Timers } from './native-adapter';

const TOKEN = 'test-token';

const ev = (turnId: string, n: number, body: Record<string, unknown>) => ({
  event_id: `evt_${n}`,
  turn_id: turnId,
  seq: n,
  ...body,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Sends frames in order, with a macrotask between so the client sees them separately. */
const frames =
  (build: (turnId: string) => unknown[]): FakeTurnScript =>
  async (turn, ctx) => {
    for (const frame of build(turn.turn_id)) {
      ctx.send(frame);
      await tick();
    }
  };

const answer = (turnId: string, parts: string[]) => [
  ev(turnId, 1, { type: 'run.started' }),
  ev(turnId, 2, { type: 'text.start', message_id: 'm' }),
  ...parts.map((delta, i) => ev(turnId, 3 + i, { type: 'text.delta', message_id: 'm', delta })),
  ev(turnId, 3 + parts.length, { type: 'text.end', message_id: 'm' }),
  ev(turnId, 4 + parts.length, { type: 'done', status: 'completed' }),
];

const dropAfterStart: FakeTurnScript = async (turn, ctx) => {
  if (turn.turn_id === 't_drop' || turn.turn_id === 't_noresume') {
    ctx.send(ev(turn.turn_id, 1, { type: 'run.started' }));
    await tick();
    ctx.drop();
    return;
  }
  await frames((id) => answer(id, ['Back ', 'again.']))(turn, ctx);
};

/** The first turn streams until cancelled, then keeps sending late frames; later turns answer. */
let supersedeTurns = 0;
const streamUntilCancelledOnce: FakeTurnScript = async (turn, ctx) => {
  supersedeTurns += 1;
  if (supersedeTurns > 1) {
    await frames((id) => answer(id, ['Next ', 'answer.']))(turn, ctx);
    return;
  }
  const id = turn.turn_id;
  ctx.send(ev(id, 1, { type: 'run.started' }));
  ctx.send(ev(id, 2, { type: 'text.start', message_id: 'm' }));
  let n = 3;
  for (; !ctx.signal.aborted && n < 500; n += 1) {
    ctx.send(ev(id, n, { type: 'text.delta', message_id: 'm', delta: 'word ' }));
    await tick();
  }
  // A real agent finishes its current chunk before honouring the cancel.
  for (let late = 0; late < 3; late += 1) {
    ctx.send(ev(id, n + late, { type: 'text.delta', message_id: 'm', delta: 'late ' }));
    await tick();
  }
  ctx.send(ev(id, n + 3, { type: 'done', status: 'cancelled' }));
};

const SCENARIOS: Record<
  ConformanceScenario,
  { server?: FakeNativeServerOptions; adapter?: Partial<NativeWsAdapterOptions> }
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
  timeout: { server: { handshake: 'silent' }, adapter: { timeouts: { handshakeMs: 100 } } },
  malformed: { server: { mode: 'malformed' } },
  oversized: {
    server: {
      script: frames((id) => [
        ev(id, 1, { type: 'run.started' }),
        ev(id, 2, { type: 'activity', label: 'x', pad: 'y'.repeat(MAX_NATIVE_MESSAGE_BYTES) }),
      ]),
    },
  },
  duplicate: {
    server: {
      script: frames((id) => {
        const [start, textStart, delta, ...rest] = answer(id, ['Once.']);
        return [start, textStart, delta, delta, ...rest];
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
  cancellation: {
    server: {
      script: async (turn, ctx) => {
        ctx.send(ev(turn.turn_id, 1, { type: 'run.started' }));
        ctx.send(ev(turn.turn_id, 2, { type: 'text.start', message_id: 'm' }));
        for (let n = 3; !ctx.signal.aborted && n < 500; n += 1) {
          ctx.send(ev(turn.turn_id, n, { type: 'text.delta', message_id: 'm', delta: 'word ' }));
          await tick();
        }
        ctx.send(ev(turn.turn_id, 999, { type: 'done', status: 'cancelled' }));
      },
    },
  },
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
  resume_not_declared: {
    server: {
      script: dropAfterStart,
      capabilities: { streaming_text: true, cancel: true, resume: false },
    },
  },
};

const makeHarness: MakeConformanceHarness = async (scenario) => {
  supersedeTurns = 0;
  const config = SCENARIOS[scenario];
  const server = await startFakeNativeServer({ token: TOKEN, ...config.server });
  const adapter = new NativeWsAdapter({
    url: server.url,
    token: TOKEN,
    reconnectDelaysMs: [0],
    ...config.adapter,
  });
  return {
    adapter,
    receivedTurns: () =>
      server.received.flatMap((m) => (m.type === 'user.turn' ? [m.turn_id] : [])),
    receivedCancels: () =>
      server.received.flatMap((m) => (m.type === 'turn.cancel' ? [m.turn_id] : [])),
    dispose: () => server.close(),
  };
};

runAdapterConformance('NativeWsAdapter', makeHarness);

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

/** Manual timers: tests fire them explicitly. */
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
  fire(ms: number): boolean {
    for (const [id, timer] of this.pending) {
      if (timer.ms === ms) {
        this.pending.delete(id);
        timer.fn();
        return true;
      }
    }
    return false;
  }
}

describe('NativeWsAdapter', () => {
  it('sends surface only when set and accepts a 50,000-character text reply', async () => {
    server = await startFakeNativeServer({
      token: TOKEN,
      script: frames((id) =>
        answer(
          id,
          Array.from({ length: 13 }, (_, i) => 'x'.repeat(i === 12 ? 2000 : 4000)),
        ),
      ),
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, signal());
    const callError = await errorOf(collect(adapter.sendTurn(conformanceTurn('t_call'), signal())));
    expect(isAdapterError(callError) && callError.code).toBe('protocol_violation');
    expect(
      (
        await collect(adapter.sendTurn({ ...conformanceTurn('t_text'), surface: 'text' }, signal()))
      ).at(-1),
    ).toMatchObject({ type: 'done', status: 'completed' });
    const turns = server.received.filter((m) => m.type === 'user.turn');
    expect(turns[0]).not.toHaveProperty('surface');
    expect(turns[1]).toHaveProperty('surface', 'text');
  });
  let server: FakeNativeServer | null = null;
  let adapter: NativeWsAdapter | null = null;
  afterEach(async () => {
    await adapter?.close();
    await server?.close();
    adapter = null;
    server = null;
  });

  it('sends the token only as a bearer header and maps declared capabilities', async () => {
    server = await startFakeNativeServer({
      token: TOKEN,
      mode: 'instant',
      capabilities: { streaming_text: true, cancel: false, activity: true },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    expect(adapter.capabilities.streamingText).toBe(false);
    await adapter.connect(ctx, signal());
    expect(adapter.capabilities).toMatchObject({
      streamingText: true,
      cancellation: false,
      activityEvents: true,
      toolEvents: false,
      resumableStream: false,
      approvals: false,
    });
    expect(server.received[0]).toMatchObject({
      type: 'session.hello',
      protocol: 'cord-agent/1',
      session_id: 'sess_1',
      call_id: 'call_1',
    });
  });

  it('does not send turn.cancel when the agent did not declare cancel', async () => {
    server = await startFakeNativeServer({
      token: TOKEN,
      capabilities: { streaming_text: true },
    });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, signal());
    const controller = new AbortController();
    for await (const event of adapter.sendTurn(conformanceTurn('t1'), controller.signal)) {
      if (event.type === 'run.started') controller.abort();
    }
    await adapter.cancelTurn('t1', 'barge_in');
    await tick();
    expect(server.received.some((m) => m.type === 'turn.cancel')).toBe(false);
  });

  it('superseding a turn mid-stream lets the next turn start at once (device regression)', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'streamed' });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, signal());
    const controller = new AbortController();
    const turnA = adapter.sendTurn(conformanceTurn('t_a'), controller.signal);
    const first = turnA[Symbol.asyncIterator]();
    for (;;) {
      const step = await first.next();
      if (step.done === true) throw new Error('turn A ended before streaming text');
      if (step.value.type === 'text.delta') break;
    }
    // Same order as the gateway's supersede: abort A, cancelTurn(A), sendTurn(B) immediately.
    controller.abort('superseded');
    await adapter.cancelTurn('t_a', 'superseded');
    const second = await collect(adapter.sendTurn(conformanceTurn('t_b'), signal()));
    expect(second.length).toBeGreaterThan(1);
    expect(second.every((e) => e.turn_id === 't_b')).toBe(true);
    expect(second.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(await first.next()).toMatchObject({ done: true });
    const sent = server.received.flatMap((m) =>
      m.type === 'user.turn' || m.type === 'turn.cancel' ? [`${m.type}:${m.turn_id}`] : [],
    );
    expect(sent).toEqual(['user.turn:t_a', 'turn.cancel:t_a', 'user.turn:t_b']);
  });

  it('rejects an unsupported protocol major version', async () => {
    server = await startFakeNativeServer({ token: TOKEN, handshake: 'bad_protocol' });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    const error = await errorOf(adapter.connect(ctx, signal()));
    expect(isAdapterError(error) && error.code).toBe('protocol_unsupported');
  });

  it("maps session.error to the agent's code without echoing its message", async () => {
    server = await startFakeNativeServer({ token: TOKEN, handshake: 'session_error' });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    const error = await errorOf(adapter.connect(ctx, signal()));
    expect(isAdapterError(error) && error.code).toBe('auth_failed');
    expect(String((error as Error).message)).not.toContain('token expired');
  });

  it('fails with connection_failed when nothing is listening', async () => {
    const probe = await startFakeNativeServer();
    const url = probe.url;
    await probe.close();
    adapter = new NativeWsAdapter({ url, reconnectDelaysMs: [0] });
    const error = await errorOf(adapter.connect(ctx, signal()));
    expect(isAdapterError(error) && error.code).toBe('connection_failed');
  });

  it('refuses connection-level headers', () => {
    expect(() => new NativeWsAdapter({ url: 'ws://x', headers: { Host: 'evil' } })).toThrow();
    expect(
      () => new NativeWsAdapter({ url: 'ws://x', headers: { 'X-Api-Key': 'k' } }),
    ).not.toThrow();
  });

  it('declares the connection dead when a ping goes unanswered, failing the turn', async () => {
    const timers = new ManualTimers();
    server = await startFakeNativeServer({
      token: TOKEN,
      answerPings: false,
      script: async (_turn, c) => {
        await new Promise((resolve) => c.signal.addEventListener('abort', resolve));
      },
    });
    adapter = new NativeWsAdapter({
      url: server.url,
      token: TOKEN,
      timers,
      timeouts: { heartbeatMs: 111, pongTimeoutMs: 222 },
    });
    await adapter.connect(ctx, signal());
    const turn = errorOf(collect(adapter.sendTurn(conformanceTurn('t_hb'), signal())));
    await tick();
    expect(timers.fire(111)).toBe(true);
    await tick();
    expect(server.received.some((m) => m.type === 'ping')).toBe(true);
    expect(timers.fire(222)).toBe(true);
    const error = await turn;
    expect(isAdapterError(error) && error.code).toBe('connection_lost');
  });

  it('keeps the heartbeat going while pongs arrive', async () => {
    const timers = new ManualTimers();
    server = await startFakeNativeServer({ token: TOKEN });
    adapter = new NativeWsAdapter({
      url: server.url,
      token: TOKEN,
      timers,
      timeouts: { heartbeatMs: 111, pongTimeoutMs: 222 },
    });
    await adapter.connect(ctx, signal());
    expect(timers.fire(111)).toBe(true);
    for (let i = 0; i < 20 && ![...timers.pending.values()].some((t) => t.ms === 111); i += 1)
      await tick();
    // Pong cleared the pong timer and scheduled the next ping.
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([111]);
  });

  it('close is idempotent and further turns fail with not_connected', async () => {
    server = await startFakeNativeServer({ token: TOKEN });
    adapter = new NativeWsAdapter({ url: server.url, token: TOKEN });
    await adapter.connect(ctx, signal());
    await adapter.close();
    await adapter.close();
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t'), signal())));
    expect(isAdapterError(error) && error.code).toBe('not_connected');
  });

  it('gives up reconnecting after the bounded attempts', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'instant' });
    const sleeps: number[] = [];
    adapter = new NativeWsAdapter({
      url: server.url,
      token: TOKEN,
      reconnectDelaysMs: [1, 2, 3],
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await adapter.connect(ctx, signal());
    await server.close();
    server = null;
    await tick();
    const error = await errorOf(collect(adapter.sendTurn(conformanceTurn('t'), signal())));
    expect(isAdapterError(error) && error.code).toBe('connection_failed');
    expect(sleeps).toEqual([1, 2, 3]);
  });
});

describe('testAgentConnection', () => {
  let server: FakeNativeServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('reports a healthy streaming agent', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'instant' });
    const url = server.url;
    const result = await testAgentConnection(() => new NativeWsAdapter({ url, token: TOKEN }));
    expect(result).toMatchObject({
      reachable: true,
      authenticated: true,
      protocolValid: true,
      streamingObserved: true,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.capabilities?.streamingText).toBe(true);
  });

  it('reports bad credentials without echoing them', async () => {
    server = await startFakeNativeServer({ token: TOKEN });
    const url = server.url;
    const result = await testAgentConnection(
      () => new NativeWsAdapter({ url, token: 'super-secret-wrong' }),
    );
    expect(result).toMatchObject({ reachable: true, authenticated: false });
    expect(JSON.stringify(result)).not.toContain('super-secret-wrong');
  });

  it('reports an unreachable agent', async () => {
    const probe = await startFakeNativeServer();
    const url = probe.url;
    await probe.close();
    const result = await testAgentConnection(() => new NativeWsAdapter({ url }));
    expect(result).toMatchObject({ reachable: false, authenticated: false });
  });

  it('reports a malformed reply as an invalid protocol', async () => {
    server = await startFakeNativeServer({ token: TOKEN, mode: 'malformed' });
    const url = server.url;
    const result = await testAgentConnection(() => new NativeWsAdapter({ url, token: TOKEN }));
    expect(result).toMatchObject({ reachable: true, authenticated: true, protocolValid: false });
  });
});
