import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * `hooks install` from the real command line: the hook it writes runs this computer's Node and the
 * connector itself, never `npx` (the connector is not on npm, so `npx` would fetch someone else's
 * package of that name).
 */
const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function run(home: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CORD_CONNECT_CONFIG_DIR: join(home, 'config'),
    },
  });
}

describe('hooks install from the command line', () => {
  it('claude: the hook runs node and this connector, with no npx', async () => {
    const home = await mkdtemp(join(tmpdir(), 'twring-hooks-cli-'));
    temps.push(home);
    const out = run(home, ['hooks', 'install', 'claude']);
    expect(out.status, out.stderr).toBe(0);
    const settings = JSON.parse(await readFile(join(home, '.claude', 'settings.json'), 'utf8')) as {
      hooks: { Notification: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.Notification[0]!.hooks[0]!.command;
    // The npx command, not the letters (a checkout folder may well be called something-npx).
    expect(command).not.toMatch(/(^|\s)npx\s/);
    expect(command).toContain(process.execPath.replace(/\\/g, '/'));
    expect(command).toContain('cli.ts');
    expect(command).toMatch(/ ring --from-hook claude$/);
  });

  it('codex: without --on-turn-complete nothing is written', async () => {
    const home = await mkdtemp(join(tmpdir(), 'twring-hooks-cli-'));
    temps.push(home);
    const out = run(home, ['hooks', 'install', 'codex']);
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('off by default');
    await expect(readFile(join(home, '.codex', 'config.toml'), 'utf8')).rejects.toThrow();
  });
});
