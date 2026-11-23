import type { MeUsageResponse } from '@twring/contracts';

/** The first notice shows at this much calling left today. */
export const FIVE_MINUTES_SECONDS = 5 * 60;
/** The second notice replaces it at this much left. */
export const ONE_MINUTE_SECONDS = 60;

export type TimeLeftNotice = 'five' | 'one';

export const TIME_LEFT_COPY: Record<TimeLeftNotice, string> = {
  five: 'About 5 minutes of calling left today.',
  one: 'About 1 minute of calling left today.',
};

/**
 * Seconds of calling left today when the call connected, or undefined when calling is unlimited
 * or the usage could not be read. The gateway adds a call's seconds only when it finishes
 * (DailyLimits.addCallSeconds), so `call_seconds_used` never includes the call in progress.
 */
export function remainingAtConnect(usage: MeUsageResponse | undefined): number | undefined {
  if (usage === undefined || usage.call_seconds_allowed === null) return undefined;
  return Math.max(0, usage.call_seconds_allowed - usage.call_seconds_used);
}

/** Which notice to show, if any, `elapsedMs` into a call that started with `remainingSeconds`. */
export function timeLeftNotice(
  remainingSeconds: number | undefined,
  elapsedMs: number,
): TimeLeftNotice | undefined {
  if (remainingSeconds === undefined) return undefined;
  const left = remainingSeconds - Math.max(0, elapsedMs) / 1000;
  if (left <= ONE_MINUTE_SECONDS) return 'one';
  if (left <= FIVE_MINUTES_SECONDS) return 'five';
  return undefined;
}
