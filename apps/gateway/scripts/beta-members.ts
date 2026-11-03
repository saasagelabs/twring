import { parseArgs } from 'node:util';

import { applyMembersOp, type MembersOp } from '../src/beta/manage';

async function main(): Promise<void> {
  let positionals: string[];
  let missing: boolean | undefined;
  try {
    ({
      positionals,
      values: { missing },
    } = parseArgs({
      options: { missing: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    }));
  } catch {
    throw new Error('usage: <list|add|remove> [emails...] [--missing]');
  }

  const [kind, ...emails] = positionals;
  if (kind !== 'list' && kind !== 'add' && kind !== 'remove') {
    throw new Error('usage: <list|add|remove> [emails...] [--missing]');
  }
  if (kind === 'list' && emails.length > 0) {
    throw new Error('list takes no emails');
  }
  const op: MembersOp = kind === 'list' ? { kind } : { kind, emails };

  let current: string | undefined;
  if (!missing) {
    process.stdin.setEncoding('utf8');
    current = '';
    try {
      for await (const chunk of process.stdin) current += String(chunk);
    } catch {
      throw new Error('could not read beta-members.json from stdin');
    }
  }

  const result = applyMembersOp(current, op);
  if (kind === 'list') {
    process.stderr.write(`Members (${result.emails.length}):\n`);
    for (const email of result.emails) process.stderr.write(`${email}\n`);
  } else {
    if (result.added.length > 0) process.stderr.write(`Added: ${result.added.join(', ')}\n`);
    if (result.removed.length > 0) process.stderr.write(`Removed: ${result.removed.join(', ')}\n`);
    if (result.unchanged.length > 0) {
      process.stderr.write(`Already as asked: ${result.unchanged.join(', ')}\n`);
    }
    process.stderr.write(`Members now: ${result.emails.length}\n`);
  }

  // No change (list, or nothing to do): exit 0 with nothing on stdout. An exit code can't signal
  // it: pnpm exec turns any non-zero code into 1.
  if (result.next !== undefined) process.stdout.write(result.next);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'failed';
  process.stderr.write(`beta-members: ${message}\n`);
  process.exitCode = 1;
});
