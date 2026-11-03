import type { MeUsageResponse } from '@twring/contracts';

/** Formats a clock time in the phone's locale, e.g. "5:30 AM". Injectable for tests. */
export type TimeFormatter = (date: Date) => string;

export const localTime: TimeFormatter = (date) =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** The daily allowance resets at the next UTC midnight. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "It resets at 5:30 AM." or "It resets tomorrow at 5:30 AM." in the phone's time zone. */
export function resetPhrase(resetsAt: Date, now: Date, format: TimeFormatter = localTime): string {
  const when = sameLocalDay(resetsAt, now) ? '' : 'tomorrow ';
  return `It resets ${when}at ${format(resetsAt)}.`;
}

/**
 * What the phone says when today's calling allowance is used up. `resetsAt` comes from the server
 * when it refused a call; otherwise it is the next UTC midnight.
 */
export function dailyLimitMessage(
  resetsAt: Date | undefined,
  now: Date = new Date(),
  format: TimeFormatter = localTime,
): string {
  const reset =
    resetsAt !== undefined && !Number.isNaN(resetsAt.getTime()) ? resetsAt : nextUtcMidnight(now);
  return `You've used today's calling time. ${resetPhrase(reset, now, format)}`;
}

/** What the phone says when today's calling for the whole service is used up (`service_busy`). */
export function serviceBusyMessage(
  resetsAt: Date | undefined,
  now: Date = new Date(),
  format: TimeFormatter = localTime,
): string {
  const reset =
    resetsAt !== undefined && !Number.isNaN(resetsAt.getTime()) ? resetsAt : nextUtcMidnight(now);
  const when = sameLocalDay(reset, now) ? '' : 'tomorrow ';
  return `Twring is very busy today. Try again ${when}at ${format(reset)}.`;
}

function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** Today's use for Settings, e.g. "12 of 60 minutes used today · 3 of 50 calls". */
export function usageSummary(usage: MeUsageResponse): string {
  const time =
    usage.call_seconds_allowed === null
      ? `${minutes(usage.call_seconds_used)} used today`
      : `${Math.floor(usage.call_seconds_used / 60)} of ${minutes(usage.call_seconds_allowed)} used today`;
  const calls =
    usage.calls_allowed === null
      ? `${usage.calls_used} ${usage.calls_used === 1 ? 'call' : 'calls'}`
      : `${usage.calls_used} of ${usage.calls_allowed} calls`;
  return `${time} · ${calls}`;
}

/** The reset line under the summary, or undefined when nothing is limited. */
export function usageResetLine(
  usage: MeUsageResponse,
  now: Date = new Date(),
  format: TimeFormatter = localTime,
): string | undefined {
  if (usage.call_seconds_allowed === null && usage.calls_allowed === null) return undefined;
  const used =
    (usage.call_seconds_allowed !== null &&
      usage.call_seconds_used >= usage.call_seconds_allowed) ||
    (usage.calls_allowed !== null && usage.calls_used >= usage.calls_allowed);
  const reset = resetPhrase(new Date(usage.resets_at), now, format);
  return used ? dailyLimitMessage(new Date(usage.resets_at), now, format) : reset;
}
