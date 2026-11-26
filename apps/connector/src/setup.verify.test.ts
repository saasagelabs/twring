import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_CLOSE } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { saveConfig, type ConnectorConfig } from './config';
import { ensureDeviceKey } from './e2e/keys';

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

/**
 * A server that answers each claim with the next of `answers` and refuses the relay socket with
 * 4409 (replaced), so a plain run ends at once and keeps its pairing.
 */
async function relinkServer(answers: { status: number; body: unknown }[]) {
  const seen: { authorization?: string; body?: unknown }[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(text) as unknown });
      const answer = answers[Math.min(seen.length, answers.length) - 1];
      res.writeHead(answer?.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer?.body ?? {}));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.once('message', () => ws.close(RELAY_CLOSE.replaced, 'bye')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { seen, url: `http://localhost:${(server.address() as AddressInfo).port}/` };
}

const SAVED_TOKEN = `cct_${'t'.repeat(43)}`;
const NEW_ID = `con_${'n'.repeat(20)}`;
const NEW_TOKEN = `cct_${'n'.repeat(43)}`;
const gone = {
  status: 401,
  body: { error: { code: 'connector_invalid', message: 'This computer is no longer linked.' } },
};
const fresh = { status: 201, body: { connector_id: NEW_ID, token: NEW_TOKEN } };
const readSaved = async (dir: string) =>
  JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as ConnectorConfig;

describe('a plain run with --code on a machine that is already linked', () => {
  it('re-links with the saved token and keeps the link and its private-chat key', async () => {
    const dir = await tempDir();
    const claim = await relinkServer([
      { status: 200, body: { connector_id: `con_${'d'.repeat(20)}`, reused: true } },
    ]);
    const linked = ensureDeviceKey({ ...savedConfig(dir), server: claim.url }).config;
    const e2e = linked.e2e;
    await saveConfig(join(dir, 'config.json'), linked);
    const { stdout } = await runCli(dir, ['--code', 'ABCD-EFGH']);
    expect(claim.seen).toHaveLength(1);
    expect(claim.seen[0]?.authorization).toBe(`Bearer ${SAVED_TOKEN}`);
    expect(claim.seen[0]?.body).toMatchObject({ code: 'ABCD-EFGH', name: 'Laptop' });
    expect(lines(stdout).filter((l) => l.startsWith('Linked '))).toEqual([
      'Linked "Laptop" again with your Twring account.',
    ]);
    const saved = await readSaved(dir);
    expect(saved.token).toBe(SAVED_TOKEN);
    expect(saved.connector_id).toBe(`con_${'d'.repeat(20)}`);
    expect(saved.e2e).toEqual(e2e);
  }, 30_000);

  it('a code from another account: says how to start over, exits 2 and keeps the link', async () => {
    const dir = await tempDir();
    const claim = await relinkServer([
      {
        status: 403,
        body: {
          error: {
            code: 'pairing_other_account',
            message: 'This machine is linked to another Twring account.',
          },
        },
      },
    ]);
    await saveConfig(join(dir, 'config.json'), { ...savedConfig(dir), server: claim.url });
    const before = await readFile(join(dir, 'config.json'), 'utf8');
    const { code, stderr } = await runCli(dir, ['--code', 'ABCD-EFGH']);
    expect(lines(stderr)).toEqual([
      'This machine is linked to another Twring account. Run: node twring-connect.mjs uninstall --forget, then run this again.',
    ]);
    expect(code).toBe(2);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toBe(before);
  }, 30_000);

  it('a link the server no longer knows: pairs afresh with the same code', async () => {
    const dir = await tempDir();
    const claim = await relinkServer([gone, fresh]);
    await saveConfig(join(dir, 'config.json'), { ...savedConfig(dir), server: claim.url });
    await runCli(dir, ['--code', 'ABCD-EFGH', '--command', 'echo']);
    expect(claim.seen).toHaveLength(2);
    expect(claim.seen[0]?.authorization).toBe(`Bearer ${SAVED_TOKEN}`);
    expect(claim.seen[1]?.authorization).toBeUndefined();
    expect(claim.seen[1]?.body).toMatchObject({ code: 'ABCD-EFGH' });
    const saved = await readSaved(dir);
    expect(saved.connector_id).toBe(NEW_ID);
    expect(saved.token).toBe(NEW_TOKEN);
  }, 30_000);

  it('a link on another server than --server: no claim is sent', async () => {
    const dir = await tempDir();
    const claim = await relinkServer([fresh]);
    await saveConfig(join(dir, 'config.json'), savedConfig(dir));
    const { code, stderr } = await runCli(dir, ['--code', 'ABCD-EFGH', '--server', claim.url]);
    expect(stderr).toMatch(/^Already linked to https:\/\/cord\.example\.com\. /);
    expect(code).toBe(2);
    expect(claim.seen).toHaveLength(0);
  }, 30_000);
});

describe('setup on a machine whose link the server no longer knows', () => {
  it('pairs afresh with the same code', async () => {
    const dir = await tempDir();
    const claim = await relinkServer([gone, fresh]);
    await saveConfig(join(dir, 'config.json'), { ...savedConfig(dir), server: claim.url });
    const { stdout } = await runCli(dir, ['setup', '--code', 'ABCD-EFGH', '--command', 'echo']);
    expect(stdout).not.toContain('no longer linked');
    expect(claim.seen).toHaveLength(2);
    expect(claim.seen[1]?.authorization).toBeUndefined();
    const saved = await readSaved(dir);
    expect(saved.connector_id).toBe(NEW_ID);
    expect(saved.token).toBe(NEW_TOKEN);
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
