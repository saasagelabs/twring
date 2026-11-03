/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- Fastify inject JSON is untyped. */
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { startConnectorGateway } from '../src/connectors/harness';
import { startFakeConnector } from '../src/connectors/testing';

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('thread did not settle');
}

describe('threads through the connector relay', () => {
  it('answers one typed turn over the real relay socket', async () => {
    const gateway = await startConnectorGateway({ threads: { sweepIntervalMs: 20 } });
    try {
      const { connectorId, connector } = await gateway.connect('alice');
      const agentId = await gateway.createAgent('alice', connectorId);
      const url = `/v1/agents/${agentId}/messages`;
      const sent = await gateway.send('POST', url, {
        user: 'alice',
        body: { client_id: randomUUID(), text: 'Hello' },
      });
      expect(sent.statusCode).toBe(201);
      await waitFor(async () =>
        (await gateway.send('GET', url, { user: 'alice' }))
          .json()
          .messages.some((m: { status?: string }) => m.status === 'answered'),
      );
      const page = (await gateway.send('GET', url, { user: 'alice' })).json();
      expect(
        page.messages.some(
          (m: { kind: string; text?: string }) =>
            m.kind === 'agent_text' && m.text === 'Hello from your computer.',
        ),
      ).toBe(true);
      const turns = connector.received.filter((item) => item.message.type === 'user.turn');
      expect(turns).toHaveLength(1);
      expect(turns[0]?.message).toMatchObject({ surface: 'text' });
    } finally {
      await gateway.close();
    }
  });

  it('delivers an offline queued message once when the connector returns', async () => {
    const gateway = await startConnectorGateway({ threads: { sweepIntervalMs: 20 } });
    let connector: ReturnType<typeof startFakeConnector> | undefined;
    try {
      const { connectorId, token } = await gateway.pair('alice');
      const agentId = await gateway.createAgent('alice', connectorId);
      const url = `/v1/agents/${agentId}/messages`;
      const sent = await gateway.send('POST', url, {
        user: 'alice',
        body: { client_id: randomUUID(), text: 'While offline' },
      });
      expect(sent.json().message.status).toBe('queued');
      connector = startFakeConnector({ url: gateway.socketUrl, token });
      await connector.ready;
      await waitFor(async () =>
        (await gateway.send('GET', url, { user: 'alice' }))
          .json()
          .messages.some((m: { status?: string }) => m.status === 'answered'),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(connector.received.filter((item) => item.message.type === 'user.turn')).toHaveLength(
        1,
      );
    } finally {
      connector?.terminate();
      await gateway.close();
    }
  });
});
