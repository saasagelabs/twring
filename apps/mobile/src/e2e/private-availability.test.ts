import { describe, expect, it, vi } from 'vitest';

import { PrivateAvailabilityCache } from './private-availability';

describe('private chats availability', () => {
  it('asks once per server and account and remembers on and off', async () => {
    const cache = new PrivateAvailabilityCache();
    const on = vi.fn(() => Promise.resolve('on' as const));
    const off = vi.fn(() => Promise.resolve('off' as const));
    await expect(cache.ask('a|u1', on)).resolves.toBe('on');
    await expect(cache.ask('a|u1', on)).resolves.toBe('on');
    await expect(cache.ask('a|u2', off)).resolves.toBe('off');
    await expect(cache.ask('a|u2', off)).resolves.toBe('off');
    expect(on).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('shares one request between screens asking at once', async () => {
    const cache = new PrivateAvailabilityCache();
    const fetch = vi.fn(() => Promise.resolve('on' as const));
    await Promise.all([cache.ask('k', fetch), cache.ask('k', fetch)]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never remembers unknown: it asks again later', async () => {
    const cache = new PrivateAvailabilityCache();
    const fetch = vi
      .fn<() => Promise<'on' | 'off' | 'unknown'>>()
      .mockResolvedValueOnce('unknown')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('on');
    await expect(cache.ask('k', fetch)).resolves.toBe('unknown');
    expect(cache.peek('k')).toBeUndefined();
    await expect(cache.ask('k', fetch)).resolves.toBe('unknown');
    await expect(cache.ask('k', fetch)).resolves.toBe('on');
    expect(cache.peek('k')).toBe('on');
  });
});
