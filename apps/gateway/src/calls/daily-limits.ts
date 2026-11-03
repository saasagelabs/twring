import type { MeUsageResponse } from '@twring/contracts';
import { z } from 'zod';

import type { Collection } from '../store/collection';

/**
 * Per-user daily calling allowance (UTC days). One row per user per day, kept in its own file so
 * it works whether or not saved agents are configured. Rows older than yesterday are pruned on
 * every write, so the file stays small and holds no history.
 */
export const dailyUsageRowSchema = z.object({
  user_id: z.string().min(1),
  /** UTC day, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  call_seconds: z.number().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type DailyUsageRow = z.infer<typeof dailyUsageRowSchema>;

/** 0 means unlimited. */
export interface DailyAllowance {
  callSeconds: number;
  calls: number;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export type Admission =
  | {
      admitted: true;
      /** The day the call counts against (its start day). */
      day: string;
      /** Calling seconds left today; undefined when unlimited. */
      remainingSeconds?: number;
    }
  /** `service`: the whole service's calling for today is used up, not this person's. */
  | { admitted: false; resetsAt: Date; service?: true };

/**
 * The service-wide daily cap on calling seconds (wave 1, task 4). Past it, new calls are refused;
 * calls in progress finish. `onThreshold` runs once a UTC day when 80% is first used.
 */
export interface ServiceCap {
  /** 0 means no cap. */
  callSeconds: number;
  onThreshold?: (usedSeconds: number, capSeconds: number) => void;
}

/** When the owner hears that today's calling is running out. */
export const SERVICE_ALERT_SHARE = 0.8;

export class DailyLimits {
  /** The UTC day the 80% alert last ran, so it runs once a day. */
  private alertedDay: string | undefined;

  constructor(
    private readonly rows: Collection<DailyUsageRow>,
    private readonly allowance: DailyAllowance,
    private readonly now: () => Date = () => new Date(),
    private readonly service: ServiceCap = { callSeconds: 0 },
  ) {}

  /** Today's use against the allowance, for `GET /v1/me/usage`. */
  async usage(userId: string): Promise<MeUsageResponse> {
    const now = this.now();
    const day = utcDay(now);
    const row = (await this.rows.read()).find((r) => r.user_id === userId && r.day === day);
    return {
      day,
      resets_at: nextUtcMidnight(now).toISOString(),
      call_seconds_used: Math.floor(row?.call_seconds ?? 0),
      call_seconds_allowed: this.allowance.callSeconds || null,
      calls_used: row?.calls ?? 0,
      calls_allowed: this.allowance.calls || null,
    };
  }

  /**
   * Admits and counts a new call, or refuses it when today's calls or seconds are used up. Check
   * and count happen under the collection lock, so parallel starts cannot pass the call limit.
   */
  admit(userId: string): Promise<Admission> {
    const now = this.now();
    const day = utcDay(now);
    const { callSeconds, calls } = this.allowance;
    const serviceCap = this.service.callSeconds;
    return this.rows.update<Admission>((items) => {
      const kept = prune(items, day);
      if (serviceCap > 0 && secondsOn(kept, day) >= serviceCap) {
        return {
          items: kept,
          result: { admitted: false, resetsAt: nextUtcMidnight(now), service: true },
        };
      }
      const row = kept.find((r) => r.user_id === userId && r.day === day);
      const usedSeconds = row?.call_seconds ?? 0;
      const usedCalls = row?.calls ?? 0;
      const remainingSeconds = callSeconds === 0 ? undefined : callSeconds - usedSeconds;
      if (
        (calls !== 0 && usedCalls >= calls) ||
        (remainingSeconds !== undefined && remainingSeconds < 1)
      ) {
        return { items: kept, result: { admitted: false, resetsAt: nextUtcMidnight(now) } };
      }
      return {
        items: upsert(kept, userId, day, (r) => ({ ...r, calls: r.calls + 1 })),
        result: {
          admitted: true,
          day,
          ...(remainingSeconds !== undefined && { remainingSeconds: Math.floor(remainingSeconds) }),
        },
      };
    });
  }

  /** Gives back an admitted call that never started (the server could not create it). */
  async refund(userId: string, day: string): Promise<void> {
    await this.rows.update((items) => ({
      items: items.map((r) =>
        r.user_id === userId && r.day === day ? { ...r, calls: Math.max(0, r.calls - 1) } : r,
      ),
      result: undefined,
    }));
  }

  /** Adds a finished call's seconds to the day it started on. */
  async addCallSeconds(userId: string, day: string, seconds: number): Promise<void> {
    if (!(seconds > 0)) return;
    const today = utcDay(this.now());
    const usedToday = await this.rows.update((items) => {
      const next = upsert(prune(items, today), userId, day, (r) => ({
        ...r,
        call_seconds: Math.round((r.call_seconds + seconds) * 10) / 10,
      }));
      return { items: next, result: secondsOn(next, today) };
    });
    this.maybeAlert(today, usedToday);
  }

  /** Outside the store lock and never awaited: a slow or failing alert cannot hold up a call. */
  private maybeAlert(today: string, usedSeconds: number): void {
    const { callSeconds: cap, onThreshold } = this.service;
    if (cap <= 0 || onThreshold === undefined || this.alertedDay === today) return;
    if (usedSeconds < cap * SERVICE_ALERT_SHARE) return;
    this.alertedDay = today;
    try {
      onThreshold(Math.floor(usedSeconds), cap);
    } catch {
      // The alert is best effort; the bookkeeping already happened.
    }
  }
}

/** Everyone's calling seconds counted against `day`. */
function secondsOn(items: readonly DailyUsageRow[], day: string): number {
  return items.reduce((sum, r) => (r.day === day ? sum + r.call_seconds : sum), 0);
}

/** Keeps today and yesterday (a call that started yesterday may still be finishing). */
function prune(items: readonly DailyUsageRow[], today: string): DailyUsageRow[] {
  const yesterday = utcDay(new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000));
  return items.filter((r) => r.day >= yesterday);
}

function upsert(
  items: readonly DailyUsageRow[],
  userId: string,
  day: string,
  change: (row: DailyUsageRow) => DailyUsageRow,
): DailyUsageRow[] {
  const index = items.findIndex((r) => r.user_id === userId && r.day === day);
  const current = items[index] ?? { user_id: userId, day, call_seconds: 0, calls: 0 };
  const next = change(current);
  return index === -1 ? [...items, next] : items.map((r, i) => (i === index ? next : r));
}
