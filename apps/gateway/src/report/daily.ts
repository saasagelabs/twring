/**
 * The wave 1 daily report: one line of numbers per UTC day, read from
 * the gateway's own files. Counts only: no names, emails or account ids leave this module.
 */
import { utcDay } from '../calls/daily-limits';

const DAY_MS = 86_400_000;

export interface ReportInput {
  now: Date;
  /** How many UTC days, ending today. */
  days: number;
  /** The service-wide daily cap (SERVICE_DAILY_CALL_SECONDS); 0 means none. */
  capSeconds: number;
  redemptions: readonly { at: string; user_id?: string }[];
  /**
   * Call history: the source for every per-day call number, because daily usage keeps only today
   * and yesterday. It keeps the newest 200 entries per person.
   */
  history: readonly {
    user_id: string;
    started_at: string;
    duration_s: number;
    outcome: string;
    kind?: string;
  }[];
  /** Ring records, which the gateway keeps for 24 hours. */
  rings: readonly { status: string; created_at: string }[];
  /** Post-call ratings (1 to 5). */
  feedback: readonly { rating: number; created_at: string }[];
  /** Calls refused before they started, per UTC day and reason (`call-refusals.json`). */
  refusals: readonly { day: string; code: string; count: number }[];
}

export interface DayRow {
  day: string;
  newMembers: number;
  /** Of the day's redemptions that carry an account, how many had a completed call within 24 hours. */
  firstCall: { called: number; of: number };
  callers: number;
  callSeconds: number;
  failedCalls: number;
  ratings: { count: number; total: number };
  refused: number;
}

export interface DailyReport {
  capSeconds: number;
  days: DayRow[];
  rings: Record<'sent' | 'answered' | 'declined' | 'missed' | 'cancelled' | 'pending', number>;
  /** Refused calls over the days shown, by reason code. */
  refusedReasons: Record<string, number>;
  /** People whose first completed call was 7 to 14 days ago, and how many called again since. */
  retention: { returned: number; of: number };
}

function isCall(item: { kind?: string }): boolean {
  return item.kind === undefined || item.kind === 'call';
}

export function dailyReport(input: ReportInput): DailyReport {
  const today = Date.parse(`${utcDay(input.now)}T00:00:00.000Z`);
  const days = Array.from({ length: input.days }, (_, i) =>
    utcDay(new Date(today - (input.days - 1 - i) * DAY_MS)),
  );
  const calls = input.history.filter(isCall);
  const callsByUser = new Map<string, number[]>();
  for (const item of calls) {
    if (item.outcome !== 'completed') continue;
    const list = callsByUser.get(item.user_id) ?? [];
    list.push(Date.parse(item.started_at));
    callsByUser.set(item.user_id, list);
  }

  const rows = days.map((day): DayRow => {
    const redeemed = input.redemptions.filter((r) => r.at.startsWith(day));
    const tied = redeemed.filter((r) => r.user_id !== undefined);
    const called = tied.filter((r) => {
      const at = Date.parse(r.at);
      return (callsByUser.get(r.user_id ?? '') ?? []).some((t) => t >= at && t <= at + DAY_MS);
    });
    const onDay = calls.filter((c) => c.started_at.startsWith(day));
    return {
      day,
      newMembers: redeemed.length,
      firstCall: { called: called.length, of: tied.length },
      callers: new Set(onDay.map((c) => c.user_id)).size,
      callSeconds: onDay.reduce((sum, c) => sum + c.duration_s, 0),
      failedCalls: onDay.filter((c) => c.outcome === 'failed').length,
      ratings: input.feedback
        .filter((f) => f.created_at.startsWith(day))
        .reduce((sum, f) => ({ count: sum.count + 1, total: sum.total + f.rating }), {
          count: 0,
          total: 0,
        }),
      refused: input.refusals.filter((r) => r.day === day).reduce((sum, r) => sum + r.count, 0),
    };
  });

  const refusedReasons: Record<string, number> = {};
  for (const r of input.refusals) {
    if (days.includes(r.day)) refusedReasons[r.code] = (refusedReasons[r.code] ?? 0) + r.count;
  }

  // A week later: people whose first completed call was 7 to 14 days ago, and whether they
  // completed another call in the last 7 days.
  const nowMs = input.now.getTime();
  const cohort = [...callsByUser].filter(([, times]) => {
    const first = Math.min(...times);
    return first >= nowMs - 14 * DAY_MS && first < nowMs - 7 * DAY_MS;
  });
  const returned = cohort.filter(([, times]) => times.some((t) => t >= nowMs - 7 * DAY_MS));

  const since = nowMs - DAY_MS;
  const recent = input.rings.filter((r) => Date.parse(r.created_at) >= since);
  const count = (status: string) => recent.filter((r) => r.status === status).length;
  return {
    capSeconds: input.capSeconds,
    days: rows,
    refusedReasons,
    retention: { returned: returned.length, of: cohort.length },
    rings: {
      sent: recent.length,
      answered: count('answered'),
      declined: count('declined'),
      missed: count('missed'),
      cancelled: count('cancelled'),
      pending: count('pending'),
    },
  };
}

const REFUSAL_WORDS: Partial<Record<string, string>> = {
  capacity_exceeded: 'lines busy',
  daily_limit_reached: 'daily limit',
  service_busy: 'Twring busy for the day',
  service_unavailable: 'Twring updating or down',
};

export function formatReport(report: DailyReport): string {
  const cap =
    report.capSeconds > 0 ? `cap ${Math.round(report.capSeconds / 60)} min` : 'no daily cap';
  const header = `Twring daily report (UTC days, ${cap})`;
  const columns = [
    'day       ',
    'new',
    '1st call<24h',
    'callers',
    'minutes',
    'failed calls',
    'ratings  ',
    'refused',
  ];
  const lines = report.days.map((d) =>
    [
      d.day,
      String(d.newMembers).padStart(3),
      (d.firstCall.of > 0 ? `${d.firstCall.called}/${d.firstCall.of}` : '-').padEnd(12),
      String(d.callers).padStart(7),
      String(Math.round(d.callSeconds / 60)).padStart(7),
      String(d.failedCalls).padStart(12),
      (d.ratings.count > 0
        ? `${(d.ratings.total / d.ratings.count).toFixed(1)} (${d.ratings.count})`
        : '-'
      ).padEnd(9),
      String(d.refused).padStart(7),
    ].join('  '),
  );
  const r = report.rings;
  const rings = `Rings in the last 24 hours: ${r.sent} sent, ${r.answered} answered, ${r.declined} declined, ${r.missed} missed, ${r.cancelled} cancelled, ${r.pending} still ringing`;
  const reasons = Object.entries(report.refusedReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${n} ${REFUSAL_WORDS[code] ?? code.replaceAll('_', ' ')}`);
  const refused = `Refused before starting: ${reasons.length > 0 ? reasons.join(', ') : 'none'}`;
  const w = report.retention;
  const week =
    w.of > 0
      ? `Still calling a week later: ${w.returned} of ${w.of} people whose first call was 7 to 14 days ago`
      : 'Still calling a week later: nobody had a first call 7 to 14 days ago';
  return [header, columns.join('  '), ...lines, rings, refused, week].join('\n');
}
