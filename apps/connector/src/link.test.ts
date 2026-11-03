import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_CLOSE } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { defaultServer, loadConfig, PRODUCTION_SERVER } from './config';
import { bigCode, computerName, linkComputer, terminalQr } from './link';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CONNECTOR_ID = `con_${'k'.repeat(20)}`;
const TOKEN = `cct_${'z'.repeat(43)}`;
const POLL_TOKEN = `clp_${'p'.repeat(43)}`;
const REQUEST_ID = `link_${'r'.repeat(20)}`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type PollAnswer = { status: number; body?: unknown };

/** A scripted gateway: the link request, then each poll's answer in turn, then the relay socket. */
async function fakeGateway(polls: PollAnswer[]) {
  const seen: { created?: unknown; authorizations: string[] } = { authorizations: [] };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/v1/connectors/link-requests') {
      let text = '';
      req.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      req.on('end', () => {
        seen.created = JSON.parse(text);
        send(201, {
          request_id: REQUEST_ID,
          code: 'ABCD-EFGH',
          poll_token: POLL_TOKEN,
          expires_at: '2026-10-01T09:10:00.000Z',
          server_time: '2026-10-01T09:00:00.000Z',
        });
      });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith(`/v1/connectors/link-requests/${REQUEST_ID}`)) {
      seen.authorizations.push(req.headers.authorization ?? '');
      const next = polls.shift() ?? { status: 200, body: { status: 'pending' } };
      send(next.status, next.body);
      return;
    }
    send(404, {});
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.once('message', () => ws.close(RELAY_CLOSE.replaced, 'bye')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        wss.close();
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

function runCli(configDir: string, server: string) {
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

describe('cord-connect computer-first linking', () => {
  it('shows a QR code and the code, then saves the pairing once the phone approves', async () => {
    const g = await fakeGateway([
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: { status: 'approved', connector_token: TOKEN, connector_id: CONNECTOR_ID },
      },
    ]);
    const dir = await tempDir();
    const { stdout, stderr } = await runCli(dir, g.url);
    expect(stdout, stderr).toContain('On my computer → Scan');
    expect(stdout).toContain(bigCode('ABCD-EFGH'));
    expect(stdout).toContain('Linked "Desk"');
    expect(g.seen.created).toMatchObject({
      computer_name: 'Desk',
      agents: [{ local_agent: 'custom', kind: 'command', label: 'Echo' }],
    });
    expect(g.seen.authorizations.every((h) => h === `Bearer ${POLL_TOKEN}`)).toBe(true);
    const saved = await loadConfig(join(dir, 'config.json'));
    expect(saved).toMatchObject({ connector_id: CONNECTOR_ID, token: TOKEN, name: 'Desk' });
    // The token is never printed.
    expect(stdout).not.toContain(TOKEN);
  }, 30_000);

  it('says the code expired and saves nothing', async () => {
    const g = await fakeGateway([{ status: 200, body: { status: 'expired' } }]);
    const dir = await tempDir();
    const { code, stderr } = await runCli(dir, g.url);
    expect(code).toBe(1);
    expect(stderr).toContain('The code expired. Run twring-connect again.');
    expect(await loadConfig(join(dir, 'config.json'))).toBeUndefined();
  }, 30_000);

  it('says linking was cancelled when the phone says no', async () => {
    const g = await fakeGateway([{ status: 200, body: { status: 'rejected' } }]);
    const dir = await tempDir();
    const { code, stderr } = await runCli(dir, g.url);
    expect(code).toBe(1);
    expect(stderr).toContain('Linking was cancelled on your phone.');
  }, 30_000);
});

describe('linkComputer', () => {
  it('keeps polling through a network blip and a server error', async () => {
    const g = await fakeGateway([
      { status: 502 },
      { status: 200, body: { nonsense: true } },
      {
        status: 200,
        body: { status: 'approved', connector_token: TOKEN, connector_id: CONNECTOR_ID },
      },
    ]);
    const lines: string[] = [];
    const outcome = await linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: [{ local_agent: 'codex', kind: 'codex', label: 'Codex' }],
      print: (line) => lines.push(line),
      retryMs: 10,
      waitS: 0,
    });
    expect(outcome).toEqual({ kind: 'approved', connectorId: CONNECTOR_ID, token: TOKEN });
  });

  it('treats a forgotten request as expired', async () => {
    const g = await fakeGateway([{ status: 404, body: {} }]);
    const outcome = await linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: [{ local_agent: 'codex', kind: 'codex', label: 'Codex' }],
      print: () => undefined,
      waitS: 0,
    });
    expect(outcome).toEqual({ kind: 'expired' });
  });

  it('keeps the typed code when the QR code cannot be drawn', async () => {
    const g = await fakeGateway([{ status: 200, body: { status: 'rejected' } }]);
    const lines: string[] = [];
    await linkComputer({
      server: new URL(g.url),
      computerName: 'Desk',
      agents: [{ local_agent: 'codex', kind: 'codex', label: 'Codex' }],
      print: (line) => lines.push(line),
      renderQr: () => {
        throw new Error('no');
      },
    });
    expect(lines.join('\n')).toContain('Or type this code:   A B C D - E F G H');
  });
});

describe('helpers', () => {
  it('cleans host names for the app', () => {
    expect(computerName('  studio\u202e-mac\n ')).toBe('studio-mac');
    expect(computerName('x'.repeat(60))).toHaveLength(40);
    expect(computerName('\u0000')).toBe('My computer');
  });

  it('draws a QR code, or nothing when drawing fails', () => {
    expect(terminalQr('cord://link?code=ABCDEFGH')?.split('\n').length).toBeGreaterThan(10);
    expect(
      terminalQr('x', () => {
        throw new Error('no');
      }),
    ).toBeUndefined();
  });

  it('uses CORD_SERVER, then the staging server', () => {
    expect(defaultServer({ CORD_SERVER: 'https://cord.example.com' })).toBe(
      'https://cord.example.com',
    );
    expect(defaultServer({})).toBe(PRODUCTION_SERVER);
  });
});
