/**
 * Prints the daily report from the gateway's data folder, read-only. Built to dist/daily-report.js
 * and run on the server by the operations scripts:
 *
 *   node dist/daily-report.js --data-dir /var/lib/cord --cap-seconds 180000 [--days 7]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { z } from 'zod';

import { redemptionRecordSchema } from '../beta/invites';
import { feedbackRecordSchema } from '../calls/feedback-store';
import { refusalRowSchema } from '../calls/refusal-counter';
import { inviteRecordSchema } from '../ring/store';
import { historyRecordSchema } from '../store/repositories';
import { dailyReport, formatReport } from './daily';

/** Good rows of a store file; a missing file is empty. Never writes. */
async function readRows<T>(
  dir: string,
  name: string,
  schema: z.ZodType<T>,
): Promise<{ rows: T[]; skipped: number }> {
  let text: string;
  try {
    text = await readFile(join(dir, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], skipped: 0 };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never echo the parser's message: it can quote file contents.
    throw new Error(`${name} is not valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${name} is not a list`);
  const results = parsed.map((row) => schema.safeParse(row));
  const rows = results.flatMap((result) => (result.success ? [result.data] : []));
  return { rows, skipped: parsed.length - rows.length };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      'cap-seconds': { type: 'string' },
      days: { type: 'string', default: '7' },
    },
    strict: true,
  });
  const dir = values['data-dir'];
  const cap = Number(values['cap-seconds'] ?? '0');
  const days = Number(values.days);
  if (!dir) throw new Error('--data-dir is required');
  if (!Number.isInteger(cap) || cap < 0) throw new Error('--cap-seconds must be a whole number');
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error('--days must be 1 to 60');

  const [redemptions, history, rings, feedback, refusals] = await Promise.all([
    readRows(dir, 'invite-redemptions.json', redemptionRecordSchema),
    readRows(dir, 'call-history.json', historyRecordSchema),
    readRows(dir, 'ring-invites.json', inviteRecordSchema),
    readRows(dir, 'call-feedback.json', feedbackRecordSchema),
    readRows(dir, 'call-refusals.json', refusalRowSchema),
  ]);
  const report = dailyReport({
    now: new Date(),
    days,
    capSeconds: cap,
    redemptions: redemptions.rows,
    history: history.rows,
    rings: rings.rows,
    feedback: feedback.rows,
    refusals: refusals.rows,
  });
  process.stdout.write(`${formatReport(report)}\n`);
  const skipped =
    redemptions.skipped + history.skipped + rings.skipped + feedback.skipped + refusals.skipped;
  if (skipped > 0) process.stdout.write(`(${skipped} unreadable rows skipped)\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`daily-report: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
