import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELAY_CLOSE } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { deleteConfigIfOwned, saveConfig, type ConnectorConfig } from './config';
import { readStatus } from './service';

/** The real `cord-connect` process against a scripted gateway. */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CONNECTOR_ID = `con_${'d'.repeat(20)}`;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-cli-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

async function gatewayClosingWith(code: number): Promise<string> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => new Promise((resolve) => wss.close(() => resolve())));
  await new Promise((resolve) => wss.once('listening', resolve));
  wss.on('connection', (ws) => ws.once('message', () => ws.close(code, 'bye')));
  return `http://localhost:${(wss.address() as AddressInfo).port}`;
}

function config(server: string, dir: string, connectorId = CONNECTOR_ID): ConnectorConfig {
  return {
    server,
    connector_id: connectorId,
    token: `cct_${'t'.repeat(43)}`,
    name: 'Laptop',
    agents: [{ id: 'echo', label: 'Echo', kind: 'command', command: 'echo', args: [], cwd: dir }],
  };
}

function runCli(
  configDir: string,
  args: string[] = [],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: { ...process.env, CORD_CONNECT_CONFIG_DIR: configDir, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(stdin ?? '');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  const timer = setTimeout(() => child.kill(), 20_000);
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

describe('cord-connect', () => {
  async function messageServer() {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
      });
      req.on('end', () => {
        bodies.push(JSON.parse(body) as unknown);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://localhost:${(server.address() as AddressInfo).port}`, bodies };
  }

  it('sends message arguments and piped stdin', async () => {
    const dir = await tempDir();
    const gateway = await messageServer();
    await saveConfig(join(dir, 'config.json'), config(gateway.url, dir));
    const arg = await runCli(dir, ['message', 'First report']);
    const pipe = await runCli(dir, ['message'], {}, 'Long report\nwith details');
    expect(arg.code).toBe(0);
    expect(pipe.code).toBe(0);
    expect(arg.stdout).toContain('Sent to your Twring chat.');
    expect(gateway.bodies).toEqual([
      { local_agent: 'echo', text: 'First report', origin: 'agent' },
      { local_agent: 'echo', text: 'Long report\nwith details', origin: 'agent' },
    ]);
  }, 30_000);

  it('uploads repeated files in order, then sends file ids with an optional caption', async () => {
    const dir = await tempDir();
    const requests: { url: string; body: string }[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(201, { 'content-type': 'application/json' });
        if (req.url?.startsWith('/v1/connectors/files')) {
          const n = requests.filter((request) =>
            request.url.startsWith('/v1/connectors/files'),
          ).length;
          res.end(
            JSON.stringify({
              file: {
                id: `fil_${String.fromCharCode(96 + n).repeat(20)}`,
                name: `file${n}.txt`,
                mime_type: 'text/plain',
                size_bytes: 3,
              },
            }),
          );
        } else res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await saveConfig(
      join(dir, 'config.json'),
      config(`http://localhost:${(server.address() as AddressInfo).port}`, dir),
    );
    const first = join(dir, 'first.txt');
    const second = join(dir, 'second.txt');
    await writeFile(first, 'one');
    await writeFile(second, 'two');
    const result = await runCli(dir, ['message', '--file', first, '--file', second]);
    expect(result.code).toBe(0);
    expect(requests.map((request) => new URL(request.url, 'http://localhost').pathname)).toEqual([
      '/v1/connectors/files',
      '/v1/connectors/files',
      '/v1/connectors/messages',
    ]);
    expect(JSON.parse(requests[2]!.body)).toMatchObject({
      text: '',
      file_ids: [`fil_${'a'.repeat(20)}`, `fil_${'b'.repeat(20)}`],
    });
    requests.length = 0;
    const caption = await runCli(dir, ['message', '--file', first, 'A caption']);
    expect(caption.code).toBe(0);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      text: 'A caption',
      file_ids: [`fil_${'a'.repeat(20)}`],
    });
  }, 30_000);

  it('does not send a message after a file upload fails', async () => {
    const dir = await tempDir();
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.writeHead(507, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'storage_full', message: 'full' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    await saveConfig(
      join(dir, 'config.json'),
      config(`http://localhost:${(server.address() as AddressInfo).port}`, dir),
    );
    const path = join(dir, 'report.txt');
    await writeFile(path, 'report');
    const result = await runCli(dir, ['message', '--file', path]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("Storage is full: the owner's file space is used up.\n");
    expect(requests).toHaveLength(1);
  }, 30_000);

  it('sends shared: true on the claim only with --shared', async () => {
    const claims: unknown[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        claims.push(JSON.parse(body) as unknown);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'pairing_invalid', message: 'No.' } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://localhost:${(server.address() as AddressInfo).port}`;
    const args = [
      '--code',
      'K7QM-2XPA',
      '--server',
      url,
      '--command',
      'echo',
      '--agents',
      'custom',
    ];
    const sharedRun = await runCli(await tempDir(), [...args, '--shared']);
    const plainRun = await runCli(await tempDir(), args);
    const disclosure =
      'Shared agents keep their own memory and files on this computer; everyone who uses them may see what the agent remembers.';
    expect(sharedRun.stdout.replace(/\s+/g, ' ')).toContain(disclosure);
    expect(plainRun.stdout).not.toContain('Shared agents keep');
    const help = await runCli(await tempDir(), ['--help']);
    expect(help.stdout.replace(/\s+/g, ' ')).toContain(disclosure);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ code: 'K7QM-2XPA', shared: true });
    expect(claims[1]).not.toHaveProperty('shared');
  }, 30_000);

  it('ring, message and words from a scoped session send its scope', async () => {
    const scope = 'ab'.repeat(16);
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        requests.push({
          url: req.url ?? '',
          body: body === '' ? {} : (JSON.parse(body) as Record<string, unknown>),
        });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          req.url === '/v1/connectors/ring'
            ? JSON.stringify({
                invite_id: `inv_${'a'.repeat(26)}`,
                expires_at: new Date().toISOString(),
              })
            : req.url === '/v1/connectors/words'
              ? JSON.stringify({ words: ['Gowri'], not_added: [] })
              : '{}',
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const dir = await tempDir();
    await saveConfig(
      join(dir, 'config.json'),
      config(`http://localhost:${(server.address() as AddressInfo).port}`, dir),
    );
    const env = { TWRING_SESSION_SCOPE: scope };
    expect((await runCli(dir, ['ring', 'Build done'], env)).code).toBe(0);
    expect((await runCli(dir, ['message', 'Report'], env)).code).toBe(0);
    expect((await runCli(dir, ['words', 'Gowri'], env)).code).toBe(0);
    expect(requests.map((r) => r.body.session_scope)).toEqual([scope, scope, scope]);
    requests.length = 0;
    await runCli(dir, ['ring', 'Build done']);
    expect(requests[0]?.body).not.toHaveProperty('session_scope');
  }, 30_000);

  it("refuses an unscoped ring with a session that belongs to someone else's scope", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const dir = await tempDir();
    await saveConfig(
      join(dir, 'config.json'),
      config(`http://localhost:${(server.address() as AddressInfo).port}`, dir),
    );
    await writeFile(
      join(dir, 'sessions.json'),
      JSON.stringify({ echo: 'sess_owner', [`echo#${'cd'.repeat(16)}`]: 'sess_member' }),
    );
    const refused = await runCli(dir, ['ring', '--session', 'sess_member', 'Done']);
    expect(refused.code).not.toBe(0);
    expect(requests).toEqual([]);
  }, 30_000);

  it('ignores a non-matching message hook event', async () => {
    const dir = await tempDir();
    const gateway = await messageServer();
    await saveConfig(join(dir, 'config.json'), config(gateway.url, dir));
    const out = await runCli(
      dir,
      ['message', '--from-hook', 'codex'],
      {},
      JSON.stringify({ type: 'other' }),
    );
    expect(out.code).toBe(0);
    expect(gateway.bodies).toEqual([]);
  }, 30_000);
  it('forgets its pairing when the computer was removed in the app (4403)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await saveConfig(path, config(await gatewayClosingWith(RELAY_CLOSE.revoked), dir));
    const { code, stdout, stderr } = await runCli(dir);
    expect(stdout).toContain('no longer paired');
    expect(code, stderr).toBe(0);
    expect(await exists(path)).toBe(false);
  }, 30_000);

  it('keeps its pairing when another copy took over (4409)', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await saveConfig(path, config(await gatewayClosingWith(RELAY_CLOSE.replaced), dir));
    const { stdout } = await runCli(dir);
    expect(stdout).toContain('another window');
    expect(await exists(path)).toBe(true);
  }, 30_000);

  it('setup without a link or a code says how to get one, and installs nothing', async () => {
    const dir = await tempDir();
    const { code, stdout } = await runCli(dir, ['setup']);
    expect(stdout).toContain('Not linked yet');
    expect(stdout).toContain('setup --code');
    expect(code).toBe(1);
  }, 30_000);

  it('as a service with no link, stops at once instead of showing a code', async () => {
    const dir = await tempDir();
    const { code, stderr } = await runCli(dir, [], { CORD_CONNECT_SERVICE: '1' });
    expect(stderr).toContain('Not linked yet');
    // 78: the service managers are told not to start it again (RestartPreventExitStatus).
    expect(code).toBe(78);
  }, 30_000);

  it('records its pid and a connected status while running', async () => {
    const dir = await tempDir();
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => new Promise((resolve) => wss.close(() => resolve())));
    await new Promise((resolve) => wss.once('listening', resolve));
    wss.on('connection', (ws) =>
      ws.once('message', () => {
        ws.send(
          JSON.stringify({
            type: 'connector.ready',
            protocol: 'cord-relay/1',
            connector_id: CONNECTOR_ID,
            name: 'Laptop',
          }),
        );
        setTimeout(() => ws.close(RELAY_CLOSE.replaced, 'bye'), 500);
      }),
    );
    const server = `http://localhost:${(wss.address() as AddressInfo).port}`;
    await saveConfig(join(dir, 'config.json'), config(server, dir));
    const { stdout } = await runCli(dir);
    expect(stdout).toContain('Connected as "Laptop"');
    const status = await readStatus(dir);
    expect(status?.agents).toEqual(['Echo']);
    // The pid file goes with the process.
    expect(await exists(join(dir, 'cord-connect.pid'))).toBe(false);
  }, 30_000);

  it('an old pairing being revoked never deletes a newer one', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await saveConfig(path, config('https://cord.example.com/', dir, `con_${'n'.repeat(20)}`));
    expect(await deleteConfigIfOwned(path, CONNECTOR_ID)).toBe(false);
    expect(await exists(path)).toBe(true);
    expect(await deleteConfigIfOwned(path, `con_${'n'.repeat(20)}`)).toBe(true);
    expect(await exists(path)).toBe(false);
  });
});
