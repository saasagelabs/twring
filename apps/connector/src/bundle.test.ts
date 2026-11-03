import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * The one file agents download (ADR-027): `dist/cord-connect.mjs`. Its Node check must run on old
 * Nodes: a file is parsed and its static imports linked before any of it runs, so the check cannot
 * sit inside a bundle that uses new syntax or new built-in modules.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUNDLE = join(ROOT, 'dist', 'twring-connect.mjs');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

beforeAll(() => {
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'bundle.mjs')], {
    encoding: 'utf8',
  });
  expect(built.status, built.stderr).toBe(0);
}, 60_000);

/** A preload that makes this Node look like Node 16: older version, no `readline/promises`. */
async function oldNodePreload(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-bundle-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const hooks = `export async function resolve(specifier, context, next) {
  if (specifier === 'node:readline/promises' || specifier === 'readline/promises') {
    const error = new Error('No such built-in module: ' + specifier);
    error.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw error;
  }
  return next(specifier, context);
}`;
  const preload = join(dir, 'old-node.mjs');
  await writeFile(
    preload,
    `import { register } from 'node:module';
Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.2' } });
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});
`,
  );
  return pathToFileURL(preload).href;
}

describe('the downloadable cord-connect.mjs', () => {
  it('runs', () => {
    const run = spawnSync(process.execPath, [BUNDLE, '--help'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('setup --code');
  });

  it('includes the Twring skill', async () => {
    expect(await readFile(BUNDLE, 'utf8')).toContain('name: twring');
  });

  it('on an old Node says so in one line, before loading anything newer', async () => {
    const run = spawnSync(
      process.execPath,
      ['--import', await oldNodePreload(), BUNDLE, 'setup', '--code', 'ABCD-EFGH'],
      { encoding: 'utf8' },
    );
    expect(run.stderr).toBe(
      'Node 16 is too old: install Node.js 20 or newer, then run this again.\n',
    );
    expect(run.stdout).toBe('');
    expect(run.status).toBe(1);
  });

  it('keeps its first part in syntax an old Node can parse', async () => {
    const text = await readFile(BUNDLE, 'utf8');
    // The bundled connector is one string literal, compiled only after the check passed.
    const outer = text
      .split('\n')
      .filter((line) => !line.startsWith('var code = '))
      .join('\n');
    expect(outer.length).toBeLessThan(5_000);
    expect(outer).not.toMatch(/\?\.|\?\?|=>|`|\bclass\b|\blet\b|\bconst\b|\basync\b|\bawait\b/);
    const imports = [...outer.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.every((name) => name === 'module' || name === 'url' || name === 'vm')).toBe(
      true,
    );
  });
});
