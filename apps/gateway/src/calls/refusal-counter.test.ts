import { describe, expect, it } from 'vitest';

import { MemoryCollection } from '../store/collection';
import { RefusalCounter, type RefusalRow } from './refusal-counter';

describe('RefusalCounter', () => {
  it('counts refused calls per UTC day and reason, and forgets them after 60 days', async () => {
    const rows = new MemoryCollection<RefusalRow>();
    const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
    const counter = new RefusalCounter(rows, () => clock.now);
    await counter.count('capacity_exceeded');
    await counter.count('capacity_exceeded');
    await counter.count('daily_limit_reached');
    expect(await rows.read()).toEqual([
      { day: '2026-10-23', code: 'capacity_exceeded', count: 2 },
      { day: '2026-10-23', code: 'daily_limit_reached', count: 1 },
    ]);
    clock.now = new Date('2026-12-23T10:00:00.000Z');
    await counter.count('service_busy');
    expect(await rows.read()).toEqual([{ day: '2026-12-23', code: 'service_busy', count: 1 }]);
  });

  it('counts only Twring being full, busy or down: not a retry, a double tap or a missing agent', async () => {
    const rows = new MemoryCollection<RefusalRow>();
    const counter = new RefusalCounter(rows, () => new Date('2026-10-23T10:00:00.000Z'));
    for (const code of [
      'rate_limited',
      'call_in_progress',
      'not_found',
      'connector_invalid',
      'agent_offline',
    ] as const) {
      await counter.count(code);
    }
    expect(await rows.read()).toEqual([]);
    await counter.count('service_unavailable');
    expect(await rows.read()).toEqual([
      { day: '2026-10-23', code: 'service_unavailable', count: 1 },
    ]);
  });
});
