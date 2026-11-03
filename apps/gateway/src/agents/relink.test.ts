import {
  agentListResponseSchema,
  agentSchema,
  connectorEndpointUrl,
  createAgentResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

import { computerGone } from './relink';

/**
 * Wave 1, track 2.3: a computer linked again rejoins its contacts. Adding an agent from a newly
 * linked computer reuses the one existing contact for that agent whose computer (same name) is gone
 * or offline, keeping its chats and history, instead of making a duplicate.
 */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway() {
  const g = await startConnectorGateway();
  gateways.push(g);
  return g;
}

function add(g: ConnectorGateway, connectorId: string, localAgent = 'claude-code') {
  return g.send('POST', '/v1/agents', {
    user: 'alice',
    body: {
      name: 'Laptop Claude',
      protocol: 'cord-connector',
      endpoint_url: connectorEndpointUrl(connectorId, localAgent),
    },
  });
}

async function agents(g: ConnectorGateway) {
  const res = await g.send('GET', '/v1/agents', { user: 'alice' });
  return agentListResponseSchema.parse(res.json()).agents;
}

describe('re-linking a computer', () => {
  it('a removed computer, linked again: its contact moves over, no duplicate', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    const contactId = await g.createAgent('alice', old.connectorId);
    expect(
      (await g.send('DELETE', `/v1/connectors/${old.connectorId}`, { user: 'alice' })).statusCode,
    ).toBe(204);
    const fresh = await g.pair('alice');
    const res = await add(g, fresh.connectorId);
    expect(res.statusCode).toBe(200);
    const moved = agentSchema.parse(res.json());
    expect(moved.id).toBe(contactId);
    expect(moved.endpoint_url).toBe(connectorEndpointUrl(fresh.connectorId, 'claude-code'));
    expect(moved.connector_removed).toBeUndefined();
    // The app says "Reconnected to <name>" for this, not "Connected".
    expect(createAgentResponseSchema.parse(res.json()).relinked).toBe(true);
    expect((await agents(g)).map((a) => a.id)).toEqual([contactId]);
  });

  it('the old computer still linked but offline (its link was lost): same', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    const contactId = await g.createAgent('alice', old.connectorId);
    const fresh = await g.pair('alice');
    const res = await add(g, fresh.connectorId);
    expect(res.statusCode).toBe(200);
    expect(agentSchema.parse(res.json()).id).toBe(contactId);
  });

  it('the old computer is online: a second contact, as before', async () => {
    const g = await gateway();
    const old = await g.connect('alice');
    await g.createAgent('alice', old.connectorId);
    const fresh = await g.pair('alice');
    const created = await add(g, fresh.connectorId);
    expect(created.statusCode).toBe(201);
    expect(createAgentResponseSchema.parse(created.json()).relinked).toBeUndefined();
    expect(await agents(g)).toHaveLength(2);
  });

  it('a computer with another name, or another agent: a new contact', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    await g.createAgent('alice', old.connectorId);
    await g.stores.connectors.touch(old.connectorId, [], new Date(), 'Office desktop');
    await g.send('DELETE', `/v1/connectors/${old.connectorId}`, { user: 'alice' });
    const fresh = await g.pair('alice');
    expect((await add(g, fresh.connectorId)).statusCode).toBe(201);
    expect((await add(g, fresh.connectorId, 'gemini')).statusCode).toBe(201);
    expect(await agents(g)).toHaveLength(3);
  });

  it('an old computer seen in the last 10 minutes is only briefly offline: a new contact', async () => {
    const g = await gateway();
    const old = await g.connect('alice');
    await g.createAgent('alice', old.connectorId);
    old.connector.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = await g.pair('alice');
    expect((await add(g, fresh.connectorId)).statusCode).toBe(201);
    expect(await agents(g)).toHaveLength(2);
  });

  it('two old contacts could match: nothing is guessed, a new contact is made', async () => {
    const g = await gateway();
    // Two computers with the same name, both removed later.
    const a = await g.connect('alice');
    await g.createAgent('alice', a.connectorId);
    const b = await g.pair('alice');
    await g.createAgent('alice', b.connectorId);
    await g.send('DELETE', `/v1/connectors/${a.connectorId}`, { user: 'alice' });
    await g.send('DELETE', `/v1/connectors/${b.connectorId}`, { user: 'alice' });
    const fresh = await g.pair('alice');
    expect((await add(g, fresh.connectorId)).statusCode).toBe(201);
    expect(await agents(g)).toHaveLength(3);
  });

  it("another person's contact is never moved", async () => {
    const g = await gateway();
    const bob = await g.pair('bob');
    await g.createAgent('bob', bob.connectorId);
    await g.send('DELETE', `/v1/connectors/${bob.connectorId}`, { user: 'bob' });
    const fresh = await g.pair('alice');
    expect((await add(g, fresh.connectorId)).statusCode).toBe(201);
    const bobs = await g.send('GET', '/v1/agents', { user: 'bob' });
    expect(agentListResponseSchema.parse(bobs.json()).agents).toHaveLength(1);
  });
});

