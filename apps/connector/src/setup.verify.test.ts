import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { saveConfig, type ConnectorConfig } from './config';

/**
 * Verifier edge cases for `cord-connect setup` / `uninstall` / service mode (ADR-027), run as the
 * real process. Nothing here installs a service: every run gets an empty PATH (no systemctl,
 * crontab, launchctl or schtasks can be found) and a throwaway HOME and config folder.
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-setup-cli-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

/** The parent's environment without PATH (any spelling) and without a Twring server override. */
function isolatedEnv(dir: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^path$/i.test(key) || key.startsWith('CORD_')) continue;
    env[key] = value;
  }
  return {
    ...env,
    PATH: '',
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: dir,
    XDG_CONFIG_HOME: dir,
    CORD_CONNECT_CONFIG_DIR: dir,
    ...extra,
  };
}

function runCli(
  dir: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: isolatedEnv(dir, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const timer = setTimeout(() => child.kill(), 25_000);
  return new Promise((resolve) =>
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }),
  );
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const lines = (text: string) => text.split('\n').filter((l) => l.trim() !== '');

function savedConfig(dir: string): ConnectorConfig {
  return {
    server: 'https://cord.example.com/',
    connector_id: `con_${'d'.repeat(20)}`,
    token: `cct_${'t'.repeat(43)}`,
    name: 'Laptop',
    agents: [{ id: 'echo', label: 'Echo', kind: 'command', command: 'echo', args: [], cwd: dir }],
  };
}

describe('service mode without a usable pairing', () => {
  it('exits 78, which the service managers are told not to restart', async () => {
    const dir = await tempDir();
    const { code, stderr } = await runCli(dir, [], { CORD_CONNECT_SERVICE: '1' });
    expect(lines(stderr)).toHaveLength(1);
    expect(code).toBe(78);
  }, 30_000);

  it('exits 78 on a damaged pairing file too', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'config.json'), '{"server": 1}');
    const { code, stderr } = await runCli(dir, [], { CORD_CONNECT_SERVICE: '1' });
    expect(lines(stderr)).toHaveLength(1);
    expect(code).toBe(78);
  }, 30_000);
});

describe('setup failures print one line and exit non-zero', () => {
  it('a server that cannot be reached', async () => {
    const dir = await tempDir();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const { code, stdout, stderr } = await runCli(dir, [
      'setup',
      '--code',
      'ABCD-EFGH',
      '--server',
      `http://127.0.0.1:${port}`,
      '--command',
      'echo',
    ]);
    expect(lines(stdout)).toEqual([expect.stringMatching(/^Could not reach /)]);
    expect(stderr).toBe('');
    expect(code).toBe(1);
  }, 30_000);

  it('an expired code', async () => {
    const dir = await tempDir();
    const server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'pairing_invalid', message: 'Expired.' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as AddressInfo).port;
    const { code, stdout } = await runCli(dir, [
      'setup',
      '--code',
      'ABCD-EFGH',
      '--server',
      `http://localhost:${port}`,
      '--command',
      'echo',
    ]);
    expect(lines(stdout)).toEqual([
      'This code is wrong, used, or expired: ask for a new message in the Twring app.',
    ]);
    expect(code).toBe(1);
  }, 30_000);

  it('a machine already linked to another server (the message names the phone’s server)', async () => {
    const dir = await tempDir();
    await saveConfig(join(dir, 'config.json'), savedConfig(dir));
    const { code, stdout } = await runCli(dir, [
      'setup',
      '--code',
      'ABCD-EFGH',
      '--server',
      'https://other.example.com',
    ]);
    expect(lines(stdout).at(-1)).toMatch(/^Already linked to https:\/\/cord\.example\.com\. /);
    expect(code).toBe(2);
  }, 30_000);
});

/** A claim endpoint that records what it was sent and answers with `status` and `body`. */
async function claimServer(status: number, body: unknown) {
  const seen: { authorization?: string; body?: unknown }[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(text) as unknown });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { seen, url: `http://localhost:${(server.address() as AddressInfo).port}/` };
}

describe('setup on a machine that is already linked (re-link, ADR-027)', () => {
  it('claims the new code with the saved token instead of keeping the old link silently', async () => {
    const dir = await tempDir();
    const claim = await claimServer(200, { connector_id: `con_${'d'.repeat(20)}`, reused: true });
    await saveConfig(join(dir, 'config.json'), { ...savedConfig(dir), server: claim.url });
    const { stdout } = await runCli(dir, ['setup', '--code', 'ABCD-EFGH']);
    expect(claim.seen).toHaveLength(1);
    expect(claim.seen[0]?.authorization).toBe(`Bearer cct_${'t'.repeat(43)}`);
    expect(claim.seen[0]?.body).toMatchObject({ code: 'ABCD-EFGH', name: 'Laptop' });
    expect(stdout).not.toContain('Keeping that link');
    expect(stdout).not.toContain('another Twring account');
    // The saved link (and its token) is kept.
    const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as ConnectorConfig;
    expect(saved.token).toBe(`cct_${'t'.repeat(43)}`);
  }, 30_000);

  it('a code from another account: says how to start over and exits 2', async () => {
    const dir = await tempDir();
    const claim = await claimServer(403, {
      error: {
        code: 'pairing_other_account',
        message: 'This machine is linked to another Twring account.',
      },
    });
    await saveConfig(join(dir, 'config.json'), { ...savedConfig(dir), server: claim.url });
    const { code, stdout } = await runCli(dir, ['setup', '--code', 'ABCD-EFGH']);
    expect(lines(stdout)).toEqual([
      'This machine is linked to another Twring account. Run: node twring-connect.mjs uninstall --forget, then send the message again.',
    ]);
    expect(code).toBe(2);
    expect(await exists(join(dir, 'config.json'))).toBe(true);
  }, 30_000);
});

describe('uninstall', () => {
  it('leaves nothing of the service behind but keeps the pairing', async () => {
    const dir = await tempDir();
    await saveConfig(join(dir, 'config.json'), savedConfig(dir));
    for (const name of [
      'status.json',
      'cord-connect.log',
      'cord-connect.log.1',
      'cord-connect.pid',
    ]) {
      await writeFile(join(dir, name), 'x');
    }
    const { code } = await runCli(dir, ['uninstall']);
    expect(code).toBe(0);
    for (const name of [
      'status.json',
      'cord-connect.log',
      'cord-connect.log.1',
      'cord-connect.pid',
    ]) {
      expect(await exists(join(dir, name)), name).toBe(false);
    }
    expect(await exists(join(dir, 'config.json'))).toBe(true);
  }, 30_000);

  it('with --forget also removes the pairing', async () => {
    const dir = await tempDir();
    await saveConfig(join(dir, 'config.json'), savedConfig(dir));
    const { code } = await runCli(dir, ['uninstall', '--forget']);
    expect(code).toBe(0);
    expect(await exists(join(dir, 'config.json'))).toBe(false);
  }, 30_000);
});
