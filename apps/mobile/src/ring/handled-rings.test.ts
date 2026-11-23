import { describe, expect, it } from 'vitest';

import { HANDLED_RING_TTL_MS, HandledRings } from './handled-rings';

describe('HandledRings', () => {
  it('drops the same invite delivered twice', () => {
    const rings = new HandledRings(() => 0);
    expect(rings.has('inv_1')).toBe(false);
    rings.mark('inv_1');
    expect(rings.has('inv_1')).toBe(true);
    expect(rings.has('inv_2')).toBe(false);
  });

  it('drops a late ring for an invite already cancelled', () => {
    let now = 1_000;
    const rings = new HandledRings(() => now);
    rings.mark('inv_cancelled');
    now += 30_000;
    expect(rings.has('inv_cancelled')).toBe(true);
  });

  it('forgets an invite after the TTL', () => {
    let now = 0;
    const rings = new HandledRings(() => now);
    rings.mark('inv_1');
    now = HANDLED_RING_TTL_MS - 1;
    expect(rings.has('inv_1')).toBe(true);
    now = HANDLED_RING_TTL_MS;
    expect(rings.has('inv_1')).toBe(false);
  });
});
