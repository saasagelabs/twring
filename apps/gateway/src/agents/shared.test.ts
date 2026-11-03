import {
  agentListResponseSchema,
  agentSchema,
  claimResponseSchema,
  connectorEndpointUrl,
  createCallResponseSchema,
  errorResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';
import { FAKE_AGENTS, startFakeConnector, type FakeConnector } from '../connectors/testing';
import type { AgentRecord } from '../store/repositories';

import { canEditAgent, canUseAgent } from './shared';

const codeSchema = z.object({ code: z.string() });

/** Server agents (self-host ruling): owned by one person, callable by everyone in the space. */

const gateways: ConnectorGateway[] = [];
const sockets: FakeConnector[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(selfhost = true) {
  const g = await startConnectorGateway({
    selfhost,
    calls: { allowance: { callSeconds: 0, calls: 50 } },
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

/** Claims `code` for a computer, optionally asking to share its agents; connects it. */
async function claim(g: ConnectorGateway, code: string, shared?: boolean) {
  const res = await g.send('POST', '/v1/connectors/claim', {
    body: {
      code,
      name: 'Home server',
      agents: FAKE_AGENTS,
      ...(shared !== undefined && { shared }),
    },
  });
  expect(res.statusCode).toBe(201);
  const { connector_id: connectorId, token } = claimResponseSchema.parse(res.json());
  const socket = startFakeConnector({ url: g.socketUrl, token, features: ['scoped_sessions'] });
  sockets.push(socket);
  await socket.ready;
  return connectorId;
}

/** A connector code for `personId` from the admin listener (as the installer gets one). */
async function adminCode(g: ConnectorGateway, personId: string): Promise<string> {
  const res = await g.selfhost!.admin.inject({
    method: 'POST',
    url: '/admin/connector-code',
    headers: { authorization: `Bearer ${g.selfhost!.adminToken}` },
    payload: { person_id: personId },
  });
  expect(res.statusCode).toBe(201);
  return codeSchema.parse(res.json()).code;
}

/** A connector code the person makes from the app. */
async function appCode(g: ConnectorGateway, personId: string): Promise<string> {
  const res = await g.send('POST', '/v1/connectors/pairings', { user: personId });
  return codeSchema.parse(res.json()).code;
}

async function createAgent(g: ConnectorGateway, user: string, connectorId: string, name: string) {
  const res = await g.send('POST', '/v1/agents', {
    user,
    body: {
      name,
      protocol: 'cord-connector',
      endpoint_url: connectorEndpointUrl(connectorId, 'claude-code'),
    },
  });
  // A server-made code already listed the agent (200, the same contact): name it as before.
  expect([200, 201]).toContain(res.statusCode);
  if (res.statusCode === 201) return agentSchema.parse(res.json());
  const renamed = await g.send('PATCH', `/v1/agents/${agentSchema.parse(res.json()).id}`, {
    user,
    body: { name },
  });
  expect(renamed.statusCode).toBe(200);
  return agentSchema.parse(renamed.json());
}

const list = async (g: ConnectorGateway, user: string) =>
  agentListResponseSchema.parse((await g.send('GET', '/v1/agents', { user })).json()).agents;

/** An admin with a shared server agent, a member with a private agent, in one space. */
async function team(g: ConnectorGateway) {
  const admin = (await g.selfhost!.pair('admin', 'Asha')).person.id;
  const member = (await g.selfhost!.pair('member', 'Ravi')).person.id;
  const serverConnector = await claim(g, await adminCode(g, admin), true);
  const shared = await createAgent(g, admin, serverConnector, 'Server Claude');
  const memberConnector = await claim(g, await appCode(g, member));
  const own = await createAgent(g, member, memberConnector, 'Ravi laptop');
  return { admin, member, shared, own, serverConnector };
}

describe('server agents shared with the space', () => {
  it('a member lists the shared agents and their own, never another private agent', async () => {
    const g = await gateway();
    const { admin, member, shared, own } = await team(g);
    const other = (await g.selfhost!.pair('member', 'Meera')).person.id;
    const otherConnector = await claim(g, await appCode(g, other));
    const otherPrivate = await createAgent(g, other, otherConnector, 'Meera laptop');

    expect(shared.shared).toBe(true);
    expect(own.shared).toBeUndefined();
    const seen = await list(g, member);
    // The server-made code listed every agent the server advertised: all of them are shared.
    const ownersAgents = (await list(g, admin)).map((a) => a.id);
    expect(ownersAgents).toContain(shared.id);
    expect(seen.map((a) => a.id).sort()).toEqual([...ownersAgents, own.id].sort());
    expect(seen.find((a) => a.id === shared.id)).toMatchObject({
      shared: true,
      connector_online: true,
    });
    expect(seen.some((a) => a.id === otherPrivate.id)).toBe(false);
    // The owner sees it once, as their own, marked shared.
    expect((await list(g, admin)).filter((a) => a.id === shared.id)).toHaveLength(1);
    const one = await g.send('GET', `/v1/agents/${shared.id}`, { user: member });
    expect(one.statusCode).toBe(200);
    expect(agentSchema.parse(one.json()).shared).toBe(true);
    const hidden = await g.send('GET', `/v1/agents/${otherPrivate.id}`, { user: member });
    expect(hidden.statusCode).toBe(404);
  });

  it('a member calls a shared agent: the call and its history are theirs alone', async () => {
    const g = await gateway();
    const { admin, member, shared } = await team(g);
    const res = await g.send('POST', '/v1/calls', { user: member, body: { agent_id: shared.id } });
    expect(res.statusCode).toBe(201);
    const { call_id: callId } = createCallResponseSchema.parse(res.json());
    expect(g.calls!.registry.getFor(member, callId)).toBeDefined();
    expect(g.calls!.registry.getFor(admin, callId)).toBeUndefined();
    // The owner is not on a call: their line stays free.
    expect(g.calls!.registry.hasLiveCall(admin)).toBe(false);
    await g.send('POST', `/v1/calls/${callId}/end`, { user: member });
    await waitFor(async () => (await g.stores.history.list(member, 50)).length === 1);
    expect((await g.stores.history.list(member, 50))[0]).toMatchObject({ agent_id: shared.id });
    expect(await g.stores.history.list(admin, 50)).toEqual([]);
  });

  it('the owner deleting a shared agent ends a member call to it', async () => {
    const g = await gateway();
    const { admin, member, shared } = await team(g);
    const res = await g.send('POST', '/v1/calls', { user: member, body: { agent_id: shared.id } });
    const { call_id: callId } = createCallResponseSchema.parse(res.json());
    expect((await g.send('DELETE', `/v1/agents/${shared.id}`, { user: admin })).statusCode).toBe(
      204,
    );
    await waitFor(() => /ended|failed/.test(g.calls!.registry.get(callId)?.status ?? ''));
  });

  it.each([
    ['rename', 'PATCH', '', { name: 'Mine now' }],
    ['change the voice of', 'PATCH', '', { voice_id: 'flux-haley-en' }],
    ['delete', 'DELETE', '', undefined],
    ['test', 'POST', '/test', undefined],
  ] as const)('a member cannot %s a shared agent (403)', async (_what, method, suffix, body) => {
    const g = await gateway();
    const { member, shared, admin } = await team(g);
    const res = await g.send(method, `/v1/agents/${shared.id}${suffix}`, {
      user: member,
      ...(body !== undefined && { body }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('forbidden');
    const after = await g.stores.agents.get(admin, shared.id);
    expect(after).toMatchObject({ name: 'Server Claude', voice_id: shared.voice_id });
  });

  it('the owner can rename, change the voice of and delete it', async () => {
    const g = await gateway();
    const { admin, shared } = await team(g);
    const renamed = await g.send('PATCH', `/v1/agents/${shared.id}`, {
      user: admin,
      body: { name: 'Office Claude', voice_id: 'flux-haley-en' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(agentSchema.parse(renamed.json())).toMatchObject({
      name: 'Office Claude',
      shared: true,
    });
    expect((await g.send('DELETE', `/v1/agents/${shared.id}`, { user: admin })).statusCode).toBe(
      204,
    );
  });

  it('someone in another space neither sees nor calls it', async () => {
    const g = await gateway();
    const { shared } = await team(g);
    const outsider = (
      await g.selfhost!.stores.people.create({
        displayName: 'Zed',
        role: 'member',
        spaceId: 'other',
      })
    ).id;
    expect(await list(g, outsider)).toEqual([]);
    expect((await g.send('GET', `/v1/agents/${shared.id}`, { user: outsider })).statusCode).toBe(
      404,
    );
    const call = await g.send('POST', '/v1/calls', {
      user: outsider,
      body: { agent_id: shared.id },
    });
    expect(call.statusCode).toBe(404);
    const edit = await g.send('PATCH', `/v1/agents/${shared.id}`, {
      user: outsider,
      body: { name: 'Taken' },
    });
    expect(edit.statusCode).toBe(404);
  });

  it("a member's own code asking for shared: true is stored as not shared", async () => {
    const g = await gateway();
    const { admin } = await team(g);
    const member = (await g.selfhost!.pair('member', 'Meera')).person.id;
    const connectorId = await claim(g, await appCode(g, member), true);
    expect((await g.stores.connectors.get(member, connectorId))?.shared).toBeUndefined();
    const agent = await createAgent(g, member, connectorId, 'Meera laptop');
    expect(agent.shared).toBeUndefined();
    expect((await list(g, admin)).some((a) => a.id === agent.id)).toBe(false);
  });

  it("the admin listener's code for a member is not shared either", async () => {
    const g = await gateway();
    const { admin } = await team(g);
    const member = (await g.selfhost!.pair('member', 'Meera')).person.id;
    const connectorId = await claim(g, await adminCode(g, member), true);
    expect((await g.stores.connectors.get(member, connectorId))?.shared).toBeUndefined();
    const agent = await createAgent(g, member, connectorId, 'Meera laptop');
    expect((await list(g, admin)).some((a) => a.id === agent.id)).toBe(false);
  });

  it('removing the owner hides their shared agent and stops calls to it', async () => {
    const g = await gateway();
    const { admin, member, shared } = await team(g);
    const second = await g.selfhost!.pair('admin', 'Kiran');
    const removed = await g.send('DELETE', `/v1/people/${admin}`, {
      headers: { authorization: `Bearer ${second.device.token}` },
    });
    expect(removed.statusCode).toBe(204);
    expect((await list(g, member)).some((a) => a.id === shared.id)).toBe(false);
    const call = await g.send('POST', '/v1/calls', { user: member, body: { agent_id: shared.id } });
    expect(call.statusCode).toBe(404);
  });
});

describe('hosted Twring', () => {
  it('ignores shared on a claim and never marks an agent shared', async () => {
    const g = await gateway(false);
    const connectorId = await claim(g, await appCode(g, 'alice'), true);
    expect((await g.stores.connectors.get('alice', connectorId))?.shared).toBeUndefined();
    const agent = await createAgent(g, 'alice', connectorId, 'Laptop');
    expect(agent.shared).toBeUndefined();
    expect(await list(g, 'bob')).toEqual([]);
    const call = await g.send('POST', '/v1/calls', { user: 'bob', body: { agent_id: agent.id } });
    expect(call.statusCode).toBe(404);
  });
});

describe('canUseAgent and canEditAgent', () => {
  const record = { user_id: 'asha' } as AgentRecord;
  it('lets the owner use and edit; a shared agent is usable in the same space only', () => {
    expect(canUseAgent('asha', { record, shared: false, sameSpace: false })).toBe(true);
    expect(canUseAgent('ravi', { record, shared: false, sameSpace: true })).toBe(false);
    expect(canUseAgent('ravi', { record, shared: true, sameSpace: true })).toBe(true);
    expect(canUseAgent('zed', { record, shared: true, sameSpace: false })).toBe(false);
    expect(canEditAgent('asha', { record, shared: true, sameSpace: true })).toBe(true);
    expect(canEditAgent('ravi', { record, shared: true, sameSpace: true })).toBe(false);
  });
});
