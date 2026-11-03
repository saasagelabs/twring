import { randomUUID } from 'node:crypto';

import {
  agentSchema,
  claimResponseSchema,
  connectorEndpointUrl,
  createCallResponseSchema,
  errorResponseSchema,
  messagePageResponseSchema,
  SCOPED_SESSIONS_FEATURE,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { OfflineSocket } from '../connectors/hub';
import { personWords } from './words';
import {
  startConnectorGateway,
  type ConnectorGateway,
  type ConnectorGatewayOptions,
} from '../connectors/harness';
import {
  FAKE_AGENTS,
  startFakeConnector,
  type FakeConnector,
  type FakeConnectorScript,
} from '../connectors/testing';

/**
 * One agent session per person on a shared server agent (self-host Task 4 fix): the owner's
 * channels are exactly as before; everyone else gets their own scoped session, results and files.
 */

const gateways: ConnectorGateway[] = [];
const sockets: FakeConnector[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

const SCOPE = /^[0-9a-f]{32}$/;
const codeSchema = z.object({ code: z.string() });

async function gateway(options: ConnectorGatewayOptions = {}) {
  const g = await startConnectorGateway({
    selfhost: true,
    calls: { allowance: { callSeconds: 0, calls: 50 } },
    ...options,
  });
  gateways.push(g);
  return g;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Linked {
  connectorId: string;
  token: string;
  socket: FakeConnector;
}

async function link(
  g: ConnectorGateway,
  personId: string,
  options: { shared?: boolean; admin?: boolean; features?: string[]; script?: FakeConnectorScript },
): Promise<Linked> {
  const codeRes =
    options.admin === true
      ? await g.selfhost!.admin.inject({
          method: 'POST',
          url: '/admin/connector-code',
          headers: { authorization: `Bearer ${g.selfhost!.adminToken}` },
          payload: { person_id: personId },
        })
      : await g.send('POST', '/v1/connectors/pairings', { user: personId });
  const { code } = codeSchema.parse(codeRes.json());
  const res = await g.send('POST', '/v1/connectors/claim', {
    body: {
      code,
      name: 'Home server',
      agents: FAKE_AGENTS,
      ...(options.shared !== undefined && { shared: options.shared }),
    },
  });
  const { connector_id: connectorId, token } = claimResponseSchema.parse(res.json());
  const socket = startFakeConnector({
    url: g.socketUrl,
    token,
    ...(options.features !== undefined && { features: options.features }),
    ...(options.script !== undefined && { script: options.script }),
  });
  sockets.push(socket);
  await socket.ready;
  return { connectorId, token, socket };
}

async function addAgent(g: ConnectorGateway, user: string, connectorId: string) {
  const res = await g.send('POST', '/v1/agents', {
    user,
    body: {
      name: 'Server Claude',
      protocol: 'cord-connector',
      endpoint_url: connectorEndpointUrl(connectorId, 'claude-code'),
    },
  });
  // A server-made code already listed the agent (200, the same contact): name it as before.
  expect([200, 201]).toContain(res.statusCode);
  const agent = agentSchema.parse(res.json());
  if (res.statusCode === 200) {
    const renamed = await g.send('PATCH', `/v1/agents/${agent.id}`, {
      user,
      body: { name: 'Server Claude' },
    });
    expect(renamed.statusCode).toBe(200);
  }
  return agent.id;
}

/** An admin's shared server agent, and two members in the space. */
async function team(
  g: ConnectorGateway,
  options: { features?: string[]; script?: FakeConnectorScript } = {
    features: [SCOPED_SESSIONS_FEATURE],
  },
) {
  const admin = (await g.selfhost!.pair('admin', 'Asha')).person.id;
  const ravi = (await g.selfhost!.pair('member', 'Ravi')).person.id;
  const meera = (await g.selfhost!.pair('member', 'Meera')).person.id;
  const server = await link(g, admin, { shared: true, admin: true, ...options });
  const agentId = await addAgent(g, admin, server.connectorId);
  return { admin, ravi, meera, server, agentId };
}

async function call(g: ConnectorGateway, user: string, agentId: string) {
  return g.send('POST', '/v1/calls', { user, body: { agent_id: agentId } });
}

/** Starts a call and waits for its channel to open; resolves the call id. */
async function connectedCall(g: ConnectorGateway, socket: FakeConnector, user: string, id: string) {
  const before = socket.opened.length;
  const res = await call(g, user, id);
  expect(res.statusCode).toBe(201);
  await waitFor(() => socket.opened.length > before);
  return createCallResponseSchema.parse(res.json()).call_id;
}

async function hangUp(g: ConnectorGateway, user: string, callId: string) {
  await g.send('POST', `/v1/calls/${callId}/end`, { user });
  await waitFor(() => !g.calls!.registry.hasLiveCall(user));
}

describe('who may change a shared server agent', () => {
  const list = async (g: ConnectorGateway, user: string) =>
    z
      .object({ agents: z.array(agentSchema) })
      .parse((await g.send('GET', '/v1/agents', { user })).json()).agents;

  it('flags it can_edit false for a member, and says nothing to its owner', async () => {
    const g = await gateway();
    const { admin, ravi, agentId } = await team(g);
    const seenByMember = (await list(g, ravi)).find((a) => a.id === agentId);
    expect(seenByMember).toMatchObject({ shared: true, can_edit: false });
    const seenByOwner = (await list(g, admin)).find((a) => a.id === agentId);
    expect(seenByOwner?.shared).toBe(true);
    expect(seenByOwner).not.toHaveProperty('can_edit');
    const one = await g.send('GET', `/v1/agents/${agentId}`, { user: ravi });
    expect(agentSchema.parse(one.json()).can_edit).toBe(false);
  });

  it("a person's own agent never carries can_edit", async () => {
    const g = await gateway();
    const { ravi } = await team(g);
    const own = await link(g, ravi, {});
    const ownId = await addAgent(g, ravi, own.connectorId);
    const mine = (await list(g, ravi)).find((a) => a.id === ownId);
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('can_edit');
  });

  it('hosted mode never sends can_edit', async () => {
    const g = await gateway({ selfhost: false });
    const own = await link(g, 'user-1', {});
    await addAgent(g, 'user-1', own.connectorId);
    const agents = await list(g, 'user-1');
    expect(agents).toHaveLength(1);
    for (const agent of agents) expect(agent).not.toHaveProperty('can_edit');
  });
});

describe('calls to a shared server agent', () => {
  it("each person gets their own session; the owner's frame is unchanged", async () => {
    const g = await gateway();
    const { admin, ravi, meera, server, agentId } = await team(g);
    for (const user of [admin, ravi, meera]) {
      await hangUp(g, user, await connectedCall(g, server.socket, user, agentId));
    }
    const [own, first, second] = server.socket.rawOpens;
    expect(Object.keys(own!).sort()).toEqual(['agent', 'channel', 'type']);
    expect(first!.session_scope).toMatch(SCOPE);
    expect(second!.session_scope).toMatch(SCOPE);
    expect(first!.session_scope).not.toBe(second!.session_scope);
    // Opaque: never the person's id.
    expect(JSON.stringify(server.socket.rawOpens)).not.toContain(ravi);
  });

  it('refuses a member on an outdated computer link and never opens a shared session', async () => {
    const g = await gateway();
    const { admin, ravi, server, agentId } = await team(g, {});
    const res = await call(g, ravi, agentId);
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('computer_link_outdated');
    expect(server.socket.opened).toEqual([]);
    // The owner still calls it as before.
    await connectedCall(g, server.socket, admin, agentId);
    expect(server.socket.opened).toHaveLength(1);
  });

  it('the relay itself never opens a scoped channel on an outdated computer', async () => {
    const g = await gateway();
    const { admin, server } = await team(g, {});
    const socket = g.hub.socketFor(
      admin,
      server.connectorId,
      'claude-code',
      undefined,
      false,
      'a'.repeat(32),
    );
    expect(socket).toBeInstanceOf(OfflineSocket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.socket.rawOpens).toEqual([]);
  });

  it("a member's call never takes the owner's fresh-session flag; each resets their own", async () => {
    const g = await gateway();
    const { admin, ravi, server, agentId } = await team(g);
    const reset = (user: string) =>
      g.send('POST', `/v1/agents/${agentId}/new-conversation`, { user });
    expect((await reset(admin)).statusCode).toBe(200);
    await hangUp(g, ravi, await connectedCall(g, server.socket, ravi, agentId));
    expect(server.socket.opened.at(-1)?.fresh_session).toBeUndefined();
    expect((await g.stores.agents.get(admin, agentId))?.fresh_session_pending).toBe(true);

    expect((await reset(ravi)).statusCode).toBe(200);
    await hangUp(g, ravi, await connectedCall(g, server.socket, ravi, agentId));
    expect(server.socket.opened.at(-1)).toMatchObject({ fresh_session: true });
    await hangUp(g, ravi, await connectedCall(g, server.socket, ravi, agentId));
    expect(server.socket.opened.at(-1)?.fresh_session).toBeUndefined();
    await hangUp(g, admin, await connectedCall(g, server.socket, admin, agentId));
    expect(server.socket.opened.at(-1)).toMatchObject({ fresh_session: true });
  });
});

describe('results and files from a member session', () => {
  const post = (g: ConnectorGateway, token: string, body: Record<string, unknown>) =>
    g.send('POST', '/v1/connectors/messages', {
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      body: { local_agent: 'claude-code', origin: 'call_turn', ...body },
    });

  // A self-hosted server has no push registration route (phones register with the relay), so
  // the test harness's ring phone is stored directly.
  async function ringPhone(g: ConnectorGateway, user: string, token: string) {
    await g.ring!.stores.devices.upsert({
      user_id: user,
      device_id: `phone-${user.slice(0, 8)}`,
      fcm_token: token,
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
  }

  async function memberScope(g: ConnectorGateway, socket: FakeConnector, user: string, id: string) {
    await hangUp(g, user, await connectedCall(g, socket, user, id));
    return socket.opened.at(-1)!.session_scope!;
  }

  it("lands in the member's thread and rings the member, never the owner", async () => {
    const g = await gateway({ threads: {}, ring: {} });
    const { admin, ravi, server, agentId } = await team(g);
    await ringPhone(g, admin, 'fcm-admin-aaaaaaaaaaaaaaaaaa');
    await ringPhone(g, ravi, 'fcm-ravi-aaaaaaaaaaaaaaaaaaa');
    const scope = await memberScope(g, server.socket, ravi, agentId);
    const res = await post(g, server.token, { text: 'Build passed.', session_scope: scope });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ delivery: 'ring' });
    expect(g.ring!.pushes.map((p) => p.token)).toEqual(['fcm-ravi-aaaaaaaaaaaaaaaaaaa']);
    expect((await g.threads!.store.listThreads(ravi)).map((t) => t.agent_id)).toEqual([agentId]);
    expect(await g.threads!.store.listThreads(admin)).toEqual([]);
  });

  it("a member's open call does not hold back the owner's own result", async () => {
    const g = await gateway({ threads: {}, ring: {} });
    const { admin, ravi, server, agentId } = await team(g);
    await ringPhone(g, admin, 'fcm-admin-aaaaaaaaaaaaaaaaaa');
    await connectedCall(g, server.socket, ravi, agentId);
    const res = await post(g, server.token, { text: 'Owner result.' });
    expect(res.json()).toMatchObject({ delivery: 'ring' });
    expect(g.ring!.pushes.map((p) => p.token)).toEqual(['fcm-admin-aaaaaaaaaaaaaaaaaa']);
  });

  it('rejects an unknown scope, and any scope on a computer that is not shared', async () => {
    const g = await gateway({ threads: {}, ring: {} });
    const { ravi, server, agentId } = await team(g);
    const forged = await post(g, server.token, { text: 'x', session_scope: 'f'.repeat(32) });
    expect(forged.statusCode).toBe(400);
    const scope = await memberScope(g, server.socket, ravi, agentId);
    const laptop = await link(g, ravi, { features: [SCOPED_SESSIONS_FEATURE] });
    await addAgent(g, ravi, laptop.connectorId);
    const own = await post(g, laptop.token, { text: 'x', session_scope: scope });
    expect(own.statusCode).toBe(400);
    expect(await g.threads!.store.listThreads(ravi)).toEqual([]);
  });

  it("a member's file is stored under the member", async () => {
    const g = await gateway({ threads: { files: true }, ring: {} });
    const { admin, ravi, server, agentId } = await team(g);
    const scope = await memberScope(g, server.socket, ravi, agentId);
    const upload = (sessionScope?: string) =>
      g.app.inject({
        method: 'POST',
        url:
          `/v1/connectors/files?local_agent=claude-code&client_id=${randomUUID()}&name=a.txt` +
          (sessionScope === undefined ? '' : `&session_scope=${sessionScope}`),
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'text/plain' },
        payload: 'hello',
      });
    const res = await upload(scope);
    expect(res.statusCode).toBe(201);
    const id = z.object({ file: z.object({ id: z.string() }) }).parse(res.json()).file.id;
    expect(g.threads!.store.findFile(ravi, id)).toBeDefined();
    expect(g.threads!.store.findFile(admin, id)).toBeUndefined();
    expect((await upload('f'.repeat(32))).statusCode).toBe(400);
  });
});

describe('chats with a shared server agent', () => {
  const send = (g: ConnectorGateway, user: string, agentId: string, text: string) =>
    g.send('POST', `/v1/agents/${agentId}/messages`, {
      user,
      body: { client_id: randomUUID(), text },
    });
  const messages = async (g: ConnectorGateway, user: string, agentId: string) =>
    messagePageResponseSchema.parse(
      (await g.send('GET', `/v1/agents/${agentId}/messages`, { user })).json(),
    ).messages;

  it("work in the member's own session and stay private to them", async () => {
    const g = await gateway({ threads: {} });
    const { admin, ravi, server, agentId } = await team(g);
    expect((await send(g, ravi, agentId, 'Hello from Ravi')).statusCode).toBe(201);
    await waitFor(async () =>
      (await messages(g, ravi, agentId)).some((m) => m.kind === 'agent_text'),
    );
    expect(server.socket.opened.at(-1)?.session_scope).toMatch(SCOPE);
    expect(await messages(g, admin, agentId)).toEqual([]);
    expect((await send(g, admin, agentId, 'Hello from Asha')).statusCode).toBe(201);
    await waitFor(async () =>
      (await messages(g, admin, agentId)).some((m) => m.kind === 'agent_text'),
    );
    expect(server.socket.rawOpens.at(-1)?.session_scope).toBeUndefined();
    const raviTexts = (await messages(g, ravi, agentId)).flatMap((m) =>
      m.kind === 'user_text' ? [m.text] : [],
    );
    expect(raviTexts).toEqual(['Hello from Ravi']);
  });

  it('are refused for a member on an outdated computer link', async () => {
    const g = await gateway({ threads: {} });
    const { ravi, server, agentId } = await team(g, {});
    const res = await send(g, ravi, agentId, 'Hi');
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('computer_link_outdated');
    expect(server.socket.opened).toEqual([]);
  });

  /** Asks for approval, then answers once a decision arrives (or after a short wait). */
  const askingScript: FakeConnectorScript = async (turn, ctx) => {
    ctx.send({
      type: 'approval.required',
      event_id: `evt_${turn.turn_id}_a`,
      turn_id: turn.turn_id,
      seq: 0,
      approval_id: 'apr_1',
      action: 'run_command',
      title: 'Run the deploy script',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ev = (seq: number, body: Record<string, unknown>) => ({
      event_id: `evt_${turn.turn_id}_${seq}`,
      turn_id: turn.turn_id,
      seq,
      ...body,
    });
    for (const frame of [
      ev(1, { type: 'text.start', message_id: 'm' }),
      ev(2, { type: 'text.delta', message_id: 'm', delta: 'Not approved, so I stopped.' }),
      ev(3, { type: 'text.end', message_id: 'm' }),
      ev(4, { type: 'done', status: 'completed' }),
    ]) {
      if (ctx.signal.aborted) return;
      ctx.send(frame);
    }
  };

  it("auto-denies approvals in a member's session; the member sees nothing to approve", async () => {
    const g = await gateway({ threads: {} });
    const { ravi, server, agentId } = await team(g, {
      features: [SCOPED_SESSIONS_FEATURE],
      script: askingScript,
    });
    await send(g, ravi, agentId, 'Deploy please');
    await waitFor(() => server.socket.received.some((r) => r.message.type === 'approval.decision'));
    expect(
      server.socket.received.find((r) => r.message.type === 'approval.decision')?.message,
    ).toMatchObject({ approval_id: 'apr_1', decision: 'deny' });
    await waitFor(async () =>
      (await messages(g, ravi, agentId)).some((m) => m.kind === 'agent_text'),
    );
    expect((await messages(g, ravi, agentId)).some((m) => m.kind === 'approval')).toBe(false);
  });

  it("still shows the owner's own approvals", async () => {
    const g = await gateway({ threads: {} });
    const { admin, agentId } = await team(g, {
      features: [SCOPED_SESSIONS_FEATURE],
      script: askingScript,
    });
    await send(g, admin, agentId, 'Deploy please');
    await waitFor(async () =>
      (await messages(g, admin, agentId)).some((m) => m.kind === 'approval'),
    );
  });
});

describe('hosted Twring', () => {
  it('opens channels exactly as before (no session_scope key)', async () => {
    const g = await gateway({ selfhost: false });
    const { connectorId, connector } = await g.connect('alice', {
      features: [SCOPED_SESSIONS_FEATURE],
    });
    sockets.push(connector);
    const agentId = await addAgent(g, 'alice', connectorId);
    await connectedCall(g, connector, 'alice', agentId);
    expect(Object.keys(connector.rawOpens[0]!).sort()).toEqual(['agent', 'channel', 'type']);
  });
});

describe("agent-run commands from a member's session", () => {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const inviteSchema = z.object({ invite_id: z.string() });

  // A self-hosted server has no push registration route (phones register with the relay), so
  // the test harness's ring phone is stored directly.
  async function ringPhone(g: ConnectorGateway, user: string, token: string) {
    await g.ring!.stores.devices.upsert({
      user_id: user,
      device_id: `phone-${user.slice(0, 8)}`,
      fcm_token: token,
      platform: 'android',
      app_variant: 'beta',
      updated_at: new Date().toISOString(),
    });
  }

  async function setup() {
    const g = await gateway({ threads: {}, ring: {} });
    const t = await team(g);
    await ringPhone(g, t.admin, 'fcm-admin-aaaaaaaaaaaaaaaaaa');
    await ringPhone(g, t.ravi, 'fcm-ravi-aaaaaaaaaaaaaaaaaaa');
    await hangUp(g, t.ravi, await connectedCall(g, t.server.socket, t.ravi, t.agentId));
    const scope = t.server.socket.opened.at(-1)!.session_scope!;
    return { g, ...t, scope };
  }

  it('a ring reaches the member only; answering opens their own session; the owner cannot answer', async () => {
    const { g, admin, ravi, server, scope } = await setup();
    const rung = await g.send('POST', '/v1/connectors/ring', {
      headers: bearer(server.token),
      body: {
        local_agent: 'claude-code',
        reason: 'Your report is ready.',
        session_ref: 'sess_ravi',
        session_scope: scope,
      },
    });
    expect(rung.statusCode).toBe(201);
    const { invite_id: inviteId } = inviteSchema.parse(rung.json());
    expect(g.ring!.pushes.map((p) => p.token)).toEqual(['fcm-ravi-aaaaaaaaaaaaaaaaaaa']);
    const status = await g.send('GET', `/v1/connectors/ring/${inviteId}?session_scope=${scope}`, {
      headers: bearer(server.token),
    });
    expect(status.statusCode).toBe(200);
    const byOwner = await g.send('POST', `/v1/invites/${inviteId}/answer`, { user: admin });
    expect(byOwner.statusCode).toBe(404);
    const answered = await g.send('POST', `/v1/invites/${inviteId}/answer`, { user: ravi });
    expect(answered.statusCode).toBe(201);
    await waitFor(() => server.socket.opened.at(-1)?.resume_ref === 'sess_ravi');
    expect(server.socket.opened.at(-1)?.session_scope).toBe(scope);
  });

  it("an agent-run message reaches the member's chat only", async () => {
    const { g, admin, ravi, server, scope } = await setup();
    const res = await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(server.token), 'idempotency-key': randomUUID() },
      body: { local_agent: 'claude-code', text: 'FYI', origin: 'agent', session_scope: scope },
    });
    expect(res.statusCode).toBe(201);
    expect((await g.threads!.store.listThreads(ravi)).length).toBe(1);
    expect(await g.threads!.store.listThreads(admin)).toEqual([]);
  });

  it("refuses an unscoped ring or message carrying a member's session", async () => {
    const { g, admin, server, scope } = await setup();
    await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(server.token), 'idempotency-key': randomUUID() },
      body: {
        local_agent: 'claude-code',
        text: 'Done.',
        origin: 'call_turn',
        session_ref: 'sess_ravi',
        session_scope: scope,
      },
    });
    const ring = await g.send('POST', '/v1/connectors/ring', {
      headers: bearer(server.token),
      body: { local_agent: 'claude-code', reason: 'Look at this.', session_ref: 'sess_ravi' },
    });
    expect(ring.statusCode).toBe(400);
    const message = await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(server.token), 'idempotency-key': randomUUID() },
      body: {
        local_agent: 'claude-code',
        text: 'x',
        origin: 'call_turn',
        session_ref: 'sess_ravi',
      },
    });
    expect(message.statusCode).toBe(400);
    expect(g.ring!.pushes.some((p) => p.token === 'fcm-admin-aaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(await g.threads!.store.listThreads(admin)).toEqual([]);
    // The owner's own unscoped ring is unchanged.
    const own = await g.send('POST', '/v1/connectors/ring', {
      headers: bearer(server.token),
      body: { local_agent: 'claude-code', reason: 'Owner news.', session_ref: 'sess_owner' },
    });
    expect(own.statusCode).toBe(201);
  });

  it("refuses a scoped ring naming another member's known session", async () => {
    const { g, meera, server, scope, agentId } = await setup();
    await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(server.token), 'idempotency-key': randomUUID() },
      body: {
        local_agent: 'claude-code',
        text: 'Done.',
        origin: 'call_turn',
        session_ref: 'sess_ravi',
        session_scope: scope,
      },
    });
    await hangUp(g, meera, await connectedCall(g, server.socket, meera, agentId));
    const meeraScope = server.socket.opened.at(-1)!.session_scope!;
    const ring = await g.send('POST', '/v1/connectors/ring', {
      headers: bearer(server.token),
      body: {
        local_agent: 'claude-code',
        reason: 'Look.',
        session_ref: 'sess_ravi',
        session_scope: meeraScope,
      },
    });
    expect(ring.statusCode).toBe(400);
  });

  it("words from a member's session go to the member's own list", async () => {
    const { g, admin, ravi, server, scope, agentId } = await setup();
    const res = await g.send('POST', '/v1/connectors/words', {
      headers: bearer(server.token),
      body: { local_agent: 'claude-code', words: ['Lightsail'], session_scope: scope },
    });
    expect(res.statusCode).toBe(200);
    const record = (await g.stores.agents.get(admin, agentId))!;
    expect(record.keyterms ?? []).not.toContain('Lightsail');
    expect(personWords(record, ravi)).toEqual(['Lightsail']);
    const forged = await g.send('POST', '/v1/connectors/words', {
      headers: bearer(server.token),
      body: { local_agent: 'claude-code', words: ['X'], session_scope: 'f'.repeat(32) },
    });
    expect(forged.statusCode).toBe(400);
  });

  it("refuses a peer's scope sent from another member's own computer", async () => {
    const { g, meera, scope } = await setup();
    const laptop = await link(g, meera, { features: [SCOPED_SESSIONS_FEATURE] });
    await addAgent(g, meera, laptop.connectorId);
    const res = await g.send('POST', '/v1/connectors/messages', {
      headers: { ...bearer(laptop.token), 'idempotency-key': randomUUID() },
      body: { local_agent: 'claude-code', text: 'x', origin: 'agent', session_scope: scope },
    });
    expect(res.statusCode).toBe(400);
  });
});
