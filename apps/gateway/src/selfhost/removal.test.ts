import { afterEach, describe, expect, it, vi } from 'vitest';

import { newCallIds } from '../calls/ids';
import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';
import { PhoneSocketHub } from '../threads/socket';

/** Removing people and phones on a self-hosted server, wired through the whole app. */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway({ selfhost: true, ring: { push: false }, ...options });
  gateways.push(g);
  return g;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function people(g: ConnectorGateway) {
  const admin = await g.selfhost!.pair('admin', 'Asha');
  const member = await g.selfhost!.pair('member', 'Ravi');
  return { admin, member };
}

const ringAs = (g: ConnectorGateway, token: string) =>
  g.send('POST', '/v1/connectors/ring', {
    headers: bearer(token),
    body: { local_agent: 'claude-code', reason: 'The build failed' },
  });

/** A member with an agent, a call summary and a chat message. */
async function seedData(g: ConnectorGateway, memberId: string) {
  const { connectorId, token } = await g.pair(memberId);
  const agentId = await g.createAgent(memberId, connectorId);
  await g.stores.history.record(memberId, {
    call_id: newCallIds().callId,
    agent_id: agentId,
    agent_name: 'Laptop Claude',
    started_at: new Date().toISOString(),
    duration_s: 5,
    outcome: 'completed',
  });
  const message = await g.send('POST', '/v1/connectors/messages', {
    headers: { ...bearer(token), 'idempotency-key': `seed-${memberId}` },
    body: { local_agent: 'claude-code', text: 'Hello', origin: 'agent' },
  });
  expect(message.statusCode).toBe(201);
}

async function dataLeft(g: ConnectorGateway, memberId: string) {
  return {
    agents: (await g.stores.agents.list(memberId)).length,
    history: (await g.stores.history.list(memberId, 50)).length,
    threads: (await g.threads!.store.listThreads(memberId)).length,
  };
}

/** A self-hosted phone rings through the relay: it hands its server the relay's handle. */
async function registerRingPhone(g: ConnectorGateway, deviceToken: string) {
  const res = await g.send('PUT', '/v1/me/paired-devices/current/relay', {
    headers: bearer(deviceToken),
    body: { handle: 'hdl_member_phone' },
  });
  expect(res.statusCode).toBe(204);
}

