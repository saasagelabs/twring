import {
  MAX_ACTIVITY_LABEL_CHARS,
  MAX_AGENT_DELTA_CHARS,
  type AgentEvent,
  type UserTurn,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { Sleep } from './adapter';
import { DEMO_FALLBACKS, FakeAgentAdapter, fakeReply, toDeltas } from './fake-agent';
import { RepeatAgentAdapter } from './repeat-agent';
import {
  AgentStreamGuard,
  MAX_AGENT_TURN_TEXT_CHARS,
  MAX_TEXT_TURN_TEXT_CHARS,
} from './stream-guard';

const turn = (text: string, turnId = 'turn_1'): UserTurn => ({
  callId: 'call_1',
  sessionId: 'call_1',
  turnId,
  role: 'user',
  text,
  startedAt: '2026-09-26T00:00:00.000Z',
  committedAt: '2026-09-26T00:00:01.000Z',
});

/** Sleeps resolve immediately but still honour abort. */
const instant: Sleep = (_ms, signal) =>
  signal.aborted ? Promise.reject(signal.reason as Error) : Promise.resolve();

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const text = (events: AgentEvent[]) =>
  events.map((e) => (e.type === 'text.delta' ? e.delta : '')).join('');

describe('FakeAgentAdapter', () => {
  it('streams a reply in small deltas with increasing seq, ending in done', async () => {
    const agent = new FakeAgentAdapter({ sleep: instant });
    const events = await collect(
      agent.sendTurn(turn('How is it going'), new AbortController().signal),
    );
    expect(events[0]?.type).toBe('run.started');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(events.filter((e) => e.type === 'text.delta').length).toBeGreaterThan(3);
    expect(text(events)).toBe(DEMO_FALLBACKS[0]);
    expect(text(events)).not.toContain('How is it going');
    const seqs = events.map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    expect(events.every((e) => e.turn_id === 'turn_1')).toBe(true);
  });

  it('reports a pretend tool call before answering when asked to check something', async () => {
    const agent = new FakeAgentAdapter({ sleep: instant });
    const types = (
      await collect(agent.sendTurn(turn('Can you check my calendar'), new AbortController().signal))
    ).map((e) => e.type);
    expect(types.slice(0, 4)).toEqual(['run.started', 'tool.start', 'tool.end', 'text.start']);
  });

  it('rotates demo replies deterministically instead of repeating the caller', async () => {
    const agent = new FakeAgentAdapter({ sleep: instant });
    const replies: string[] = [];
    for (let i = 0; i < DEMO_FALLBACKS.length + 1; i += 1) {
      replies.push(
        text(
          await collect(
            agent.sendTurn(turn('What is the capital of Peru'), new AbortController().signal),
          ),
        ),
      );
    }
    expect(replies.slice(0, DEMO_FALLBACKS.length)).toEqual(DEMO_FALLBACKS);
    expect(replies.at(-1)).toBe(DEMO_FALLBACKS[0]);
    for (const reply of replies) {
      expect(reply).toMatch(/demo/);
      expect(reply).not.toMatch(/You said|Peru|[*`#[\]]/);
    }
  });

  it('stops streaming once aborted', async () => {
    const controller = new AbortController();
    const agent = new FakeAgentAdapter({ sleep: instant });
    const events: AgentEvent[] = [];
    await expect(
      (async () => {
        for await (const event of agent.sendTurn(turn('tell me a story'), controller.signal)) {
          events.push(event);
          if (event.type === 'text.delta') controller.abort();
        }
      })(),
    ).rejects.toThrow();
    expect(events.filter((e) => e.type === 'text.delta')).toHaveLength(1);
  });

  it('ends with an agent error for "simulate a failure"', async () => {
    const agent = new FakeAgentAdapter({ sleep: instant });
    const events = await collect(
      agent.sendTurn(turn('please simulate a failure'), new AbortController().signal),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'fake_failure' });
  });

  it('never answers "simulate silence" until aborted', async () => {
    const controller = new AbortController();
    const agent = new FakeAgentAdapter({ sleep: instant });
    const pending = collect(agent.sendTurn(turn('simulate silence'), controller.signal));
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('splits text into 1–3 word deltas that rejoin exactly', () => {
    const source = 'one two three four five six seven';
    expect(toDeltas(source).join('')).toBe(source);
    expect(toDeltas(source)).toEqual(['one ', 'two three ', 'four five six ', 'seven']);
  });

  it('rotates follow-ups deterministically', () => {
    expect(fakeReply('x', 1).text).not.toBe(fakeReply('x', 2).text);
    expect(fakeReply('x', 1).text).toBe(fakeReply('x', 5).text);
  });
});

describe('RepeatAgentAdapter', () => {
  it('says back exactly what it heard, in one piece', async () => {
    const events = await collect(new RepeatAgentAdapter().sendTurn(turn('  hello there ')));
    expect(events.map((e) => e.type)).toEqual(['text.start', 'text.delta', 'text.end', 'done']);
    expect(text(events)).toBe('You said: hello there');
  });
});

describe('AgentStreamGuard', () => {
  const delta = (id: string, seq?: number, turnId = 'turn_1', value = 'hi'): AgentEvent => ({
    type: 'text.delta',
    event_id: id,
    turn_id: turnId,
    message_id: 'm',
    delta: value,
    ...(seq !== undefined && { seq }),
  });

  it('passes a well-formed stream through', () => {
    const guard = new AgentStreamGuard('turn_1');
    expect(guard.accept(delta('a', 1)).kind).toBe('event');
    expect(guard.accept(delta('b', 2)).kind).toBe('event');
    expect(guard.accept(delta('c')).kind).toBe('event'); // seq is optional
  });

  it('drops duplicates, other turns, and anything after done', () => {
    const guard = new AgentStreamGuard('turn_1');
    guard.accept(delta('a', 1));
    expect(guard.accept(delta('a', 1))).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(guard.accept(delta('z', 9, 'turn_0'))).toEqual({
      kind: 'ignored',
      reason: 'other_turn',
    });
    guard.accept({ type: 'done', event_id: 'd', turn_id: 'turn_1', seq: 2, status: 'completed' });
    expect(guard.accept(delta('late', 3))).toEqual({ kind: 'ignored', reason: 'after_done' });
  });

  it('fails the turn when seq goes backwards instead of inventing order', () => {
    const guard = new AgentStreamGuard('turn_1');
    guard.accept(delta('a', 5));
    expect(guard.accept(delta('b', 4))).toEqual({ kind: 'violation', reason: 'seq_regressed' });
  });

  it('fails a runaway reply', () => {
    const guard = new AgentStreamGuard('turn_1');
    const chunk = 'x'.repeat(4000);
    let result;
    for (let i = 0; i * 4000 <= MAX_AGENT_TURN_TEXT_CHARS; i += 1) {
      result = guard.accept(delta(`e${i}`, i, 'turn_1', chunk));
    }
    expect(result).toEqual({ kind: 'violation', reason: 'too_long' });
  });

  it('accepts 50,000 text characters but keeps the call limit at 20,000', () => {
    const textGuard = new AgentStreamGuard('turn_1', MAX_TEXT_TURN_TEXT_CHARS);
    const callGuard = new AgentStreamGuard('turn_1');
    for (let i = 0; i < 13; i += 1) {
      const event = delta(`chunk_${i}`, i, 'turn_1', 'x'.repeat(i === 12 ? 2000 : 4000));
      expect(textGuard.accept(event).kind).toBe('event');
      if (i === 5)
        expect(callGuard.accept(event)).toEqual({ kind: 'violation', reason: 'too_long' });
      else if (i < 5) expect(callGuard.accept(event).kind).toBe('event');
    }
  });

  it('fails the turn on an event that breaks the contract (oversized or malformed)', () => {
    const malformed = { kind: 'violation', reason: 'malformed' };
    expect(
      new AgentStreamGuard('turn_1').accept(
        delta('a', 1, 'turn_1', 'x'.repeat(MAX_AGENT_DELTA_CHARS + 1)),
      ),
    ).toEqual(malformed);
    expect(
      new AgentStreamGuard('turn_1').accept({
        type: 'activity',
        event_id: 'b',
        turn_id: 'turn_1',
        label: 'x'.repeat(MAX_ACTIVITY_LABEL_CHARS + 1),
      }),
    ).toEqual(malformed);
    const guard = new AgentStreamGuard('turn_1');
    expect(guard.accept({ ...delta('c', 1), seq: -1 })).toEqual(malformed);
    expect(guard.accept({ type: 'nope', event_id: 'd', turn_id: 'turn_1' } as never)).toEqual(
      malformed,
    );
  });
});
