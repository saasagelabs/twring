import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { checkOpenAIUrl, OpenAIAdapter } from './openai';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.TWRING_TEST_KEY;
});

interface RequestBody {
  user?: string;
  model?: string;
  stream?: boolean;
  messages?: unknown;
}
interface RequestData {
  headers: Record<string, string | string[] | undefined>;
  body: RequestBody;
}
async function fakeServer(
  reply: (request: RequestData, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () =>
      reply({ headers: req.headers, body: JSON.parse(body) as RequestBody }, res),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function turn(
  adapter: OpenAIAdapter,
  signal = new AbortController().signal,
): Promise<string> {
  let text = '';
  for await (const event of adapter.sendTurn('hello', signal))
    if (event.type === 'text') text += event.text;
  return text;
}

describe('OpenAI compatible adapter', () => {
  it('streams deltas with a stable user key, a fresh key for a fresh adapter, and an env bearer', async () => {
    const requests: RequestData[] = [];
    const url = await fakeServer((request, res) => {
      requests.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"rea"}}]}\n\n');
      res.end('data: {"choices":[{"delta":{"content":"dy"}}]}\n\ndata: [DONE]\n\n');
    });
    process.env.TWRING_TEST_KEY = 'secret';
    const adapter = new OpenAIAdapter({
      id: 'goose',
      url,
      model: 'default',
      keyEnv: 'TWRING_TEST_KEY',
    });
    expect(adapter.sessionRef()).toBeUndefined();
    expect(await turn(adapter)).toBe('ready');
    expect(await turn(adapter)).toBe('ready');
    expect(requests.map((item) => item.body.user)).toEqual([
      adapter.sessionRef(),
      adapter.sessionRef(),
    ]);
    expect(adapter.sessionRef()).toMatch(/^twring-goose-[a-f0-9]{16}$/);
    expect(requests[0]?.body).toMatchObject({
      model: 'default',
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(requests[0]?.headers.authorization).toBe('Bearer secret');
    const fresh = new OpenAIAdapter({ id: 'goose', url, model: 'default' });
    await turn(fresh);
    expect(fresh.sessionRef()).not.toBe(adapter.sessionRef());
  });

  it('reports HTTP and malformed stream errors', async () => {
    const http = await fakeServer((_request, res) => {
      res.writeHead(503);
      res.end();
    });
    await expect(turn(new OpenAIAdapter({ id: 'x', url: http, model: 'default' }))).rejects.toThrow(
      'HTTP 503',
    );
    const malformed = await fakeServer((_request, res) => {
      res.writeHead(200);
      res.end('data: bad json\n\n');
    });
    await expect(
      turn(new OpenAIAdapter({ id: 'x', url: malformed, model: 'default' })),
    ).rejects.toThrow('invalid stream');
  });

  it('cancels an active turn and refuses remote cleartext', async () => {
    const url = await fakeServer((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    });
    const controller = new AbortController();
    const adapter = new OpenAIAdapter({ id: 'x', url, model: 'default' });
    let received = '';
    for await (const event of adapter.sendTurn('hello', controller.signal)) {
      if (event.type === 'text') received += event.text;
      controller.abort();
    }
    expect(received).toBe('a');
    expect(() => checkOpenAIUrl('http://example.com/v1')).toThrow('https');
  });
});
