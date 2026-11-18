import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { reportsFastifyError } from './sentry';

describe('which request errors reach Sentry', () => {
  const reply = (statusCode: number) => ({ statusCode });
  const request = (aborted = false) => ({ raw: { aborted } });

  it('reports a server fault, and an error thrown before any status was set', () => {
    expect(reportsFastifyError(new Error('boom'), request(), reply(500))).toBe(true);
    expect(reportsFastifyError(new Error('boom'), request(), reply(200))).toBe(true);
  });

  it('skips a phone that hung up while its upload was still arriving', () => {
    // Fastify marks a body read that failed as the client's fault (400), before the reply has a
    // status of its own.
    const aborted = Object.assign(new Error('aborted'), { code: 'ECONNRESET', statusCode: 400 });
    expect(reportsFastifyError(aborted, request(true), reply(200))).toBe(false);
    expect(reportsFastifyError(aborted, request(false), reply(200))).toBe(false);
  });

  it('skips a request the client gave up on, whatever the error', () => {
    expect(reportsFastifyError(new Error('late'), request(true), reply(200))).toBe(false);
  });

  it('skips other client errors, and keeps a 5xx the error itself names', () => {
    const tooLarge = Object.assign(new Error('too large'), { statusCode: 413 });
    expect(reportsFastifyError(tooLarge, request(), reply(200))).toBe(false);
    const unavailable = Object.assign(new Error('down'), { statusCode: 503 });
    expect(reportsFastifyError(unavailable, request(), reply(200))).toBe(true);
  });

  it('a real upload cut off mid-body is judged a client fault', async () => {
    const app = Fastify();
    const seen: boolean[] = [];
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, body, done) =>
      done(null, body),
    );
    app.setErrorHandler((error, request, reply) => {
      seen.push(reportsFastifyError(error as Error, request, reply));
      return reply.code(400).send();
    });
    app.post('/upload', () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = app.server.address() as { port: number };
      const { connect } = await import('node:net');
      await new Promise<void>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            'POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\n' +
              'Content-Length: 100000\r\n\r\npartial',
          );
          setTimeout(() => {
            socket.destroy();
            resolve();
          }, 50);
        });
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(seen).toEqual([false]);
    } finally {
      await app.close();
    }
  });
});
