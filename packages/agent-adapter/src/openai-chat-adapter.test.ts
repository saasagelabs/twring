import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { OpenAiChatAdapter } from './openai-chat-adapter';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fake(
  reply: (res: ServerResponse) => void,
  inspect?: (body: unknown, headers: IncomingHttpHeaders, path: string) => void,
) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      inspect?.(JSON.parse(Buffer.concat(chunks).toString()), req.headers, req.url ?? '');
      reply(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No server address');
  return `http://127.0.0.1:${address.port}/v1`;
}

const turn = {
  callId: 'call_1',
  sessionId: 'session_1',
  turnId: 'turn_1',
  role: 'user' as const,
  text: 'Hello',
  surface: 'text' as const,
  startedAt: new Date().toISOString(),
  committedAt: new Date().toISOString(),
};

async function collect(url: string, signal = new AbortController().signal) {
  const adapter = new OpenAiChatAdapter({
    url,
    token: 'secret',
    model: 'openclaw:main',
    sessionKey: 'twring-1234',
  });
  await adapter.connect({ callId: turn.callId, sessionId: turn.sessionId }, signal);
  try {
    const events = [];
    for await (const event of adapter.sendTurn(turn, signal)) events.push(event);
    return events;
  } finally {
    await adapter.close();
  }
}

describe('OpenAI chat adapter', () => {
  it('uses the default model and sends attachment lines with the current voice turn', async () => {
    let body: { model?: string; messages?: { content: string }[] } = {};
    const url = await fake(
      (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      },
      (value) => {
        body = value as typeof body;
      },
    );
    const adapter = new OpenAiChatAdapter({ url, sessionKey: 'twring-1234' });
    const signal = new AbortController().signal;
    await adapter.connect({ callId: turn.callId, sessionId: turn.sessionId }, signal);
    const events = [];
    for await (const event of adapter.sendTurn(
      {
        ...turn,
        surface: 'call',
        attachments: [
          {
            id: 'fil_aaaaaaaaaaaaaaaaaaaa',
            name: 'note.txt',
            mime_type: 'text/plain',
            size_bytes: 1,
            url: 'https://files.example.com/note',
            expires_at: new Date().toISOString(),
          },
        ],
      },
      signal,
    ))
      events.push(event);
    await adapter.close();
    expect(body.model).toBe('default');
    expect(body.messages?.[0]?.content).toContain('voice call');
    expect(body.messages?.[1]?.content).toContain(
      'Attachment: note.txt (text/plain) https://files.example.com/note',
    );
    expect(events.at(-1)?.type).toBe('done');
  });

  it('sends one current turn and converts deltas through DONE', async () => {
    let request: unknown;
    let bearer: unknown;
    let path = '';
    const url = await fake(
      (res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.end('data: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n');
      },
      (body, headers, target) => {
        request = body;
        bearer = headers.authorization;
        path = target;
      },
    );
    const events = await collect(url);
    expect(path).toBe('/v1/chat/completions');
    expect(bearer).toBe('Bearer secret');
    expect(request).toMatchObject({
      model: 'openclaw:main',
      stream: true,
      user: 'twring-1234',
      messages: [
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- asymmetric matcher
        { role: 'system', content: expect.stringContaining('Twring chat') },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(
      events
        .filter((event) => event.type === 'text.delta')
        .map((event) => (event.type === 'text.delta' ? event.delta : '')),
    ).toEqual(['Hello', ' there']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it.each([401, 403, 404, 429, 500])('maps HTTP %i to an adapter error', async (status) => {
    const url = await fake((res) => {
      res.writeHead(status);
      res.end();
    });
    await expect(collect(url)).rejects.toMatchObject({
      code: status === 401 || status === 403 ? 'auth_failed' : 'agent_error',
      httpStatus: status,
    });
  });

  it('rejects malformed and oversized streams', async () => {
    const malformed = await fake((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: wrong\n\n');
    });
    await expect(collect(malformed)).rejects.toMatchObject({ code: 'protocol_violation' });
    const oversized = await fake((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${'x'.repeat(65_537)}\n\n`);
    });
    await expect(collect(oversized)).rejects.toMatchObject({ code: 'protocol_violation' });
  });

  it('aborts an active request', async () => {
    const url = await fake((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': waiting\n\n');
    });
    const controller = new AbortController();
    const pending = collect(url, controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual([]);
  });
});
