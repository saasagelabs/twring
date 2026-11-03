import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { HandshakeRefusedError, waitForOpen, wsSocketFactory } from './socket';

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing) await new Promise((resolve) => closing.close(resolve));
});

/** A server that refuses every WebSocket upgrade with `status` and `body`. */
async function refusingServer(status: number, body: string): Promise<string> {
  const refusing = createServer();
  server = refusing;
  refusing.on('upgrade', (_request, socket) => {
    socket.end(
      `HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
  await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
  return `ws://127.0.0.1:${(refusing.address() as AddressInfo).port}/`;
}

async function refusal(url: string): Promise<unknown> {
  const socket = wsSocketFactory(url, { Authorization: 'Bearer secret-test-key' });
  try {
    await waitForOpen(socket, new AbortController().signal);
  } catch (error) {
    return error;
  }
  throw new Error('opened');
}

describe('wsSocketFactory handshake refusals', () => {
  it('keeps the status and the provider text, with the usual message', async () => {
    const url = await refusingServer(400, '{"error":"Incorrect API key provided."}');
    const error = await refusal(url);
    expect(error).toBeInstanceOf(HandshakeRefusedError);
    expect((error as HandshakeRefusedError).message).toBe('Unexpected server response: 400');
    expect((error as HandshakeRefusedError).status).toBe(400);
    expect((error as HandshakeRefusedError).body).toContain('Incorrect API key provided');
  });

  it('keeps at most 1 KB of the provider text', async () => {
    const url = await refusingServer(503, 'x'.repeat(5000));
    const error = (await refusal(url)) as HandshakeRefusedError;
    expect(error.status).toBe(503);
    expect(error.body.length).toBe(1024);
  });
});
