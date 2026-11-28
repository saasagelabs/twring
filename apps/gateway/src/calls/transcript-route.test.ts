import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerCallRoutes } from './routes';

const CALL = `call_${'c'.repeat(20)}`;

function app(result: 'sent' | 'not_found' | 'not_supported') {
  const seen: [string, string][] = [];
  const server = Fastify();
  registerCallRoutes(server, {
    registry: undefined,
    createRatePerMinute: 10,
    userFor: () => 'owner',
    transcripts: {
      sendCallTranscript: (userId, callId) => {
        seen.push([userId, callId]);
        return Promise.resolve(result);
      },
    },
  });
  return { server, seen };
}

describe('POST /v1/calls/:callId/transcript (ADR-050)', () => {
  it('maps the outcome to 200, 404 and 409', async () => {
    for (const [result, status] of [
      ['sent', 200],
      ['not_found', 404],
      ['not_supported', 409],
    ] as const) {
      const { server, seen } = app(result);
      const response = await server.inject({ method: 'POST', url: `/v1/calls/${CALL}/transcript` });
      expect(response.statusCode).toBe(status);
      if (status === 200) expect(response.json()).toEqual({ sent: true });
      expect(seen).toEqual([['owner', CALL]]);
      await server.close();
    }
  });

  it('a malformed call id is 404 without a lookup', async () => {
    const { server, seen } = app('sent');
    const response = await server.inject({ method: 'POST', url: '/v1/calls/nope/transcript' });
    expect(response.statusCode).toBe(404);
    expect(seen).toEqual([]);
    await server.close();
  });
});
