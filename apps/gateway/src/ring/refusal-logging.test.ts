import { Writable } from 'node:stream';

import { errorResponseSchema, ringResponseSchema } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

/**
 * A refusal sent from an async helper must not make the route throw afterwards. FastifyReply is a
 * thenable: an async helper that returned the sent reply resolved to undefined, the route's
 * `'token_hash' in connector` (or `'call_id' in result`) threw after the response went out, and
 * Fastify logged "Promise errored, but reply.sent = true was set" (seen in production).
 */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

/** A gateway whose Fastify log lines are collected. */
async function loggedGateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const lines: { level: number; msg?: string }[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line) as { level: number; msg?: string });
      }
      callback();
    },
  });
  const g = await startConnectorGateway({
    ring: {},
    logger: { level: 'info', stream },
    ...options,
  });
  gateways.push(g);
  return { g, errors: () => lines.filter((line) => line.level >= 50) };
}

const code = (res: { json(): unknown }) => errorResponseSchema.parse(res.json()).error.code;

describe('refusals log no error', () => {
  it('connector routes refuse a missing token with 401 and nothing thrown', async () => {
    const { g, errors } = await loggedGateway({ threads: {} });
    const body = { local_agent: 'claude-code', text: 'Done', origin: 'agent' };
    const message = await g.send('POST', '/v1/connectors/messages', { body });
    const ring = await g.send('POST', '/v1/connectors/ring', {
      body: { local_agent: 'claude-code', reason: 'The build failed' },
    });
    expect([message.statusCode, ring.statusCode]).toEqual([401, 401]);
    expect(code(message)).toBe('connector_invalid');
    expect(errors()).toEqual([]);
  });

  it('answering while already on a call is refused with 409 and nothing thrown', async () => {
    const { g, errors } = await loggedGateway({
      calls: { allowance: { callSeconds: 0, calls: 5 } },
    });
    const paired = await g.connect('alice');
    const agentId = await g.createAgent('alice', paired.connectorId);
    const rang = await g.send('POST', '/v1/connectors/ring', {
      headers: { authorization: `Bearer ${paired.token}` },
      body: { local_agent: 'claude-code', reason: 'The build failed' },
    });
    expect(rang.statusCode).toBe(201);
    const { invite_id: inviteId } = ringResponseSchema.parse(rang.json());
    const call = await g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: agentId } });
    expect(call.statusCode).toBe(201);

    const answer = await g.send('POST', `/v1/invites/${inviteId}/answer`, { user: 'alice' });
    expect(answer.statusCode).toBe(409);
    expect(code(answer)).toBe('call_in_progress');
    expect(errors()).toEqual([]);
  });
});
