import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLinkInput, linkQrPayload, RELAY_CLOSE } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { defaultServer, saveConfig, PRODUCTION_SERVER } from './config';
import { computerName, linkComputer } from './link';

/** Edge cases for `cord-connect` computer-first linking (ADR-025). */

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

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that creates a request living `lifeMs`, then answers each poll with `poll`. */
function scriptedFetch(lifeMs: number, poll: (signal?: AbortSignal) => Promise<Response>) {
  const serverTime = Date.parse('2026-10-01T09:00:00.000Z');
  let polls = 0;
  const fetchFn = ((url: string | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve(
        json(201, {
          request_id: REQUEST_ID,
          code: 'ABCD-EFGH',
          poll_token: POLL_TOKEN,
          expires_at: new Date(serverTime + lifeMs).toISOString(),
          server_time: new Date(serverTime).toISOString(),
        }),
      );
    }
    polls += 1;
    return poll(init?.signal ?? undefined);
  }) as typeof fetch;
  return { fetchFn, polls: () => polls };
}

describe('linkComputer edges', () => {
  it('gives up once the code has expired when the server stays unreachable', async () => {
    const { fetchFn } = scriptedFetch(300, () => Promise.reject(new TypeError('fetch failed')));
    const outcome = await Promise.race([
      linkComputer({
        server: new URL('https://cord.example.com'),
        computerName: 'Desk',
        agents: AGENTS,
        print: () => undefined,
        fetch: fetchFn,
        retryMs: 20,
        waitS: 0,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    expect(outcome).toEqual({ kind: 'expired' });
  }, 10_000);

  it('gives up once the code has expired when the server keeps failing', async () => {
    const { fetchFn } = scriptedFetch(300, () => Promise.resolve(json(503, {})));
    const outcome = await Promise.race([
      linkComputer({
        server: new URL('https://cord.example.com'),
        computerName: 'Desk',
        agents: AGENTS,
        print: () => undefined,
        fetch: fetchFn,
        retryMs: 20,
        waitS: 0,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    expect(outcome).toEqual({ kind: 'expired' });
  }, 10_000);

  it('gives up on a poll whose connection went quiet, then stops at expiry', async () => {
    // No answer and no reset: only the request's own signal can end it.
    const { fetchFn, polls } = scriptedFetch(
      300,
      (signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('timeout', 'TimeoutError')),
          ),
        ),
    );
    const outcome = await Promise.race([
      linkComputer({
        server: new URL('https://cord.example.com'),
        computerName: 'Desk',
        agents: AGENTS,
        print: () => undefined,
        fetch: fetchFn,
        retryMs: 20,
        waitS: 0,
        pollSlackMs: 50,
      }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 3_000)),
    ]);
    expect(outcome).toEqual({ kind: 'expired' });
    expect(polls()).toBeGreaterThan(1);
  }, 10_000);

  it('does not pile abort listeners on the signal while retrying', async () => {
    let failures = 0;
    const stop = new AbortController();
    const { fetchFn } = scriptedFetch(60_000, () => {
      failures += 1;
      if (failures > 30) stop.abort();
      return Promise.reject(new TypeError('fetch failed'));
    });
    let most = 0;
    const timer = setInterval(() => {
      most = Math.max(most, getEventListeners(stop.signal, 'abort').length);
    }, 1);
    await linkComputer({
      server: new URL('https://cord.example.com'),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      fetch: fetchFn,
      signal: stop.signal,
      retryMs: 5,
      waitS: 0,
    }).catch(() => undefined);
    clearInterval(timer);
    most = Math.max(most, getEventListeners(stop.signal, 'abort').length);
    expect(failures).toBeGreaterThan(30);
    expect(most).toBeLessThanOrEqual(2);
  });

  it('stops at once on Ctrl+C during a long poll', async () => {
    const stop = new AbortController();
    const { fetchFn } = scriptedFetch(
      60_000,
      (signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
    );
    const running = linkComputer({
      server: new URL('https://cord.example.com'),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      fetch: fetchFn,
      signal: stop.signal,
      // The withdrawal hangs here too; it is best effort within its own deadline.
      cancelTimeoutMs: 100,
    });
    setTimeout(() => stop.abort(), 50);
    const started = Date.now();
    await expect(running).rejects.toThrow('Cancelled.');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops polling as soon as the phone cancels', async () => {
    const { fetchFn, polls } = scriptedFetch(60_000, () =>
      Promise.resolve(json(200, { status: 'rejected' })),
    );
    const outcome = await linkComputer({
      server: new URL('https://cord.example.com'),
      computerName: 'Desk',
      agents: AGENTS,
      print: () => undefined,
      fetch: fetchFn,
    });
    expect(outcome).toEqual({ kind: 'rejected' });
    expect(polls()).toBe(1);
  });

  it('never prints the poll token or the connector token', async () => {
    const answers = [
      json(500, { error: { code: 'internal', message: 'boom', request_id: 'r' } }),
      json(200, { status: 'approved', connector_token: TOKEN, connector_id: CONNECTOR_ID }),
    ];
    const { fetchFn } = scriptedFetch(60_000, () => Promise.resolve(answers.shift()!));
    const lines: string[] = [];
    await linkComputer({
      server: new URL('https://cord.example.com'),
      computerName: 'Desk',
      agents: AGENTS,
      print: (line) => lines.push(line),
      fetch: fetchFn,
      retryMs: 1,
    });
    expect(lines.join('\n')).not.toContain(POLL_TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('puts exactly the server it talks to in the QR code', () => {
    for (const server of [
      PRODUCTION_SERVER,
      'https://cord.example.com/',
      'http://localhost:8080',
    ]) {
      const url = new URL(server);
      expect(parseLinkInput(linkQrPayload('ABCD-EFGH', url.toString()))).toEqual({
        code: 'ABCD-EFGH',
        server: url.toString().replace(/\/+$/, ''),
      });
    }
  });
});

describe('computer names', () => {
  it('never cuts an emoji in half', () => {
    const name = computerName(`${'a'.repeat(39)}\u{1F4BB}`);
    expect(name).not.toMatch(/[\ud800-\udbff]$/);
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it('drops invisible and direction marks the server refuses', () => {
    expect(computerName('Work\u200blap\u200ftop\ufeff\u2060\u061c\u200e')).toBe('Worklaptop');
  });
});

describe('server choice', () => {
  it('prefers CORD_SERVER, then the older CORD_CONNECT_SERVER, then staging', () => {
    expect(
      defaultServer({ CORD_SERVER: 'https://a.example', CORD_CONNECT_SERVER: 'https://b.example' }),
    ).toBe('https://a.example');
    expect(defaultServer({ CORD_CONNECT_SERVER: 'https://b.example' })).toBe('https://b.example');
    // An empty CORD_SERVER is "not set", not "use staging".
    expect(defaultServer({ CORD_SERVER: '', CORD_CONNECT_SERVER: 'https://b.example' })).toBe(
      'https://b.example',
    );
    expect(defaultServer({ CORD_SERVER: '' })).toBe(PRODUCTION_SERVER);
  });
});

/** A gateway that records link requests and accepts one relay socket, then says "replaced". */
async function relayOnlyGateway() {
  const seen = { linkRequests: 0, sockets: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/v1/connectors/link-requests')) seen.linkRequests += 1;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    seen.sockets += 1;
    ws.once('message', () => ws.close(RELAY_CLOSE.replaced, 'bye'));
  });
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

describe('cord-connect with a saved pairing', () => {
  it('just connects; it never starts linking', async () => {
    const g = await relayOnlyGateway();
    const dir = await mkdtemp(join(tmpdir(), 'cord-link-edge-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await saveConfig(join(dir, 'config.json'), {
      server: g.url,
      connector_id: CONNECTOR_ID,
      token: TOKEN,
      name: 'Desk',
      agents: [
        { id: 'custom', label: 'Echo', kind: 'command', command: 'echo', args: [], cwd: dir },
      ],
    });
    const child = spawn(process.execPath, ['--import', 'tsx', CLI], {
      // A different CORD_SERVER must not matter either: the saved pairing names its server.
      env: {
        ...process.env,
        CORD_CONNECT_CONFIG_DIR: dir,
        CORD_SERVER: 'https://elsewhere.example',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 20_000);
    await new Promise((resolve) => child.once('exit', resolve));
    clearTimeout(timer);
    expect(g.seen.linkRequests).toBe(0);
    expect(g.seen.sockets).toBe(1);
    expect(stdout).not.toContain('Scan');
  }, 30_000);
});