describe.each([
  ['the app', 'app'],
  ['the admin listener', 'admin'],
] as const)('removing a person through %s', (_name, via) => {
  const remove = (g: ConnectorGateway, adminToken: string, id: string, purge = false) =>
    via === 'app'
      ? g.send('DELETE', `/v1/people/${id}${purge ? '?purge=1' : ''}`, {
          headers: bearer(adminToken),
        })
      : g.selfhost!.admin.inject({
          method: 'DELETE',
          url: `/admin/people/${id}${purge ? '?purge=1' : ''}`,
          headers: bearer(g.selfhost!.adminToken),
        });

  it('revokes their computers, ring phones and paired phones at once', async () => {
    const g = await gateway();
    const { admin, member } = await people(g);
    const memberId = member.person.id;
    const { token: connectorToken } = await g.pair(memberId);
    await registerRingPhone(g, member.device.token);
    expect((await g.selfhost!.stores.devices.get(member.device.id))?.relay_handle).toBe(
      'hdl_member_phone',
    );
    expect((await ringAs(g, connectorToken)).statusCode).not.toBe(401);

    expect((await remove(g, admin.device.token, memberId)).statusCode).toBe(204);

    expect((await ringAs(g, connectorToken)).statusCode).toBe(401);
    expect(await g.selfhost!.stores.devices.listFor(memberId)).toEqual([]);
    expect((await g.selfhost!.stores.devices.get(member.device.id))?.relay_handle).toBeUndefined();
    const next = await g.send('GET', '/v1/people', { headers: bearer(member.device.token) });
    expect(next.statusCode).toBe(401);
  });

  it('ends their live call and closes their phone socket at once', async () => {
    const closeUser = vi.spyOn(PhoneSocketHub.prototype, 'closeUser');
    const g = await gateway({ threads: {}, calls: { allowance: { callSeconds: 0, calls: 5 } } });
    const { admin, member } = await people(g);
    const memberId = member.person.id;
    const { connectorId } = await g.connect(memberId);
    const agentId = await g.createAgent(memberId, connectorId);
    const call = await g.send('POST', '/v1/calls', {
      headers: bearer(member.device.token),
      body: { agent_id: agentId },
    });
    expect(call.statusCode).toBe(201);
    expect(g.calls!.registry.hasLiveCall(memberId)).toBe(true);

    expect((await remove(g, admin.device.token, memberId)).statusCode).toBe(204);

    expect(g.calls!.registry.hasLiveCall(memberId)).toBe(false);
    expect(closeUser).toHaveBeenCalledWith(memberId);
    closeUser.mockRestore();
  });

  it('with purge=1 also deletes their agents, history and threads', async () => {
    const g = await gateway({ threads: {} });
    const { admin, member } = await people(g);
    const memberId = member.person.id;
    const { connectorId, token } = await g.pair(memberId);
    const agentId = await g.createAgent(memberId, connectorId);
    await g.stores.history.record(memberId, {
      call_id: newCallIds().callId,
      agent_id: agentId,
      agent_name: 'Laptop Claude',
      started_at: new Date().toISOString(),
      duration_s: 5,
      outcome: 'completed',
    });
    const message = await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(token), 'idempotency-key': 'purge-1' },
      body: { local_agent: 'claude-code', text: 'Hello', origin: 'agent' },
    });
    expect(message.statusCode).toBe(201);
    expect(await g.threads!.store.listThreads(memberId)).not.toEqual([]);

    expect((await remove(g, admin.device.token, memberId, true)).statusCode).toBe(204);

    expect(await g.stores.agents.list(memberId)).toEqual([]);
    expect(await g.stores.history.list(memberId, 50)).toEqual([]);
    expect(await g.threads!.store.listThreads(memberId)).toEqual([]);
    expect(await g.selfhost!.stores.people.get(memberId)).toBeUndefined();
  });

  it('plain removal keeps their agents, history and threads', async () => {
    const g = await gateway({ threads: {} });
    const { admin, member } = await people(g);
    await seedData(g, member.person.id);
    expect((await remove(g, admin.device.token, member.person.id)).statusCode).toBe(204);
    expect(await dataLeft(g, member.person.id)).toEqual({ agents: 1, history: 1, threads: 1 });
  });

  it('purges a person who was already removed', async () => {
    const g = await gateway({ threads: {} });
    const { admin, member } = await people(g);
    await seedData(g, member.person.id);
    expect((await remove(g, admin.device.token, member.person.id)).statusCode).toBe(204);
    expect((await remove(g, admin.device.token, member.person.id, true)).statusCode).toBe(204);
    expect(await dataLeft(g, member.person.id)).toEqual({ agents: 0, history: 0, threads: 0 });
    expect(await g.selfhost!.stores.people.get(member.person.id)).toBeUndefined();
  });

  it('a purge that failed part-way completes when retried', async () => {
    const g = await gateway({ threads: {} });
    const { admin, member } = await people(g);
    await seedData(g, member.person.id);
    vi.spyOn(g.stores.history, 'deleteAllForUser').mockRejectedValueOnce(new Error('disk full'));
    const first = await remove(g, admin.device.token, member.person.id, true);
    expect(first.statusCode).toBe(500);
    expect((await remove(g, admin.device.token, member.person.id, true)).statusCode).toBe(204);
    expect(await dataLeft(g, member.person.id)).toEqual({ agents: 0, history: 0, threads: 0 });
    expect(await g.selfhost!.stores.people.get(member.person.id)).toBeUndefined();
  });

  it('purging the last admin answers 409 last_admin and deletes nothing', async () => {
    const g = await gateway({ threads: {} });
    const { admin } = await people(g);
    await seedData(g, admin.person.id);
    const res = await remove(g, admin.device.token, admin.person.id, true);
    expect(res.statusCode).toBe(409);
    if (via === 'app') expect(res.json()).toMatchObject({ error: { code: 'last_admin' } });
    const person = await g.selfhost!.stores.people.get(admin.person.id);
    expect(person).toBeDefined();
    expect(person?.removed_at).toBeUndefined();
    expect(await g.selfhost!.stores.devices.listFor(admin.person.id)).toHaveLength(1);
    expect(await dataLeft(g, admin.person.id)).toEqual({ agents: 1, history: 1, threads: 1 });
  });

  it('refuses the last admin with 409', async () => {
    const g = await gateway();
    const { admin } = await people(g);
    const res = await remove(g, admin.device.token, admin.person.id);
    expect(res.statusCode).toBe(409);
  });
});

