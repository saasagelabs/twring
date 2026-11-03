import { describe, expect, it } from 'vitest';

import { groupHistory, historySummary } from './history';
import type { HistoryEntry } from './protocol';

function entry(date: Date, kind: 'call' | 'missed_invite', duration_s: number): HistoryEntry {
  return {
    call_id: 'call',
    agent_id: 'agent',
    agent_name: 'Agent',
    started_at: date.toISOString(),
    duration_s,
    outcome: kind === 'call' ? 'completed' : 'missed',
    kind,
  };
}

describe('history presentation data', () => {
  it('groups entries by local calendar day across a year boundary', () => {
    const now = new Date(2026, 0, 1, 12);
    const today = entry(new Date(2026, 0, 1, 9), 'call', 60);
    const yesterday = entry(new Date(2025, 11, 31, 23), 'missed_invite', 0);
    const earlier = entry(new Date(2025, 11, 30, 15), 'call', 120);
    expect(groupHistory([earlier, today, yesterday], now)).toEqual({
      TODAY: [today],
      YESTERDAY: [yesterday],
      EARLIER: [earlier],
    });
  });

  it('counts calls and sums their duration without missed rings', () => {
    const date = new Date(2026, 0, 1);
    expect(
      historySummary([
        entry(date, 'call', 1800),
        entry(date, 'missed_invite', 0),
        entry(date, 'call', 3240),
      ]),
    ).toBe('2 calls · 1.4 hours');
    expect(historySummary([entry(date, 'call', 360)])).toBe('1 call · 0.1 hours');
    expect(historySummary([entry(date, 'missed_invite', 0)])).toBe('0 calls · 0.0 hours');
  });

  it('hides the summary when no entries are loaded', () => {
    expect(historySummary([])).toBeUndefined();
  });
});
