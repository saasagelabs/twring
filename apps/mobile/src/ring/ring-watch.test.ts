import type { InviteStatus } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRingWatch, ringIsOver } from './ring-watch';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(statuses: InviteStatus[], ringing = ['inv_a']) {
  const over: [string, InviteStatus][] = [];
  const state = { ringing, calls: 0 };
  const watch = createRingWatch({
    ringing: () => Promise.resolve(state.ringing),
    getStatus: () => {
      const status = statuses[Math.min(state.calls, statuses.length - 1)];
      state.calls += 1;
      return Promise.resolve(status);
    },
    ringOver: (id, status) => over.push([id, status]),
    setInterval: (run, ms) => setInterval(run, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  return { watch, over, state };
}

describe('ring watch', () => {
  it('treats only pending as still ringing', () => {
    expect(ringIsOver('pending')).toBe(false);
    for (const status of ['answered', 'declined', 'missed', 'cancelled'] as const) {
      expect(ringIsOver(status)).toBe(true);
    }
  });

  it('closes the ring with the server status once it is no longer pending, then stops', async () => {
    const { watch, over, state } = setup(['pending', 'cancelled']);
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(over).toEqual([]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(over).toEqual([['inv_a', 'cancelled']]);
    expect(watch.watching()).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.calls).toBe(2);
  });

  it('passes answered elsewhere through for the call log reason', async () => {
    const { watch, over } = setup(['answered']);
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(over).toEqual([['inv_a', 'answered']]);
  });

  it('stops without asking the server once the ring left the call screen', async () => {
    const { watch, over, state } = setup(['pending']);
    watch.watch('inv_a');
    state.ringing = [];
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.calls).toBe(0);
    expect(over).toEqual([]);
    expect(watch.watching()).toEqual([]);
  });

  it('keeps watching after a failed check and does not watch one ring twice', async () => {
    let calls = 0;
    const watch = createRingWatch({
      ringing: () => Promise.resolve(['inv_a']),
      getStatus: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('declined');
      },
      ringOver: () => undefined,
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    watch.watch('inv_a');
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(watch.watching()).toEqual(['inv_a']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(2);
    expect(watch.watching()).toEqual([]);
  });

  it('aborts a slow check', async () => {
    let aborted = false;
    const watch = createRingWatch({
      ringing: () => Promise.resolve(['inv_a']),
      getStatus: (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
      ringOver: () => undefined,
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(5_500);
    expect(aborted).toBe(true);
    watch.stopAll();
    expect(watch.watching()).toEqual([]);
  });

  it('starts nothing once stopped (a late first listing after sign-out or unmount)', async () => {
    const { watch, state } = setup(['pending']);
    watch.stopAll();
    watch.watch('inv_a');
    expect(watch.watching()).toEqual([]);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(state.calls).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not close a ring when stopped while a check is in flight', async () => {
    let resolve: (status: InviteStatus) => void = () => undefined;
    const over: string[] = [];
    const watch = createRingWatch({
      ringing: () => Promise.resolve(['inv_a']),
      getStatus: () => new Promise((r) => (resolve = r)),
      ringOver: (id) => over.push(id),
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(3_000);
    watch.stopAll();
    resolve('cancelled');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(over).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overlaps a slow check with the next tick', async () => {
    let inFlight = 0;
    let most = 0;
    const watch = createRingWatch({
      ringing: () => Promise.resolve(['inv_a']),
      getStatus: () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        return new Promise<InviteStatus>((r) =>
          setTimeout(() => {
            inFlight -= 1;
            r('pending');
          }, 7_000),
        );
      },
      ringOver: () => undefined,
      setInterval: (run, ms) => setInterval(run, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    });
    watch.watch('inv_a');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(most).toBe(1);
    watch.stopAll();
  });
});
