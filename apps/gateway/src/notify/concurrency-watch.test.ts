import { afterEach, describe, expect, it, vi } from 'vitest';

import { alertThreshold, watchConcurrency } from './concurrency-watch';

afterEach(() => {
  vi.useRealTimers();
});

describe('watchConcurrency', () => {
  it('alerts when live calls reach 80% of the limit, checked every 30 s', () => {
    vi.useFakeTimers();
    let live = 3;
    const alert = vi.fn();
    const stop = watchConcurrency({ count: () => live, limit: 12, alert });
    vi.advanceTimersByTime(30_000);
    expect(alert).not.toHaveBeenCalled();
    live = 10;
    vi.advanceTimersByTime(30_000);
    expect(alert).toHaveBeenCalledWith(10, 12);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('rounds the threshold up and never below 1', () => {
    expect(alertThreshold(12)).toBe(10);
    expect(alertThreshold(4)).toBe(4);
    expect(alertThreshold(1)).toBe(1);
  });
});
