import { describe, expect, it } from 'vitest';

import { ResultOutbox } from './outbox';

describe('result outbox', () => {
  it('re-sends held results once after a reconnect, keyed by turn', async () => {
    const sent: string[] = [];
    const box = new ResultOutbox({ max: 4, maxAgeMs: 60_000 });
    box.hold('t1', () => {
      sent.push('t1');
      return Promise.resolve('delivered' as const);
    });
    // The same turn held twice is one entry (the gateway also dedupes by this key).
    box.hold('t1', () => {
      sent.push('t1 again');
      return Promise.resolve('delivered' as const);
    });
    expect(box.size).toBe(1);
    await box.flush();
    expect(sent).toEqual(['t1 again']);
    expect(box.size).toBe(0);
    await box.flush();
    expect(sent).toEqual(['t1 again']);
  });

  it('keeps a result that still could not be sent, and drops one the gateway refused', async () => {
    const box = new ResultOutbox({ max: 4, maxAgeMs: 60_000 });
    box.hold('later', () => Promise.resolve('retry' as const));
    box.hold('refused', () => Promise.resolve('dropped' as const));
    await box.flush();
    expect(box.keys()).toEqual(['later']);
  });

  it('is bounded: the oldest goes first, and old results expire', async () => {
    let now = 0;
    const sent: string[] = [];
    const box = new ResultOutbox({ max: 2, maxAgeMs: 1_000, now: () => now });
    for (const key of ['a', 'b', 'c'])
      box.hold(key, () => {
        sent.push(key);
        return Promise.resolve('delivered' as const);
      });
    expect(box.keys()).toEqual(['b', 'c']);
    now = 1_001;
    await box.flush();
    expect(sent).toEqual([]);
    expect(box.size).toBe(0);
  });

  it('does not send one result twice when flushes overlap', async () => {
    let calls = 0;
    let release!: () => void;
    const box = new ResultOutbox({ max: 4, maxAgeMs: 60_000 });
    box.hold('t1', async () => {
      calls += 1;
      await new Promise<void>((resolve) => (release = resolve));
      return 'delivered' as const;
    });
    const first = box.flush();
    const second = box.flush();
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
  });
});
