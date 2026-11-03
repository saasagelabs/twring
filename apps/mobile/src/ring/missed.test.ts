import { describe, expect, it } from 'vitest';

import {
  HOME_MISSED_LIMIT,
  markSeenValue,
  parseCallBack,
  parseLastSeen,
  unseenMissed,
} from './missed';
import type { HistoryEntry } from './protocol';

const AGENT = 'agt_abcdefghij0123456789';

function missed(n: number, startedAt: string): HistoryEntry {
  return {
    call_id: `inv_${'a'.repeat(25)}${n}`,
    kind: 'missed_invite',
    reason: `reason ${n}`,
    agent_id: AGENT,
    agent_name: 'Claude',
    started_at: startedAt,
    duration_s: 0,
    outcome: 'missed',
  };
}

function call(startedAt: string): HistoryEntry {
  return {
    call_id: 'call_x',
    kind: 'call',
    agent_id: AGENT,
    agent_name: 'Claude',
    started_at: startedAt,
    duration_s: 30,
    outcome: 'completed',
  };
}

describe('unseenMissed', () => {
  const t = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

  it('keeps only missed rings newer than last seen, newest first', () => {
    const entries = [missed(1, t(1)), call(t(9)), missed(2, t(5)), missed(3, t(3))];
    const lastSeen = Date.parse(t(2));
    expect(unseenMissed(entries, lastSeen).map((e) => e.reason)).toEqual(['reason 2', 'reason 3']);
  });

  it('shows everything missed when never seen, at most three', () => {
    const entries = [1, 2, 3, 4, 5].map((n) => missed(n, t(n)));
    const result = unseenMissed(entries, undefined);
    expect(result).toHaveLength(HOME_MISSED_LIMIT);
    expect(result[0]?.reason).toBe('reason 5');
  });

  it('ignores normal calls and exact last-seen ties', () => {
    expect(unseenMissed([call(t(5))], undefined)).toEqual([]);
    expect(unseenMissed([missed(1, t(5))], Date.parse(t(5)))).toEqual([]);
  });
});

describe('last seen', () => {
  it('round-trips the mark-seen value', () => {
    const now = new Date('2026-10-01T10:00:00.000Z');
    expect(parseLastSeen(markSeenValue(now))).toBe(now.getTime());
  });

  it('treats missing or garbage as never seen', () => {
    expect(parseLastSeen(null)).toBeUndefined();
    expect(parseLastSeen('nope')).toBeUndefined();
    expect(parseLastSeen('-5')).toBeUndefined();
  });
});

describe('parseCallBack', () => {
  it('accepts a well-formed agent id with a name', () => {
    expect(parseCallBack({ call_back: AGENT, name: ' Claude ' })).toEqual({
      agentId: AGENT,
      name: 'Claude',
    });
    expect(parseCallBack({ call_back: AGENT })).toEqual({ agentId: AGENT });
  });

  it('rejects malformed agent ids', () => {
    expect(parseCallBack({})).toBeUndefined();
    expect(parseCallBack({ call_back: 'agt_short' })).toBeUndefined();
    expect(parseCallBack({ call_back: `${AGENT}&x=1` })).toBeUndefined();
    expect(parseCallBack({ call_back: 'AGT_ABCDEFGHIJ0123456789' })).toBeUndefined();
    expect(parseCallBack({ call_back: [AGENT, AGENT] })).toBeUndefined();
  });
});
