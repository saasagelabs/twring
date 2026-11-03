import { describe, expect, it } from 'vitest';

import { dailyReport, formatReport, type ReportInput } from './daily';

const NOW = new Date('2026-10-22T18:00:00.000Z');

function call(user: string, startedAt: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: user,
    call_id: 'call_x',
    agent_id: 'agt_x',
    agent_name: 'Hermes',
    started_at: startedAt,
    duration_s: 60,
    outcome: 'completed' as const,
    ...extra,
  };
}

/** A stored redemption: it has an email, which the report must never print. */
function redeemed(email: string, at: string, userId?: string) {
  return { email, at, ...(userId && { user_id: userId }) };
}

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    now: NOW,
    days: 2,
    capSeconds: 180_000,
    redemptions: [],
    history: [],
    rings: [],
    feedback: [],
    refusals: [],
    ...over,
  };
}

describe('dailyReport', () => {
  it('has one row per UTC day, oldest first, ending today', () => {
    const report = dailyReport(input({ days: 3 }));
    expect(report.days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
  });

  it('counts new members by redemption day', () => {
    const report = dailyReport(
      input({
        redemptions: [
          redeemed('a@x.com', '2026-10-21T10:00:00.000Z'),
          redeemed('b@x.com', '2026-10-22T01:00:00.000Z'),
          redeemed('c@x.com', '2026-10-22T23:00:00.000Z'),
        ],
      }),
    );
    expect(report.days.map((d) => d.newMembers)).toEqual([1, 2]);
  });

  it('first call within 24 hours counts only redemptions that carry an account', () => {
    const report = dailyReport(
      input({
        redemptions: [
          redeemed('a@x.com', '2026-10-21T10:00:00.000Z', 'ua'),
          redeemed('b@x.com', '2026-10-21T11:00:00.000Z', 'ub'),
          redeemed('c@x.com', '2026-10-21T12:00:00.000Z', 'uc'),
          redeemed('d@x.com', '2026-10-21T13:00:00.000Z'),
        ],
        history: [
          call('ua', '2026-10-21T10:30:00.000Z'),
          // 25 hours later: too late.
          call('ub', '2026-10-22T12:00:00.000Z'),
          // A missed ring is not a call.
          call('uc', '2026-10-21T12:10:00.000Z', { kind: 'missed_invite', outcome: 'missed' }),
          // A call before the redemption doesn't count.
          call('uc', '2026-10-21T11:00:00.000Z'),
          // A failed call is not a first call.
          call('uc', '2026-10-21T12:20:00.000Z', { outcome: 'failed' }),
        ],
      }),
    );
    expect(report.days[0]).toMatchObject({ newMembers: 4, firstCall: { called: 1, of: 3 } });
    expect(report.days[1]?.firstCall).toEqual({ called: 0, of: 0 });
  });

  it('callers, minutes and failed calls come from call history, on every day shown', () => {
    const report = dailyReport(
      input({
        days: 7,
        history: [
          call('ua', '2026-10-22T09:00:00.000Z', { outcome: 'failed', duration_s: 0 }),
          call('ub', '2026-10-22T09:00:00.000Z', { duration_s: 600 }),
          call('ub', '2026-10-22T10:00:00.000Z', { duration_s: 90 }),
          call('ua', '2026-10-16T09:00:00.000Z', { duration_s: 30 }),
          call('uc', '2026-10-16T09:00:00.000Z', { outcome: 'failed', duration_s: 0 }),
          // A missed ring is not a call, and not a caller.
          call('ud', '2026-10-16T09:00:00.000Z', { kind: 'missed_invite', outcome: 'missed' }),
        ],
      }),
    );
    expect(report.days[6]).toMatchObject({ callers: 2, callSeconds: 690, failedCalls: 1 });
    expect(report.days[0]).toMatchObject({ callers: 2, callSeconds: 30, failedCalls: 1 });
    expect(report.days[3]).toMatchObject({ callers: 0, callSeconds: 0, failedCalls: 0 });
  });

  it('counts call ratings per day with their average', () => {
    const report = dailyReport(
      input({
        feedback: [
          { rating: 5, created_at: '2026-10-22T09:00:00.000Z' },
          { rating: 2, created_at: '2026-10-22T10:00:00.000Z' },
          { rating: 4, created_at: '2026-10-22T11:00:00.000Z' },
          { rating: 1, created_at: '2026-10-21T11:00:00.000Z' },
        ],
      }),
    );
    expect(report.days.map((d) => d.ratings)).toEqual([
      { count: 1, total: 1 },
      { count: 3, total: 11 },
    ]);
    const text = formatReport(report);
    expect(text).toContain('ratings');
    expect(text).toMatch(/2026-10-22 .* 3\.7 \(3\)/);
    expect(text).toMatch(/2026-10-21 .* 1\.0 \(1\)/);
    const lines = text.split('\n');
    const header = lines.find((l) => l.startsWith('day'))!;
    const row = lines.find((l) => l.startsWith('2026-10-22'))!;
    expect(row.length).toBe(header.length);
  });

  it('keeps the columns lined up on a day with ten or more ratings', () => {
    const feedback = Array.from({ length: 12 }, () => ({
      rating: 4,
      created_at: '2026-10-22T09:00:00.000Z',
    }));
    const lines = formatReport(dailyReport(input({ feedback }))).split('\n');
    const header = lines.find((l) => l.startsWith('day'))!;
    expect(lines.find((l) => l.startsWith('2026-10-22'))).toMatch(/4\.0 \(12\)/);
    for (const row of lines.filter((l) => /^\d{4}-/.test(l))) {
      expect(row.length, row).toBe(header.length);
    }
  });

  it('counts calls refused before they start, per day, with the reasons in words', () => {
    const report = dailyReport(
      input({
        refusals: [
          { day: '2026-10-22', code: 'capacity_exceeded', count: 3 },
          { day: '2026-10-22', code: 'daily_limit_reached', count: 1 },
          { day: '2026-10-21', code: 'service_busy', count: 2 },
          { day: '2026-10-01', code: 'service_busy', count: 9 },
        ],
      }),
    );
    expect(report.days.map((d) => d.refused)).toEqual([2, 4]);
    const text = formatReport(report);
    expect(text).toContain('refused');
    expect(text).toContain(
      'Refused before starting: 3 lines busy, 2 Twring busy for the day, 1 daily limit',
    );
  });

  it('says how many people still call a week after their first call', () => {
    const report = dailyReport(
      input({
        history: [
          // First call 10 days ago, called again 2 days ago: still calling.
          call('ua', '2026-10-12T09:00:00.000Z'),
          call('ua', '2026-10-20T09:00:00.000Z'),
          // First call 9 days ago, nothing since: stopped.
          call('ub', '2026-10-13T09:00:00.000Z'),
          // First call 2 days ago: too new to count.
          call('uc', '2026-10-20T09:00:00.000Z'),
          // A failed call is not a call that counts.
          call('ud', '2026-10-12T09:00:00.000Z'),
          call('ud', '2026-10-21T09:00:00.000Z', { outcome: 'failed' }),
        ],
      }),
    );
    expect(report.retention).toEqual({ returned: 1, of: 3 });
    expect(formatReport(report)).toContain(
      'Still calling a week later: 1 of 3 people whose first call was 7 to 14 days ago',
    );
  });

  it('sums rings from the last 24 hours by status', () => {
    const ring = (status: string, created: string) => ({ status, created_at: created });
    const report = dailyReport(
      input({
        rings: [
          ring('answered', '2026-10-22T10:00:00.000Z'),
          ring('answered', '2026-10-22T11:00:00.000Z'),
          ring('missed', '2026-10-22T12:00:00.000Z'),
          ring('declined', '2026-10-21T19:00:00.000Z'),
          ring('pending', '2026-10-22T17:59:00.000Z'),
          // Older than 24 hours: left out even if not pruned yet.
          ring('answered', '2026-10-21T17:00:00.000Z'),
        ],
      }),
    );
    expect(report.rings).toEqual({
      sent: 5,
      answered: 2,
      declined: 1,
      missed: 1,
      cancelled: 0,
      pending: 1,
    });
  });
});

describe('formatReport', () => {
  it('prints numbers only, with the cap in minutes', () => {
    const text = formatReport(
      dailyReport(
        input({
          redemptions: [redeemed('secret@x.com', '2026-10-22T01:00:00.000Z', 'ua')],
          history: [call('ua', '2026-10-22T02:00:00.000Z', { duration_s: 2_490 })],
        }),
      ),
    );
    expect(text).toContain('cap 3000 min');
    expect(text).toMatch(/2026-10-22\s+1\s+1\/1\s+1\s+42\s+0/);
    expect(text).toContain('Rings in the last 24 hours: 0 sent');
    expect(text).not.toMatch(/secret|@|ua\b/);
  });

  it("says when no account could be tied to the day's invites, and when there is no cap", () => {
    const text = formatReport(
      dailyReport(
        input({
          capSeconds: 0,
          days: 1,
          redemptions: [redeemed('a@x.com', '2026-10-22T01:00:00.000Z')],
        }),
      ),
    );
    expect(text).toContain('no daily cap');
    expect(text).toMatch(/2026-10-22\s+1\s+-\s/);
  });
});