describe('computerGone (review: the 10 minutes run from when it dropped)', () => {
  const NOW = Date.parse('2026-10-22T15:00:00.000Z');
  const old = { name: 'Test laptop', last_seen_at: '2026-10-22T09:00:00.000Z' };
  const base = { newName: 'Test laptop', contactComputerName: undefined, online: false, now: NOW };

  it('online since the morning, dropped a minute ago: not gone', () => {
    expect(computerGone({ ...base, oldComputer: old, droppedAt: NOW - 60_000 })).toBe(false);
  });

  it('dropped 11 minutes ago: gone', () => {
    expect(computerGone({ ...base, oldComputer: old, droppedAt: NOW - 11 * 60_000 })).toBe(true);
  });

  it('not dropped since this server started, last hello long ago: gone', () => {
    expect(computerGone({ ...base, oldComputer: old, droppedAt: undefined })).toBe(true);
  });

  it('online, or another name: never gone', () => {
    expect(computerGone({ ...base, oldComputer: old, droppedAt: undefined, online: true })).toBe(
      false,
    );
    expect(
      computerGone({ ...base, oldComputer: { ...old, name: 'Office' }, droppedAt: undefined }),
    ).toBe(false);
  });

  it('removed: gone when the contact kept the same computer name', () => {
    expect(
      computerGone({
        ...base,
        oldComputer: undefined,
        contactComputerName: 'Test laptop',
        droppedAt: undefined,
      }),
    ).toBe(true);
    expect(computerGone({ ...base, oldComputer: undefined, droppedAt: undefined })).toBe(false);
  });
});

describe('re-link review fixes', () => {
  it('the voice just chosen is applied, the name the owner set is kept, and it starts untested', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    const contactId = await g.createAgent('alice', old.connectorId);
    await g.send('DELETE', `/v1/connectors/${old.connectorId}`, { user: 'alice' });
    const fresh = await g.pair('alice');
    const res = await g.send('POST', '/v1/agents', {
      user: 'alice',
      body: {
        name: 'Claude Code',
        protocol: 'cord-connector',
        endpoint_url: connectorEndpointUrl(fresh.connectorId, 'claude-code'),
        voice_id: 'flux-cliff-en',
      },
    });
    expect(res.statusCode).toBe(200);
    const moved = agentSchema.parse(res.json());
    expect(moved.id).toBe(contactId);
    expect(moved.name).toBe('Laptop Claude');
    expect(moved.voice_id).toBe('flux-cliff-en');
    expect(moved.status).toBe('untested');
  });

  it('two adds at once return the same moved contact, never a duplicate', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    const contactId = await g.createAgent('alice', old.connectorId);
    await g.send('DELETE', `/v1/connectors/${old.connectorId}`, { user: 'alice' });
    const fresh = await g.pair('alice');
    const [a, b] = await Promise.all([add(g, fresh.connectorId), add(g, fresh.connectorId)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(agentSchema.parse(a.json()).id).toBe(contactId);
    expect(agentSchema.parse(b.json()).id).toBe(contactId);
    expect(await agents(g)).toHaveLength(1);
  });

  it('adding the same agent again on the same computer is not a reconnection', async () => {
    const g = await gateway();
    const old = await g.pair('alice');
    const contactId = await g.createAgent('alice', old.connectorId);
    await g.send('DELETE', `/v1/connectors/${old.connectorId}`, { user: 'alice' });
    const fresh = await g.pair('alice');
    expect(createAgentResponseSchema.parse((await add(g, fresh.connectorId)).json()).relinked).toBe(
      true,
    );
    const again = await add(g, fresh.connectorId);
    expect(again.statusCode).toBe(200);
    const body = createAgentResponseSchema.parse(again.json());
    expect(body.id).toBe(contactId);
    expect(body.relinked).toBeUndefined();
  });
});