describe('a phone removed during its live call (Review Focus 2)', () => {
  it('keeps the call going; the next request from that phone is 401 device_removed', async () => {
    const g = await gateway({ calls: { allowance: { callSeconds: 0, calls: 5 } } });
    const { admin, member } = await people(g);
    const memberId = member.person.id;
    const { connectorId } = await g.connect(memberId);
    const agentId = await g.createAgent(memberId, connectorId);
    const call = await g.send('POST', '/v1/calls', {
      headers: bearer(member.device.token),
      body: { agent_id: agentId },
    });
    expect(call.statusCode).toBe(201);
    expect(g.calls!.registry.hasLiveCall(memberId)).toBe(true);

    const removed = await g.send('DELETE', `/v1/people/${memberId}/devices/${member.device.id}`, {
      headers: bearer(admin.device.token),
    });
    expect(removed.statusCode).toBe(204);

    expect(g.calls!.registry.hasLiveCall(memberId)).toBe(true);
    expect(g.calls!.registry.activeCount).toBe(1);
    const next = await g.send('GET', '/v1/people', { headers: bearer(member.device.token) });
    expect(next.statusCode).toBe(401);
    expect(next.json()).toMatchObject({ error: { code: 'device_removed' } });
  });
});

describe('a member cannot remove people', () => {
  it.each([false, true])('purge=%s: 403 forbidden and nothing changes', async (purge) => {
    const g = await gateway({ threads: {} });
    const { admin, member } = await people(g);
    await seedData(g, admin.person.id);
    const res = await g.send('DELETE', `/v1/people/${admin.person.id}${purge ? '?purge=1' : ''}`, {
      headers: bearer(member.device.token),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect((await g.selfhost!.stores.people.get(admin.person.id))?.removed_at).toBeUndefined();
    expect(await g.selfhost!.stores.devices.listFor(admin.person.id)).toHaveLength(1);
    expect(await dataLeft(g, admin.person.id)).toEqual({ agents: 1, history: 1, threads: 1 });
  });
});

describe('listing removed people', () => {
  it('the admin listener and an admin in the app can list removed people', async () => {
    const g = await gateway();
    const { admin, member } = await people(g);
    await g.send('DELETE', `/v1/people/${member.person.id}`, {
      headers: bearer(admin.device.token),
    });
    const viaAdmin = await g.selfhost!.admin.inject({
      method: 'GET',
      url: '/admin/people?removed=1',
      headers: bearer(g.selfhost!.adminToken),
    });
    expect(viaAdmin.json<{ people: { id: string }[] }>().people.map((p) => p.id)).toEqual([
      member.person.id,
    ]);
    const viaApp = await g.send('GET', '/v1/people?removed=1', {
      headers: bearer(admin.device.token),
    });
    expect(viaApp.json<{ people: { id: string }[] }>().people.map((p) => p.id)).toEqual([
      member.person.id,
    ]);
    const current = await g.send('GET', '/v1/people', { headers: bearer(admin.device.token) });
    expect(current.json<{ people: { id: string }[] }>().people.map((p) => p.id)).toEqual([
      admin.person.id,
    ]);
  });
});

describe('ring push registration in self-hosted mode', () => {
  it('PUT and DELETE /v1/me/devices/:id answer 404: phones register with the relay', async () => {
    const g = await gateway();
    const { admin } = await people(g);
    const headers = bearer(admin.device.token);
    const put = await g.send('PUT', '/v1/me/devices/dev-1', {
      headers,
      body: { fcm_token: 'f'.repeat(40), platform: 'android', app_variant: 'beta' },
    });
    expect(put.statusCode).toBe(404);
    expect((await g.send('DELETE', '/v1/me/devices/dev-1', { headers })).statusCode).toBe(404);
  });
});
