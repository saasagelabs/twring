import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { feedbackRecordSchema } from '../src/calls/feedback-store';

const columns = [
  'created_at',
  'call_id',
  'agent_id',
  'protocol',
  'rating',
  'issues',
  'note',
  'app_version',
] as const;
const cell = (value: string | number | undefined) =>
  `"${String(value ?? '').replaceAll('"', '""')}"`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
  const out = values.out;
  if (!out || /[\r\n]/.test(out)) throw new Error('--out <file> is required');
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += String(chunk);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('call-feedback.json is not valid JSON');
  }
  const rows = feedbackRecordSchema.array().safeParse(parsed);
  if (!rows.success) throw new Error('call-feedback.json is not valid feedback data');
  const csv =
    [
      columns.join(','),
      ...rows.data.map((row) =>
        [
          row.created_at,
          row.call_id,
          row.agent_id,
          row.protocol,
          row.rating,
          row.issues.join(';'),
          row.note,
          row.app_version,
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\n') + '\n';
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, csv, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const count = rows.data.length;
  const average = count
    ? (rows.data.reduce((sum, row) => sum + row.rating, 0) / count).toFixed(2)
    : '0.00';
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = rows.data.filter((row) => Date.parse(row.created_at) >= since);
  const issueCount = (issue: 'cut_off' | 'misheard' | 'slow', items = rows.data) =>
    items.filter((row) => row.issues.includes(issue)).length;
  process.stdout.write(
    `Exported ${count} ratings to ${out}. Average stars: ${average}. Issues: cut_off ${issueCount('cut_off')}, misheard ${issueCount('misheard')}, slow ${issueCount('slow')}. Last 7 days: ${recent.length} ratings; cut_off ${issueCount('cut_off', recent)}, misheard ${issueCount('misheard', recent)}, slow ${issueCount('slow', recent)}.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `export-feedback: ${error instanceof Error ? error.message : 'export failed'}\n`,
  );
  process.exitCode = 1;
});
