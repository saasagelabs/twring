import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, saveConfig } from './config';
import { linkComputer, linkedLines, serverConflict } from './link';

/** Follow-ups to computer-first linking (ADR-025): owner name, cancelling, a saved server. */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CONNECTOR_ID = `con_${'k'.repeat(20)}`;
const TOKEN = `cct_${'z'.repeat(43)}`;
const POLL_TOKEN = `clp_${'p'.repeat(43)}`;
const REQUEST_ID = `link_${'r'.repeat(20)}`;
const AGENTS = [{ local_agent: 'codex', kind: 'codex' as const, label: 'Codex' }];

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A gateway that answers polls from a script and records cancels. */
async function fakeGateway(pollBody: () => unknown, options: { hangCancel?: boolean } = {}) {
  const seen = { cancels: [] as string[], polls: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/v1/connectors/link-requests') {
      req.resume();
      req.on('end', () =>
        send(201, {
          request_id: REQUEST_ID,
          code: 'ABCD-EFGH',
          poll_token: POLL_TOKEN,
          expires_at: '2026-10-01T09:10:00.000Z',
          server_time: '2026-10-01T09:00:00.000Z',
        }),
      );
      return;
    }
    if (req.url?.startsWith(`/v1/connectors/link-requests/${REQUEST_ID}`)) {
      if (req.method === 'DELETE') {
        seen.cancels.push(req.headers.authorization ?? '');
        if (options.hangCancel === true) return; // never answers
        res.writeHead(204);
        res.end();
        return;
      }
      seen.polls += 1;
      send(200, pollBody());
      return;
    }
    send(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, seen };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-link-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

function runCli(configDir: string, server: string, extra: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      CLI,
      '--command',
      'echo',
      '--command-label',
      'Echo',
      '--agents',
      'custom',
      '--name',
      'Desk',
      ...extra,
    ],
    {
      env: { ...process.env, CORD_CONNECT_CONFIG_DIR: configDir, CORD_SERVER: server },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const timer = setTimeout(() => child.kill(), 20_000);
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    }),
  );
}

describe('whose account the computer joined', () => {
  it('prints the owner and how to undo it', () => {
    expect(linkedLines('Desk', 'Alice')).toEqual([
      "Linked to Alice's Twring account. If that isn't you, press Ctrl+C and run twring-connect --forget.",
    ]);
    expect(linkedLines('Desk', undefined)).toEqual(['Linked "Desk" with your Twring account.']);
  });

  it('carries owner_name from the approval', async () => {
    const g = await fakeGateway(() => ({
      status: 'approved',
      connector_token: TOKEN,
      connector_id: CONNECTOR_ID,
      owner_name: 'g***@gmail.com',
    }));
    const outcome = await linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      waitS: 0,
    });
    expect(outcome).toEqual({
      kind: 'approved',
      connectorId: CONNECTOR_ID,
      token: TOKEN,
      ownerName: 'g***@gmail.com',
    });
  });

  it('the CLI prints the owner line once linked', async () => {
    const g = await fakeGateway(() => ({
      status: 'approved',
      connector_token: TOKEN,
      connector_id: CONNECTOR_ID,
      owner_name: 'Alice',
    }));
    const dir = await tempDir();
    const { stdout, stderr } = await runCli(dir, g.url);
    expect(stdout, stderr).toContain(
      "Linked to Alice's Twring account. If that isn't you, press Ctrl+C and run twring-connect --forget.",
    );
  }, 30_000);
});

describe('cancelling while linking', () => {
  it('withdraws the request with its poll token when aborted', async () => {
    const g = await fakeGateway(() => ({ status: 'pending' }));
    const stop = new AbortController();
    const linking = linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      waitS: 0,
      signal: stop.signal,
    });
    while (g.seen.polls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    stop.abort();
    await expect(linking).rejects.toThrow('Cancelled.');
    expect(g.seen.cancels).toEqual([`Bearer ${POLL_TOKEN}`]);
  });

  it('gives up on a cancel the server never answers, within its deadline', async () => {
    const g = await fakeGateway(() => ({ status: 'pending' }), { hangCancel: true });
    const stop = new AbortController();
    const linking = linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      waitS: 0,
      signal: stop.signal,
      cancelTimeoutMs: 100,
    });
    while (g.seen.polls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    stop.abort();
    await expect(linking).rejects.toThrow('Cancelled.');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(g.seen.cancels).toHaveLength(1);
  });
});

describe('--server with a saved pairing', () => {
  it('matches the same server however it is written', () => {
    expect(serverConflict('https://cord.example.com/', new URL('https://CORD.example.com'))).toBe(
      undefined,
    );
    expect(serverConflict('https://cord.example.com', new URL('https://other.example.com'))).toBe(
      'Already linked to https://cord.example.com. Run twring-connect --forget first to link to a different server.',
    );
  });

  it('the CLI refuses a different server with exit code 2 and keeps the pairing', async () => {
    const dir = await tempDir();
    const config = {
      server: 'https://cord.example.com/',
      connector_id: CONNECTOR_ID,
      token: TOKEN,
      name: 'Desk',
      agents: [
        {
          id: 'custom',
          label: 'Echo',
          kind: 'command' as const,
          command: 'echo',
          args: [],
          cwd: dir,
        },
      ],
    };
    await saveConfig(join(dir, 'config.json'), config);
    const { code, stderr } = await runCli(dir, 'https://cord.example.com', [
      '--server',
      'https://other.example.com',
    ]);
    expect(code, stderr).toBe(2);
    expect(stderr).toContain(
      'Already linked to https://cord.example.com. Run twring-connect --forget first to link to a different server.',
    );
    expect(await loadConfig(join(dir, 'config.json'))).toMatchObject({
      connector_id: CONNECTOR_ID,
    });
  }, 30_000);
});
