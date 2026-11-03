import { describe, expect, it, vi } from 'vitest';

import { gracefulShutdown, watchLiveCalls } from './shutdown';

describe('gracefulShutdown', () => {
  it('drains, waits for ending calls, ends the rest, and only then closes the server', async () => {
    const order: string[] = [];
    let live = 2;
    await gracefulShutdown({
      drain: () => order.push('drain'),
      liveCalls: () => live,
      sleep: () => {
        order.push('wait');
        live -= 1;
        return Promise.resolve();
      },
      endCalls: () => {
        order.push('end calls');
        return Promise.resolve();
      },
      closeServer: () => {
        order.push('close server');
        return Promise.resolve();
      },
      closeRest: () => {
        order.push('close rest');
        return Promise.resolve();
      },
    });
    expect(order).toEqual(['drain', 'wait', 'wait', 'end calls', 'close server', 'close rest']);
  });

  it('waits at most 5 seconds for calls to end on their own', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const endCalls = vi.fn(() => Promise.resolve());
    await gracefulShutdown({
      drain: () => undefined,
      liveCalls: () => 3,
      sleep,
      endCalls,
      closeServer: () => Promise.resolve(),
      closeRest: () => Promise.resolve(),
    });
    expect(sleep).toHaveBeenCalledTimes(20);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(endCalls).toHaveBeenCalledOnce();
  });

  it('still closes the server when ending calls fails', async () => {
    const closeServer = vi.fn(() => Promise.resolve());
    await expect(
      gracefulShutdown({
        drain: () => undefined,
        liveCalls: () => 0,
        endCalls: () => Promise.reject(new Error('livekit down')),
        closeServer,
        closeRest: () => Promise.resolve(),
      }),
    ).rejects.toThrow('livekit down');
    expect(closeServer).toHaveBeenCalledOnce();
  });
});

describe('watchLiveCalls', () => {
  it('writes the live-call count at once and whenever it changes', async () => {
    vi.useFakeTimers();
    let live = 0;
    const writes: string[] = [];
    const stop = watchLiveCalls({
      count: () => live,
      write: (text) => {
        writes.push(text);
        return Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    live = 2;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    live = 0;
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    vi.useRealTimers();
    expect(writes).toEqual(['0\n', '2\n', '0\n']);
  });

  it('a failed write is tried again on the next tick', async () => {
    vi.useFakeTimers();
    const write = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValue(undefined);
    const stop = watchLiveCalls({ count: () => 1, write });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    vi.useRealTimers();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
