import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAgentFile, FetchAgentFileError } from './fetch-agent-file';

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function local(
  response: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(response);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}/file`;
}

const dev = { env: 'development' as const };

describe('fetchAgentFile', () => {
  it('blocks private and loopback targets outside development, including resolved hostnames', async () => {
    await expect(
      fetchAgentFile('https://127.0.0.1/file', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'blocked' });
    await expect(
      fetchAgentFile('https://10.0.0.1/file', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'blocked' });
    await expect(
      fetchAgentFile('https://agent.example/file', new AbortController().signal, {
        env: 'production',
        lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('accepts a local development response and refuses redirects and non-200 responses', async () => {
    const ok = await local((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('hello');
    });
    await expect(fetchAgentFile(ok, new AbortController().signal, dev)).resolves.toMatchObject({
      bytes: Buffer.from('hello'),
      contentType: 'text/plain',
    });
    const redirect = await local((_request, response) => {
      response.writeHead(302, { location: ok });
      response.end();
    });
    await expect(fetchAgentFile(redirect, new AbortController().signal, dev)).rejects.toMatchObject(
      { code: 'http_status' },
    );
    const missing = await local((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    await expect(fetchAgentFile(missing, new AbortController().signal, dev)).rejects.toMatchObject({
      code: 'http_status',
    });
  });

  it('connects to the address validated by the guard', async () => {
    const url = await local((_request, response) => response.end('pinned'));
    const hostnameUrl = url.replace('127.0.0.1', 'localhost');
    const result = await fetchAgentFile(hostnameUrl, new AbortController().signal, {
      env: 'development',
      lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    });
    expect(result.bytes.toString()).toBe('pinned');
  });

  it('rejects oversize headers and streams, and obeys cancellation', async () => {
    const header = await local((_request, response) => {
      response.writeHead(200, { 'content-length': 10_485_761 });
      response.end();
    });
    await expect(fetchAgentFile(header, new AbortController().signal, dev)).rejects.toMatchObject({
      code: 'too_large',
    });
    const stream = await local((_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(10_485_761));
    });
    await expect(fetchAgentFile(stream, new AbortController().signal, dev)).rejects.toMatchObject({
      code: 'too_large',
    });
    const controller = new AbortController();
    controller.abort();
    await expect(fetchAgentFile(stream, controller.signal, dev)).rejects.toBeInstanceOf(
      FetchAgentFileError,
    );
  });

  it('times out a response that never arrives', async () => {
    const hanging = await local(() => undefined);
    vi.useFakeTimers();
    const pending = fetchAgentFile(hanging, new AbortController().signal, dev);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(20_001);
    await assertion;
  });
});
