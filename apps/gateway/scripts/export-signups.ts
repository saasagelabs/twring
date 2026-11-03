import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

import { signupsCsv } from '../src/waitlist/export';

async function main(): Promise<void> {
  let values: { out?: string; source?: string; all?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        out: { type: 'string' },
        source: { type: 'string' },
        all: { type: 'boolean' },
      },
      strict: true,
    }));
  } catch {
    throw new Error('usage: --out <file> [--source beta|landing] [--all]');
  }

  const { out, source, all } = values;
  if (!out || /[\r\n]/.test(out)) {
    throw new Error('--out <file> is required');
  }
  if (source !== undefined && source !== 'beta' && source !== 'landing' && source !== 'app') {
    throw new Error('--source must be beta, landing or app');
  }

  process.stdin.setEncoding('utf8');
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += String(chunk);
    }
  } catch {
    throw new Error('could not read waitlist.json from stdin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('waitlist.json is not valid JSON');
  }

  const { csv, counts } = signupsCsv(parsed, { source, includeInternal: all });
  try {
    await mkdir(dirname(out), { recursive: true });
  } catch {
    throw new Error('could not create output directory');
  }
  try {
    await writeFile(out, csv, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('output file already exists', { cause: error });
    }
    throw new Error('could not write output file', { cause: error });
  }

  let message = `Exported ${counts.exported} signups (${counts.beta} beta, ${counts.landing} landing, ${counts.app} app) to ${out}.`;
  if (counts.skippedInternal > 0) {
    message += ` Left out ${counts.skippedInternal} @twring.com test addresses (use --all to include them).`;
  }
  if (source !== undefined) {
    message += ` Skipped ${counts.skippedFiltered} from other sources.`;
  }
  process.stdout.write(`${message}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'export failed';
  process.stderr.write(`export-signups: ${message}\n`);
  process.exitCode = 1;
});
