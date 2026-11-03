import type { AgentEvent, UserTurn } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import type { TwringAgentAdapter } from './adapter';
import { isAdapterError } from './errors';

/**
 * AGENT_ADAPTER_SPEC §18 conformance suite. Import from `@twring/agent-adapter/conformance` inside a
 * vitest file and supply a harness that makes the agent behave as each scenario describes.
 */
export type ConformanceScenario =
  /** Several `text.delta`s, then `done: completed`. */
  | 'streamed'
  /** Exactly one `text.delta`, then `done: completed`. */
  | 'single_final'
  /** `done: completed` with no text. */
  | 'empty'
  /** Credentials rejected (at connect, or at the first turn for connectionless adapters). */
  | 'auth_failure'
  /**
   * Never answers the handshake (harness sets a short handshake timeout); for connectionless
   * adapters, goes silent mid-turn (harness sets a short idle timeout).
   */
  | 'timeout'
  /** A frame that isn't valid JSON / a valid event mid-turn. */
  | 'malformed'
  /** A frame larger than the protocol's size bound mid-turn. */
  | 'oversized'
  /** The same `event_id` sent twice; one text delta between. */
  | 'duplicate'
  /** A `seq` that goes backwards mid-turn. */
  | 'out_of_order'
  /** Streams slowly until cancelled; declares cancellation. */
  | 'cancellation'
  /**
   * The first turn streams slowly until cancelled and may keep sending frames for it afterwards;
   * later turns answer normally. Declares cancellation.
   */
  | 'supersede'
  /** Sends events for the turn after its `done`; answers later turns normally. */
  | 'late_after_done'
  /** Drops the connection mid-turn, answers normally after reconnect. */
  | 'disconnect'
  /** Declares no resume; drops the connection mid-turn. */
  | 'resume_not_declared';

export interface ConformanceHarness {
  adapter: TwringAgentAdapter;
  /**
   * Where auth and timeout failures surface. `connect` (default) for adapters that hold a
   * session; `turn` for request-per-turn adapters (REST), whose `connect` makes no request.
   */
  failuresSurfaceOn?: 'connect' | 'turn';
  /** turn_ids of every user turn the agent received, in order. */
  receivedTurns(): string[];
  /** turn_ids of every cancel the agent received. */
  receivedCancels(): string[];
  dispose(): Promise<void>;
}

export type MakeConformanceHarness = (scenario: ConformanceScenario) => Promise<ConformanceHarness>;

const context = { callId: 'call_conf', sessionId: 'sess_conf' };

