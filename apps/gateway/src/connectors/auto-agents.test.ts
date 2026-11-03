import {
  agentListResponseSchema,
  claimResponseSchema,
  connectorEndpointUrl,
  pairingResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { FAKE_AGENTS, startFakeConnector } from './testing';

/** Self-hosted: a code the installer minted through the admin listener lists its agents. */

const gateways: ConnectorGateway[] = [];
const sockets: ReturnType<typeof startFakeConnector>[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(selfhost: boolean) {
  const g = await startConnectorGateway({ selfhost });
  gateways.push(g);
  return g;
}

async function adminCode(g: ConnectorGateway, personId: string): Promise<string> {
  const res = await g.selfhost!.admin.inject({
    method: 'POST',
    url: '/admin/connector-code',
    headers: { authorization: `Bearer ${g.selfhost!.adminToken}` },
    payload: { person_id: personId },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ code: string }>().code;
}

async function agentsOf(g: ConnectorGateway, user: string) {
  const res = await g.send('GET', '/v1/agents', { user });
  return agentListResponseSchema.parse(res.json()).agents;
}

describe('agents for a code the server minted', () => {
  it('a claim creates a callable agent for each advertised agent', async () => {
    const g = await gateway(true);
    const { person } = await g.selfhost!.pair('admin', 'Ada');
    const code = await adminCode(g, person.id);
    const claim = await g.send('POST', '/v1/connectors/claim', {
      body: { code, name: 'Home server', agents: FAKE_AGENTS },
    });
    expect(claim.statusCode).toBe(201);
    const { connector_id: connectorId } = claimResponseSchema.parse(claim.json());
    const agents = await agentsOf(g, person.id);
    expect(
      agents.map((a) => ({ name: a.name, protocol: a.protocol, url: a.endpoint_url })),
    ).toEqual(
      expect.arrayContaining(
        FAKE_AGENTS.map((a) => ({
          name: a.label,
          protocol: 'cord-connector',
          url: connectorEndpointUrl(connectorId, a.id),
        })),
      ),
    );
    expect(agents).toHaveLength(FAKE_AGENTS.length);
  });

  it('a relink adds new agents and never duplicates the ones already there', async () => {
    const g = await gateway(true);
    const { person } = await g.selfhost!.pair('admin', 'Ada');
    const first = await g.send('POST', '/v1/connectors/claim', {
      body: { code: await adminCode(g, person.id), name: 'Home server', agents: [FAKE_AGENTS[0]!] },
    });
    const { token } = claimResponseSchema.parse(first.json());
    expect(await agentsOf(g, person.id)).toHaveLength(1);
    const again = await g.send('POST', '/v1/connectors/claim', {
      headers: { authorization: `Bearer ${token}` },
      body: { code: await adminCode(g, person.id), name: 'Home server', agents: FAKE_AGENTS },
    });
    expect(again.statusCode).toBe(200);
    const agents = await agentsOf(g, person.id);
    expect(agents.map((a) => a.name).sort()).toEqual(FAKE_AGENTS.map((a) => a.label).sort());
  });

  it('a new link of a removed computer with the same name takes over its contact', async () => {
    const g = await gateway(true);
    const { person } = await g.selfhost!.pair('admin', 'Ada');
    const agent = [FAKE_AGENTS[0]!];
    const first = claimResponseSchema.parse(
      (
        await g.send('POST', '/v1/connectors/claim', {
          body: { code: await adminCode(g, person.id), name: 'Home server', agents: agent },
        })
      ).json(),
    );
    const [old] = await agentsOf(g, person.id);
    const deleted = await g.send('DELETE', `/v1/connectors/${first.connector_id}`, {
      user: person.id,
    });
    expect(deleted.statusCode).toBe(204);
    const second = claimResponseSchema.parse(
      (
        await g.send('POST', '/v1/connectors/claim', {
          body: { code: await adminCode(g, person.id), name: 'Home server', agents: agent },
        })
      ).json(),
    );
    const agents = await agentsOf(g, person.id);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: old!.id,
      name: old!.name,
      endpoint_url: connectorEndpointUrl(second.connector_id, agent[0]!.id),
    });
  });

  it('a new link while the old computer is still online makes a second contact', async () => {
    const g = await gateway(true);
    const { person } = await g.selfhost!.pair('admin', 'Ada');
    const agent = [FAKE_AGENTS[0]!];
    const first = claimResponseSchema.parse(
      (
        await g.send('POST', '/v1/connectors/claim', {
          body: { code: await adminCode(g, person.id), name: 'Home server', agents: agent },
        })
      ).json(),
    );
    const socket = startFakeConnector({ url: g.socketUrl, token: first.token, agents: agent });
    sockets.push(socket);
    await socket.ready;
    await g.send('POST', '/v1/connectors/claim', {
      body: { code: await adminCode(g, person.id), name: 'Home server', agents: agent },
    });
    expect(await agentsOf(g, person.id)).toHaveLength(2);
  });

  it('a code the phone made creates no agents (the phone adds them itself)', async () => {
    const g = await gateway(true);
    const { person } = await g.selfhost!.pair('admin', 'Ada');
    const pairing = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: person.id })).json(),
    );
    await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(await agentsOf(g, person.id)).toEqual([]);
  });

  it('hosted: a claim creates no agents', async () => {
    const g = await gateway(false);
    await g.pair('alice');
    expect(await agentsOf(g, 'alice')).toEqual([]);
  });
});
