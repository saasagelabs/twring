import type { RelayPushRequest } from '@twring/contracts';

import type { RelayDb } from './db';

type PushKind = RelayPushRequest['kind'];
/** Minutes of Twring-run call audio, counted when a session ends. */
export type UsageKind = PushKind | 'audio_minutes';

/** Pushes delivered (and audio minutes) per install per UTC day by kind. Counts only. */
export class UsageStore {
  constructor(private readonly db: RelayDb) {}

  count(installId: string, kind: UsageKind, now: number): void {
    this.add(installId, kind, 1, now);
  }

  add(installId: string, kind: UsageKind, amount: number, now: number): void {
    this.db.sqlite
      .prepare(
        `INSERT INTO usage_daily (install_id, day, kind, count) VALUES (?, ?, ?, ?)
         ON CONFLICT (install_id, day, kind) DO UPDATE SET count = count + excluded.count`,
      )
      .run(installId, new Date(now).toISOString().slice(0, 10), kind, amount);
  }

  /** One install's counts for one day (`YYYY-MM-DD`). */
  forDay(installId: string, day: string): Partial<Record<UsageKind, number>> {
    const rows = this.db.sqlite
      .prepare('SELECT kind, count FROM usage_daily WHERE install_id = ? AND day = ?')
      .all(installId, day) as { kind: UsageKind; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  }

  /** One kind's total across every install for one day (`YYYY-MM-DD`). */
  totalForDay(kind: UsageKind, day: string): number {
    const row = this.db.sqlite
      .prepare('SELECT COALESCE(SUM(count), 0) AS n FROM usage_daily WHERE day = ? AND kind = ?')
      .get(day, kind) as { n: number };
    return row.n;
  }
}
