/**
 * How many calls were refused before they started (lines busy, daily limit, Twring busy or
 * updating), per UTC day and reason, for the daily report. Counts only: no person.
 */
import { errorCodeSchema, type ErrorCode } from '@twring/contracts';
import { z } from 'zod';

import type { Collection } from '../store/collection';
import { utcDay } from './daily-limits';

/** Rows older than this are dropped on the next count. */
const KEEP_DAYS = 60;

/**
 * The refusals that mean Twring itself was full, busy or down. A retry (rate_limited), a double
 * tap (call_in_progress) or an agent that is missing or offline says nothing about capacity.
 */
const COUNTED: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'capacity_exceeded',
  'daily_limit_reached',
  'service_busy',
  'service_unavailable',
]);

export const refusalRowSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  code: errorCodeSchema,
  count: z.number().int().positive(),
});
export type RefusalRow = z.infer<typeof refusalRowSchema>;

export class RefusalCounter {
  constructor(
    private readonly rows: Collection<RefusalRow>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  count(code: ErrorCode): Promise<void> {
    if (!COUNTED.has(code)) return Promise.resolve();
    const at = this.now();
    const day = utcDay(at);
    const oldest = utcDay(new Date(at.getTime() - KEEP_DAYS * 86_400_000));
    return this.rows.update((items) => {
      const kept = items.filter((row) => row.day >= oldest);
      const found = kept.find((row) => row.day === day && row.code === code);
      return {
        items: found
          ? kept.map((row) => (row === found ? { ...row, count: row.count + 1 } : row))
          : [...kept, { day, code, count: 1 }],
        result: undefined,
      };
    });
  }
}
