import { isAdapterError } from '@twring/agent-adapter';
import {
  agentListResponseSchema,
  connectorEndpointUrl,
  createCallResponseSchema,
  errorResponseSchema,
  NATIVE_PROTOCOL,
  pairingResponseSchema,
  pairingStatusResponseSchema,
  RELAY_PROTOCOL,
} from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { targetAgentFactory } from '../agents/service';
import { flushMicrotasks } from '../calls/testing';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { OfflineSocket } from './hub';
import { PairingBook } from './pairing';
import { FAKE_AGENTS } from './testing';

/** v0.01 reliability: calls to agents on the user's computer (ADR-023). */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway({
    calls: { allowance: { callSeconds: 0, calls: 5 } },
    ...options,
  });
  gateways.push(g);
  return g;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const callsUsed = async (g: ConnectorGateway, user = 'alice') =>
  (await g.calls!.daily.usage(user)).calls_used;

const startCall = (g: ConnectorGateway, agentId: string, user = 'alice') =>
  g.send('POST', '/v1/calls', { user, body: { agent_id: agentId } });

/** Sends a repeated `connector.hello` with a new agent list. */
function helloAgain(ws: { send(data: string): void }, agents = FAKE_AGENTS) {
  ws.send(
    JSON.stringify({
      type: 'connector.hello',
      protocol: RELAY_PROTOCOL,
      agent_protocol: NATIVE_PROTOCOL,
      agents,
    }),
  );
}

describe('an offline computer does not cost a daily call', () => {
  it('refuses the call with agent_offline (409) before counting it', async () => {
    const g = await gateway();
    const { connectorId } = await g.pair('alice');
    const agentId = await g.createAgent('alice', connectorId);
    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'agent_offline',
      message: "Your computer is offline. Make sure it's on and online, then call again.",
    });
    expect(await callsUsed(g)).toBe(0);
    expect(g.calls!.registry.activeCount).toBe(0);
  });

  it('gives the call back when the computer drops between admission and the first turn', async () => {
    const g = await gateway();
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    // Online when the call is admitted; gone by the time the call connects to the agent.
    const status = vi.spyOn(g.hub, 'agentStatus').mockReturnValueOnce('online');
    connector.terminate();
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(201);
    expect(status).toHaveBeenCalled();
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.endReasons.includes('agent_offline'));
    transport.emit({ type: 'caller_joined' });
    await waitFor(async () => (await callsUsed(g)) === 0);
  });

  it('keeps the count for a call that reached the agent', async () => {
    const g = await gateway();
    const { connectorId } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    const created = createCallResponseSchema.parse((await startCall(g, agentId)).json());
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });
    g.calls!.stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello' });
    await flushMicrotasks();
    await g.send('POST', `/v1/calls/${created.call_id}/end`, { user: 'alice' });
    expect(await callsUsed(g)).toBe(1);
  });
});

describe('removing a computer', () => {
  it('ends its live calls with agent_offline, and its agents read "Computer removed"', async () => {
    const g = await gateway();
    const { connectorId } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    const created = createCallResponseSchema.parse((await startCall(g, agentId)).json());
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });

    const res = await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'alice' });
    expect(res.statusCode).toBe(204);
    expect(transport.endReasons).toEqual(['agent_offline']);
    expect(g.calls!.registry.get(created.call_id)?.status).toMatch(/ended|failed/);

    const agents = agentListResponseSchema.parse(
      (await g.send('GET', '/v1/agents', { user: 'alice' })).json(),
    );
    expect(agents.agents[0]).toMatchObject({
      connector_online: false,
      connector_removed: true,
    });

    const again = await startCall(g, agentId);
    expect(again.statusCode).toBe(409);
    expect(errorResponseSchema.parse(again.json()).error).toMatchObject({
      code: 'connector_invalid',
      message: 'Computer removed. Pair it again.',
    });
  });

  it("does not touch another user's calls or a paired computer's agents", async () => {
    const g = await gateway();
    const alice = await g.connect('alice');
    const bob = await g.connect('bob');
    const bobAgent = await g.createAgent('bob', bob.connectorId);
    await g.createAgent('alice', alice.connectorId);
    const created = createCallResponseSchema.parse((await startCall(g, bobAgent, 'bob')).json());
    expect(
      (await g.send('DELETE', `/v1/connectors/${alice.connectorId}`, { user: 'alice' })).statusCode,
    ).toBe(204);
    expect(g.calls!.registry.get(created.call_id)?.status).toMatch(/connecting|active/);
    const bobs = agentListResponseSchema.parse(
      (await g.send('GET', '/v1/agents', { user: 'bob' })).json(),
    );
    expect(bobs.agents[0]?.connector_removed).toBeUndefined();
  });
});

describe('the agent list stays in sync', () => {
  it('a repeated hello persists the new agent list to the store', async () => {
    const g = await gateway();
    const { connectorId, connector } = await g.connect('alice');
    helloAgain(connector.ws, [FAKE_AGENTS[1]!]);
    await waitFor(
      async () =>
        (await g.stores.connectors.get('alice', connectorId))?.agents.map((a) => a.id).join() ===
        'gemini',
    );
  });

  it('refuses a call and a channel to an agent the computer no longer offers', async () => {
    const g = await gateway();
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId, 'claude-code');
    helloAgain(connector.ws, [FAKE_AGENTS[1]!]);
    await waitFor(() => g.hub.agentStatus('alice', connectorId, 'claude-code') === 'agent_missing');

    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error).toMatchObject({
      code: 'agent_not_on_computer',
      message: "This agent isn't set up on your computer anymore.",
    });
    expect(await callsUsed(g)).toBe(0);

    expect(g.hub.socketFor('alice', connectorId, 'claude-code')).toBeInstanceOf(OfflineSocket);
    const adapter = await targetAgentFactory(
      {
        protocol: 'cord-connector',
        url: connectorEndpointUrl(connectorId, 'claude-code'),
        userId: 'alice',
      },
      { env: 'development', connectors: g.hub },
    )('call_1');
    const error = await adapter
      .connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isAdapterError(error) && error.code).toBe('agent_not_on_computer');
    expect(connector.opened).toEqual([]);
  });
});

describe('pairing expiry follows the server clock', () => {
  it('returns server_time with the code and with every poll', async () => {
    let now = 5_000_000;
    const g = await gateway({ pairings: new PairingBook(() => now) });
    const created = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: 'alice' })).json(),
    );
    expect(created.server_time).toBeDefined();
    now += 1000;
    const status = pairingStatusResponseSchema.parse(
      (
        await g.send('GET', `/v1/connectors/pairings/${created.pairing_id}`, { user: 'alice' })
      ).json(),
    );
    expect(status.server_time).toBeDefined();
  });
});
