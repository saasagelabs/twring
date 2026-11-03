import { getEventListeners } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAgentFile } from './fetch-agent-file';

const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function local(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { url: `http://127.0.0.1:${address.port}/file`, server };
}

const dev = { env: 'development' as const };
const signal = () => new AbortController().signal;
const publicLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

describe('fetchAgentFile SSRF guard (verifier)', () => {
  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/f',
    'https://[::ffff:127.0.0.1]/f',
    'https://[::ffff:7f00:1]/f',
    'https://[::ffff:a9fe:a9fe]/f',
    'https://[0:0:0:0:0:ffff:10.0.0.1]/f',
    'https://[fd00::1]/f',
    'https://[fe80::1]/f',
    'https://[64:ff9b::7f00:1]/f',
    'https://[2002:7f00:1::]/f',
    'https://0.0.0.0/f',
    'https://100.64.0.1/f',
    'https://2130706433/f',
    'https://0x7f.1/f',
    'https://127.1/f',
    'https://017700000001/f',
    'https://localhost/f',
    'https://LOCALHOST/f',
    'https://localhost./f',
  ])('blocks %s in production', async (url) => {
    await expect(fetchAgentFile(url, signal(), { env: 'production' })).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('blocks userinfo, bad ports, http and non-http schemes', async () => {
    const options = { env: 'production' as const, lookup: publicLookup };
    for (const url of [
      'https://user:pw@example.com/f',
      'https://user@example.com/f',
      'https://example.com:22/f',
      'https://example.com:6667/f',
      'http://example.com/f',
      'ftp://example.com/f',
      'file:///etc/passwd',
      'not a url',
      '',
    ])
      await expect(fetchAgentFile(url, signal(), options)).rejects.toMatchObject({
        code: 'blocked',
      });
  });

  it('does not let the development localhost allowance leak to other environments or hosts', async () => {
    const { url } = await local((_request, response) => response.end('secret'));
    for (const env of ['production', 'staging'] as const)
      await expect(fetchAgentFile(url, signal(), { env })).rejects.toMatchObject({
        code: 'blocked',
      });
    await expect(
      fetchAgentFile('https://evil.example/f', signal(), {
        env: 'development',
        lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
    await expect(
      fetchAgentFile('http://example.com/f', signal(), {
        env: 'development',
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchAgentFile('https://169.254.169.254/', signal(), dev)).rejects.toMatchObject({
      code: 'blocked',
    });
  });

  it('blocks a hostname when any resolved address is private and resolves only once', async () => {
    const lookup = vi.fn(() =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 as const },
        { address: '10.0.0.5', family: 4 as const },
      ]),
    );
    await expect(
      fetchAgentFile('https://rebind.example/f', signal(), { env: 'production', lookup }),
    ).rejects.toMatchObject({ code: 'blocked' });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('treats an unresolvable lookup as a failure, and abort ends a hanging one at once', async () => {
    await expect(
      fetchAgentFile('https://nx.example/f', signal(), {
        env: 'production',
        lookup: () => Promise.reject(new Error('ENOTFOUND')),
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
    const controller = new AbortController();
    const pending = fetchAgentFile('https://slow.example/f', controller.signal, {
      env: 'production',
      lookup: () => new Promise(() => undefined),
      lookupTimeoutMs: 60_000,
    });
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'network' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('connects only to the pinned address, never re-resolving the name', async () => {
    const { url } = await local((request, response) => response.end(String(request.headers.host)));
    const port = new URL(url).port;
    const result = await fetchAgentFile(`http://localhost:${port}/f`, signal(), {
      env: 'development',
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(result.bytes.toString()).toBe(`localhost:${port}`);
  });
});

describe('fetchAgentFile resource limits (verifier)', () => {
  it('rejects a chunked body over the limit and closes the socket', async () => {
    let closed = false;
    const { url } = await local((request, response) => {
      request.socket.on('close', () => (closed = true));
      response.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let sent = 0;
      const pump = () => {
        while (sent < 40) {
          sent++;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
    });
    await expect(fetchAgentFile(url, signal(), dev)).rejects.toMatchObject({ code: 'too_large' });
    await until(() => closed);
    expect(closed).toBe(true);
  });

  it('accepts exactly the limit', async () => {
    const { url } = await local((_request, response) =>
      response.end(Buffer.alloc(10 * 1024 * 1024)),
    );
    const ok = await fetchAgentFile(url, signal(), dev);
    expect(ok.bytes.length).toBe(10 * 1024 * 1024);
  });

  it('fails (does not hang or succeed) when the body is cut short', async () => {
    const short = await local((request, response) => {
      response.writeHead(200, { 'content-length': '100' });
      response.write('only ten b');
      setTimeout(() => request.socket.destroy(), 10);
    });
    await expect(fetchAgentFile(short.url, signal(), dev)).rejects.toMatchObject({
      code: 'network',
    });
    const chunked = await local((request, response) => {
      response.writeHead(200);
      response.write('partial');
      setTimeout(() => request.socket.destroy(), 10);
    });
    await expect(fetchAgentFile(chunked.url, signal(), dev)).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('times out a slow-drip body after 20 s and closes the connection', async () => {
    let closed = false;
    const { url } = await local((request, response) => {
      request.socket.on('close', () => (closed = true));
      response.writeHead(200);
      response.write('x');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pending = fetchAgentFile(url, signal(), dev);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(15_100);
    await assertion;
    vi.useRealTimers();
    await until(() => closed);
    expect(closed).toBe(true);
  });

  it('aborts mid-download, closes the socket, and leaves no abort listener behind', async () => {
    let closed = false;
    const { url } = await local((request, response) => {
      request.socket.on('close', () => (closed = true));
      response.writeHead(200);
      response.write('x');
    });
    const controller = new AbortController();
    const pending = fetchAgentFile(url, controller.signal, dev);
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'network' });
    await until(() => closed);
    expect(closed).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes its abort listener after success and after failure', async () => {
    const ok = await local((_request, response) => response.end('ok'));
    const bad = await local((_request, response) => {
      response.writeHead(500);
      response.end();
    });
    const controller = new AbortController();
    await fetchAgentFile(ok.url, controller.signal, dev);
    await expect(fetchAgentFile(bad.url, controller.signal, dev)).rejects.toBeDefined();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not follow a 301/307/308 even with a valid Location', async () => {
    let hits = 0;
    const target = await local((_request, response) => {
      hits++;
      response.end('x');
    });
    for (const status of [301, 307, 308]) {
      const redirect = await local((_request, response) => {
        response.writeHead(status, { location: target.url });
        response.end();
      });
      await expect(fetchAgentFile(redirect.url, signal(), dev)).rejects.toMatchObject({
        code: 'http_status',
      });
    }
    expect(hits).toBe(0);
  });
});