export function conformanceTurn(turnId: string, text = 'Hello there'): UserTurn {
  return {
    callId: context.callId,
    sessionId: context.sessionId,
    turnId,
    role: 'user',
    text,
    startedAt: '2026-09-26T00:00:00.000Z',
    committedAt: '2026-09-26T00:00:01.000Z',
  };
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function expectAdapterError(
  promise: Promise<unknown>,
  code: string,
  retryable?: boolean,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAdapterError(error), `expected AdapterError(${code}), got ${String(error)}`).toBe(true);
  if (!isAdapterError(error)) return;
  expect(error.code).toBe(code);
  if (retryable !== undefined) expect(error.retryable).toBe(retryable);
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const deltas = (events: AgentEvent[]) => events.filter((e) => e.type === 'text.delta');

export function runAdapterConformance(describeName: string, make: MakeConformanceHarness): void {
  describe(`${describeName}: adapter conformance (AGENT_ADAPTER_SPEC §18)`, () => {
    let harness: ConformanceHarness | null = null;
    const setup = async (scenario: ConformanceScenario, connect = true) => {
      harness = await make(scenario);
      if (connect) await harness.adapter.connect(context, new AbortController().signal);
      return harness;
    };
    const signal = () => new AbortController().signal;

    afterEach(async () => {
      await harness?.adapter.close();
      await harness?.dispose();
      harness = null;
    });

    it('valid streamed answer', async () => {
      const { adapter } = await setup('streamed');
      const events = await collect(adapter.sendTurn(conformanceTurn('t_stream'), signal()));
      expect(deltas(events).length).toBeGreaterThan(1);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
      expect(events.every((e) => e.turn_id === 't_stream')).toBe(true);
    });

    it('single final answer', async () => {
      const { adapter } = await setup('single_final');
      const events = await collect(adapter.sendTurn(conformanceTurn('t_final'), signal()));
      expect(deltas(events)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    });

    it('empty answer', async () => {
      const { adapter } = await setup('empty');
      const events = await collect(adapter.sendTurn(conformanceTurn('t_empty'), signal()));
      expect(deltas(events)).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    });

    /** Connect, or for a connectionless adapter connect then run one turn. */
    const firstContact = async (h: ConformanceHarness, turnId: string) => {
      await h.adapter.connect(context, signal());
      if (h.failuresSurfaceOn === 'turn') {
        await collect(h.adapter.sendTurn(conformanceTurn(turnId), signal()));
      }
    };

    it('auth failure fails with auth_failed', async () => {
      const h = await setup('auth_failure', false);
      await expectAdapterError(firstContact(h, 't_auth'), 'auth_failed', false);
    });

    it('timeout fails with a retryable timeout', async () => {
      const h = await setup('timeout', false);
      await expectAdapterError(firstContact(h, 't_timeout'), 'timeout', true);
    });

    it('malformed event fails the turn', async () => {
      const { adapter } = await setup('malformed');
      await expectAdapterError(
        collect(adapter.sendTurn(conformanceTurn('t_bad'), signal())),
        'protocol_violation',
        false,
      );
    });

    it('oversized event fails the turn', async () => {
      const { adapter } = await setup('oversized');
      await expectAdapterError(
        collect(adapter.sendTurn(conformanceTurn('t_big'), signal())),
        'protocol_violation',
        false,
      );
    });

    it('duplicate event is delivered once', async () => {
      const { adapter } = await setup('duplicate');
      const events = await collect(adapter.sendTurn(conformanceTurn('t_dup'), signal()));
      const ids = events.map((e) => e.event_id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(events.at(-1)?.type).toBe('done');
    });

    it('out-of-order event fails the turn instead of inventing order', async () => {
      const { adapter } = await setup('out_of_order');
      await expectAdapterError(
        collect(adapter.sendTurn(conformanceTurn('t_ooo'), signal())),
        'protocol_violation',
      );
    });

    it('cancellation stops the stream and tells the agent', async () => {
      const h = await setup('cancellation');
      expect(h.adapter.capabilities.cancellation).toBe(true);
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      for await (const event of h.adapter.sendTurn(
        conformanceTurn('t_cancel'),
        controller.signal,
      )) {
        events.push(event);
        if (event.type === 'text.delta') controller.abort('barge_in');
      }
      expect(events.some((e) => e.type === 'done')).toBe(false);
      await waitFor(() => h.receivedCancels().includes('t_cancel'));
    });

    it('supersede mid-stream then next turn', async () => {
      const h = await setup('supersede');
      const controller = new AbortController();
      const first = h.adapter.sendTurn(conformanceTurn('t_sup_a'), controller.signal);
      const iterator = first[Symbol.asyncIterator]();
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) throw new Error('first turn ended before streaming text');
        if (step.value.type === 'text.delta') break;
      }
      // The caller's next turn commits while A is still streaming: abort A, start B at once.
      controller.abort('superseded');
      const second = await collect(h.adapter.sendTurn(conformanceTurn('t_sup_b'), signal()));
      expect(second.every((e) => e.turn_id === 't_sup_b')).toBe(true);
      expect(second.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
      expect(await iterator.next()).toMatchObject({ done: true });
      await waitFor(() => h.receivedCancels().includes('t_sup_a'));
      expect(h.receivedTurns()).toEqual(['t_sup_a', 't_sup_b']);
      expect(h.receivedCancels()).toEqual(['t_sup_a']);
    });

    it('late events after done are dropped and do not leak into the next turn', async () => {
      const { adapter } = await setup('late_after_done');
      const first = await collect(adapter.sendTurn(conformanceTurn('t_late_1'), signal()));
      expect(first.at(-1)?.type).toBe('done');
      const second = await collect(adapter.sendTurn(conformanceTurn('t_late_2'), signal()));
      expect(second.every((e) => e.turn_id === 't_late_2')).toBe(true);
      expect(second.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    });

    it('disconnect mid-turn fails retryably, never resends, and reconnects between turns', async () => {
      const h = await setup('disconnect');
      await expectAdapterError(
        collect(h.adapter.sendTurn(conformanceTurn('t_drop'), signal())),
        'connection_lost',
        true,
      );
      const next = await collect(h.adapter.sendTurn(conformanceTurn('t_after'), signal()));
      expect(next.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
      expect(h.receivedTurns().filter((id) => id === 't_drop')).toHaveLength(1);
    });

    it('without declared resume, an interrupted stream fails honestly', async () => {
      const h = await setup('resume_not_declared');
      expect(h.adapter.capabilities.resumableStream).toBe(false);
      await expectAdapterError(
        collect(h.adapter.sendTurn(conformanceTurn('t_noresume'), signal())),
        'connection_lost',
      );
      expect(h.receivedTurns()).toEqual(['t_noresume']);
    });
  });
}
