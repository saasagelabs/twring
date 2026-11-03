import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { applyInvitesOp, type InvitesOp } from '../src/waitlist/invites-admin';

/**
 * Runner for the invite operations script. Reads the server's waitlist.json and invite-approvals.json from
 * `--dir` (a missing file means none yet), prints its lines on stderr, and the new approvals file
 * (if any) on stdout. Files, not arguments: a few hundred requests are too long for a command line.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { all: { type: 'boolean' }, dir: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [kind, ...rest] = positionals;
  let op: InvitesOp;
  if (kind === 'pending' && rest.length === 0) op = { kind };
  else if (kind === 'status' && rest.length === 0) op = { kind };
  else if (kind === 'approve' && values.all === true && rest.length === 0) op = { kind, all: true };
  else if (kind === 'approve' && values.all !== true && rest.length > 0)
    op = { kind, emails: rest };
  else throw new Error('usage: pending | status | approve --all | approve <email...>');
  if (values.dir === undefined) throw new Error('--dir is required');

  const read = (name: string) =>
    readFile(join(values.dir!, name), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  const out = applyInvitesOp(
    await read('waitlist.json'),
    await read('invite-approvals.json'),
    op,
    new Date(),
  );
  for (const line of out.lines) process.stderr.write(`${line}\n`);
  if (out.next !== undefined) process.stdout.write(out.next);
}

main().catch((error: unknown) => {
  process.stderr.write(`invites: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
