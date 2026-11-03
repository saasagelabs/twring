import { parseArgs } from 'node:util';

import { ZodError } from 'zod';

import { applyCodesOp, type CodesOp } from '../src/beta/codes-file';
import { hashCode, inviteCodesFileSchema } from '../src/beta/invites';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      count: { type: 'string' },
      uses: { type: 'string' },
      days: { type: 'string' },
      note: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const [kind, ...rest] = positionals;
  let op: CodesOp;
  if (kind === 'new' && rest.length === 0) {
    const number = (value: string | undefined): number | undefined =>
      value === undefined ? undefined : Number(value);
    op = {
      kind,
      ...(values.count && { count: number(values.count) }),
      ...(values.uses && { uses: number(values.uses) }),
      ...(values.days && { days: number(values.days) }),
      ...(values.note !== undefined && { note: values.note }),
    };
  } else if (kind === 'list' && rest.length === 0) op = { kind };
  else if (kind === 'revoke' && rest.length > 0) op = { kind, codes: rest };
  else
    throw new Error(
      'usage: new [--count N] [--uses N] [--days D] [--note TEXT] | list | revoke <code...>',
    );

  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += String(chunk);
  const envelope: unknown = JSON.parse(input);
  if (!envelope || typeof envelope !== 'object') throw new Error('invalid input envelope');
  const fields = envelope as Record<string, unknown>;
  const field = (key: string): string | undefined => {
    const value = fields[key];
    if (value === null) return undefined;
    if (typeof value !== 'string') throw new Error('invalid input envelope');
    return value;
  };
  const result = applyCodesOp(field('codes'), op, {
    autoCodes: field('autoCodes'),
    redemptions: field('redemptions'),
  });
  if (op.kind === 'new') {
    const created = inviteCodesFileSchema
      .parse(JSON.parse(result.next!))
      .codes.find((row) => row.hash === hashCode(result.newCodes[0]!));
    const expires = created?.expires_at.slice(0, 10);
    process.stderr.write(
      `New codes (uses ${op.uses ?? 1}, expire ${expires}, note ${op.note ?? ''}):\n`,
    );
    for (const code of result.newCodes) process.stderr.write(`${code}\n`);
  } else if (op.kind === 'list') {
    if (result.rows.length === 0) process.stderr.write('No invite codes yet.\n');
    for (const row of result.rows)
      process.stderr.write(
        `${row.hashPrefix}  ${row.note}  ${row.redeemed}/${row.uses}  ${row.expires}  ${row.status}\n`,
      );
  } else process.stderr.write(result.next ? 'Revoked.\n' : 'No matching owner codes.\n');
  if (result.next) process.stdout.write(result.next);
}

/** One readable line for the owner, also for option range errors (zod's JSON otherwise). */
function oneLine(error: unknown): string {
  if (error instanceof ZodError) {
    const code = error.issues[0]?.code;
    if (code === 'too_small' || code === 'too_big') {
      return 'out of range: --count 1–100, --uses 1–1000, --days 1–365, --note at most 80 characters';
    }
    return error.issues[0]?.message ?? 'invalid option';
  }
  return error instanceof Error ? error.message : 'failed';
}

main().catch((error: unknown) => {
  process.stderr.write(`invite-codes: ${oneLine(error)}\n`);
  process.exitCode = 1;
});
