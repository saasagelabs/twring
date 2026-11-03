import type { CallState } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { CallLevels, LEVEL_INTERVAL_MS, drivingLevel, visualizerMode } from './levels';
import type { Timers } from './timers';

function fakeTimers() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout(callback, ms) {
      const entry = { at: now + ms, callback };
      pending.add(entry);
      return () => pending.delete(entry);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of [...pending].sort((a, b) => a.at - b.at)) {
      if (entry.at <= now) {
        pending.delete(entry);
        entry.callback();
      }
    }
  };
  return { timers, advance, pending };
}

describe('CallLevels', () => {
  it('publishes the first sample at once and at most once per interval after that', () => {
    const { timers, advance } = fakeTimers();
    const levels = new CallLevels(timers);
    const seen: number[] = [];
    levels.subscribe(() => seen.push(levels.getLevels().local));

    levels.push({ local: 0.1, remote: 0 });
    expect(seen).toEqual([0.1]);
    // A 60 Hz burst inside one interval collapses to its latest value.
    for (let i = 2; i <= 5; i += 1) {
      advance(16);
      levels.push({ local: i / 10, remote: 0 });
    }
    expect(seen).toEqual([0.1]);
    advance(LEVEL_INTERVAL_MS);
    expect(seen).toEqual([0.1, 0.5]);
  });

  it('stays within ~12.5 Hz under a continuous stream', () => {
    const { timers, advance } = fakeTimers();
    const levels = new CallLevels(timers);
    let count = 0;
    levels.subscribe(() => (count += 1));
    for (let t = 0; t < 1000; t += 10) {
      levels.push({ local: (t % 70) / 100 + 0.01, remote: 0 });
      advance(10);
    }
    expect(count).toBeGreaterThanOrEqual(10);
    expect(count).toBeLessThanOrEqual(Math.ceil(1000 / LEVEL_INTERVAL_MS) + 1);
  });

  it('clamps bad values and does not re-emit an unchanged level', () => {
    const { timers, advance } = fakeTimers();
    const levels = new CallLevels(timers);
    let count = 0;
    levels.subscribe(() => (count += 1));
    levels.push({ local: 7, remote: Number.NaN });
    expect(levels.getLevels()).toEqual({ local: 1, remote: 0 });
    advance(LEVEL_INTERVAL_MS);
    levels.push({ local: 1, remote: -2 });
    expect(count).toBe(1);
  });

  it('reset drops a pending sample and returns to silence at once', () => {
    const { timers, advance, pending } = fakeTimers();
    const levels = new CallLevels(timers);
    levels.push({ local: 0.4, remote: 0.6 });
    levels.push({ local: 0.9, remote: 0.9 });
    levels.reset();
    expect(levels.getLevels()).toEqual({ local: 0, remote: 0 });
    expect(pending.size).toBe(0);
    advance(LEVEL_INTERVAL_MS * 2);
    expect(levels.getLevels()).toEqual({ local: 0, remote: 0 });
  });
});

describe('visualizerMode', () => {
  const connected = (status: string, extra = {}) =>
    ({ status, callId: 'c', ...extra }) as unknown as CallState;
  const levels = { local: 0.3, remote: 0.8 };

  it('drives the caller state from the microphone and the agent state from the gateway voice', () => {
    const user = visualizerMode(connected('USER_SPEAKING'), false);
    expect(user).toEqual({ kind: 'user', signal: 'local' });
    expect(drivingLevel(user.kind, levels)).toBe(0.3);
    const agent = visualizerMode(connected('AGENT_SPEAKING', { turnId: 't' }), false);
    expect(agent).toEqual({ kind: 'agent', signal: 'remote' });
    expect(drivingLevel(agent.kind, levels)).toBe(0.8);
  });

  it('never animates listening, working, reconnecting, or a muted caller', () => {
    for (const [state, muted, kind] of [
      [connected('LISTENING'), false, 'listening'],
      [connected('USER_SPEAKING'), true, 'listening'],
      [connected('AGENT_WORKING', { turnId: 't' }), false, 'working'],
      [connected('RECONNECTING'), false, 'reconnecting'],
      [{ status: 'IDLE' } as CallState, false, 'idle'],
      [connected('ENDING'), false, 'idle'],
    ] as const) {
      const mode = visualizerMode(state, muted);
      expect(mode.kind).toBe(kind);
      expect(drivingLevel(mode.kind, levels)).toBe(0);
    }
  });
});
