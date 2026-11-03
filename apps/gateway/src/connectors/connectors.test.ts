import { isAdapterError } from '@twring/agent-adapter';
import {
  agentListResponseSchema,
  claimResponseSchema,
  connectionTestResponseSchema,
  connectorEndpointUrl,
  connectorListResponseSchema,
  deleteMyDataResponseSchema,
  errorResponseSchema,
  pairingResponseSchema,
  pairingStatusResponseSchema,
  RELAY_CLOSE,
  type AgentEvent,
  type UserTurn,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { savedAgentFactory, targetAgentFactory } from '../agents/service';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { OfflineSocket } from './hub';
import { PairingBook, PAIRING_TTL_MS } from './pairing';
import { FAKE_AGENTS, startFakeConnector, type FakeConnectorScript } from './testing';

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(options: Parameters<typeof startConnectorGateway>[0] = {}) {
  const g = await startConnectorGateway(options);
  gateways.push(g);
  return g;
}

const turn = (turnId: string, text = 'What is on my screen?'): UserTurn => ({
  callId: 'call_1',
  sessionId: 'sess_1',
  turnId,
  role: 'user',
  text,
  startedAt: new Date().toISOString(),
  committedAt: new Date().toISOString(),
});

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function relayAdapter(
  g: ConnectorGateway,
  user: string,
  connectorId: string,
  agent = 'claude-code',
) {
  return targetAgentFactory(
    { protocol: 'cord-connector', url: connectorEndpointUrl(connectorId, agent), userId: user },
    { env: 'development', connectors: g.hub },
  )('call_1');
}

/** Opens a raw socket; resolves the HTTP status it was refused with, or 101 when upgraded. */
function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => undefined);
  });
}

describe('pairing', () => {
  it('keeps a reset pending offline, consumes it once on concurrent opens, and hides it from the API', async () => {
    const g = await gateway({ threads: {} });
    const { connectorId, token } = await g.pair('alice');
    const agentId = await g.createAgent('alice', connectorId);
    const path = `/v1/agents/${agentId}/new-conversation`;
    expect((await g.send('POST', path)).statusCode).toBe(401);
    expect((await g.send('POST', path, { user: 'bob' })).statusCode).toBe(404);
    expect(
      (
        await g.send('POST', '/v1/agents/agt_abcdefghij0123456789/new-conversation', {
          user: 'alice',
        })
      ).statusCode,
    ).toBe(404);
    const requested = await g.send('POST', path, { user: 'alice' });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toEqual({ ok: true });
    expect((await g.stores.agents.get('alice', agentId))?.fresh_session_pending).toBe(true);
    expect((await g.send('GET', `/v1/agents/${agentId}`, { user: 'alice' })).body).not.toContain(
      'fresh_session_pending',
    );
    expect((await g.send('GET', '/v1/agents', { user: 'alice' })).body).not.toContain(
      'fresh_session_pending',
    );
    expect(
      (await g.threads?.store.listMessages('alice', agentId, { limit: 20 }))?.messages,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'notice', code: 'new_session' })]),
    );
    const record = (await g.stores.agents.get('alice', agentId))!;
    const policy = { env: 'development' as const, connectors: g.hub };
    const make = (resumeRef?: string) =>
      savedAgentFactory('alice', record, g.stores, policy, resumeRef)('call_1');
    const offline = await make();
    await expect(
      offline.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000)),
    ).rejects.toMatchObject({ code: 'agent_offline' });
    expect((await g.stores.agents.get('alice', agentId))?.fresh_session_pending).toBe(true);
    const connector = startFakeConnector({ url: g.socketUrl, token });
    await connector.ready;
    const [first, second] = await Promise.all([make(), make()]);
    await Promise.all([
      first.connect({ callId: 'c1', sessionId: 's1' }, AbortSignal.timeout(2000)),
      second.connect({ callId: 'c2', sessionId: 's2' }, AbortSignal.timeout(2000)),
    ]);
    expect(connector.opened.filter((open) => open.fresh_session)).toHaveLength(1);
    expect(connector.opened.find((open) => open.fresh_session)?.resume_ref).toBeUndefined();
    const third = await make();
    await third.connect({ callId: 'c3', sessionId: 's3' }, AbortSignal.timeout(2000));
    expect(connector.opened[2]).not.toHaveProperty('fresh_session');
    expect((await g.stores.agents.get('alice', agentId))?.fresh_session_pending).toBeUndefined();
    expect((await g.send('POST', path, { user: 'alice' })).statusCode).toBe(200);
    const ring = await make('old_ring_ref');
    await ring.connect({ callId: 'c4', sessionId: 's4' }, AbortSignal.timeout(2000));
    expect(connector.opened[3]).toMatchObject({ fresh_session: true });
    expect(connector.opened[3]).not.toHaveProperty('resume_ref');
    await Promise.all([
      first.close(),
      second.close(),
      third.close(),
      ring.close(),
      offline.close(),
    ]);
    connector.terminate();
  });
  it('pairs once with a code, stores only a token hash, and reports the claim to the app', async () => {
    const g = await gateway();
    const created = await g.send('POST', '/v1/connectors/pairings', { user: 'alice' });
    expect(created.statusCode).toBe(201);
    const pairing = pairingResponseSchema.parse(created.json());
    expect(pairing.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);

    const pending = await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, {
      user: 'alice',
    });
    expect(pairingStatusResponseSchema.parse(pending.json()).status).toBe('pending');

    // Entry is forgiving: lower case, no dash.
    const claim = await g.send('POST', '/v1/connectors/claim', {
      body: {
        code: pairing.code.replace('-', '').toLowerCase(),
        name: 'Work laptop',
        agents: FAKE_AGENTS,
      },
    });
    expect(claim.statusCode).toBe(201);
    const { token, connector_id: connectorId } = claimResponseSchema.parse(claim.json());
    expect(token).toMatch(/^cct_/);

    const claimed = pairingStatusResponseSchema.parse(
      (
        await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, { user: 'alice' })
      ).json(),
    );
    expect(claimed.status).toBe('claimed');
    expect(claimed.connector).toMatchObject({
      id: connectorId,
      name: 'Work laptop',
      online: false,
    });
    expect(claimed.connector?.agents.map((a) => a.id)).toEqual(['claude-code', 'gemini']);

    const rows = await g.stores.connectors.list('alice');
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const again = await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Another', agents: FAKE_AGENTS },
    });
    expect(again.statusCode).toBe(400);
    expect(errorResponseSchema.parse(again.json()).error.code).toBe('pairing_invalid');
  });

  it('refuses an expired code and reports the pairing as expired', async () => {
    let now = 1_000_000;
    const g = await gateway({ pairings: new PairingBook(() => now) });
    const pairing = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: 'alice' })).json(),
    );
    now += PAIRING_TTL_MS + 1;
    const status = await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, {
      user: 'alice',
    });
    expect(pairingStatusResponseSchema.parse(status.json()).status).toBe('expired');
    const claim = await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(errorResponseSchema.parse(claim.json()).error.code).toBe('pairing_invalid');
  });

  it("does not show one user's pairing to another", async () => {
    const g = await gateway();
    const pairing = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: 'alice' })).json(),
    );
    const res = await g.send('GET', `/v1/connectors/pairings/${pairing.pairing_id}`, {
      user: 'bob',
    });
    expect(res.statusCode).toBe(404);
  });

  it('rate limits claims per IP, bad codes included', async () => {
    const g = await gateway({ claimRatePerMinute: 3 });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await g.send('POST', '/v1/connectors/claim', {
        body: { code: 'AAAA-BBBB', name: 'Laptop', agents: FAKE_AGENTS },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([400, 400, 400, 429]);
    const elsewhere = await g.send('POST', '/v1/connectors/claim', {
      ip: '198.51.100.7',
      body: { code: 'AAAA-BBBB', name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(elsewhere.statusCode).toBe(400);
  });

  it('claim needs no sign-in, but every other connector route does', async () => {
    const g = await gateway();
    expect((await g.send('POST', '/v1/connectors/pairings')).statusCode).toBe(401);
    expect((await g.send('GET', '/v1/connectors')).statusCode).toBe(401);
    const claim = await g.send('POST', '/v1/connectors/claim', {
      body: { code: 'AAAA-BBBB', name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(claim.statusCode).toBe(400);
  });

  it('refuses a claim with a malformed agent list', async () => {
    const g = await gateway();
    const pairing = pairingResponseSchema.parse(
      (await g.send('POST', '/v1/connectors/pairings', { user: 'alice' })).json(),
    );
    const res = await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Laptop', agents: [{ id: 'Bad Id', label: 'x' }] },
    });
    expect(res.statusCode).toBe(400);
    // The code survives a malformed body: it was never taken.
    const ok = await g.send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Laptop', agents: FAKE_AGENTS },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('relay socket', () => {
  it('refuses an upgrade without a valid connector token', async () => {
    const g = await gateway();
    expect(await upgradeStatus(g.socketUrl, {})).toBe(401);
    expect(
      await upgradeStatus(g.socketUrl, { Authorization: `Bearer cct_${'A'.repeat(43)}` }),
    ).toBe(401);
    expect(await upgradeStatus(g.socketUrl, { Authorization: 'Bearer not-a-token' })).toBe(401);
    const { token } = await g.pair('alice');
    expect(await upgradeStatus(g.socketUrl, { Authorization: `Bearer ${token}` })).toBe(101);
  });

  it('closes a socket whose first frame is not a hello', async () => {
    const g = await gateway();
    const { token } = await g.pair('alice');
    const ws = new WebSocket(g.socketUrl, { headers: { Authorization: `Bearer ${token}` } });
    const code = await new Promise<number>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'channel.close', channel: 'ch_x' })));
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(RELAY_CLOSE.protocolError);
  });

  it('rate limits socket upgrades per IP', async () => {
    const g = await gateway({ socketRatePerMinute: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push(await upgradeStatus(g.socketUrl, {}));
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('keeps one socket per connector: a new one replaces the old', async () => {
    const g = await gateway();
    const { token, connector } = await g.connect('alice');
    const second = startFakeConnector({ url: g.socketUrl, token });
    await second.ready;
    expect(await connector.closed).toBe(RELAY_CLOSE.replaced);
    second.terminate();
  });

  it('marks the connector online and lists the agents it offers', async () => {
    const g = await gateway();
    const { connectorId } = await g.connect('alice');
    const list = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'alice' })).json(),
    );
    expect(list.connectors).toEqual([
      expect.objectContaining({
        id: connectorId,
        online: true,
        last_seen_at: expect.any(String) as unknown,
      }),
    ]);
    const bobs = connectorListResponseSchema.parse(
      (await g.send('GET', '/v1/connectors', { user: 'bob' })).json(),
    );
    expect(bobs.connectors).toEqual([]);
  });
});

describe('cord-connector agents', () => {
  it('reports agent_offline when the computer is not connected', async () => {
    const g = await gateway();
    const { connectorId } = await g.pair('alice');
    const agentId = await g.createAgent('alice', connectorId);
    const agents = agentListResponseSchema.parse(
      (await g.send('GET', '/v1/agents', { user: 'alice' })).json(),
    );
    expect(agents.agents[0]).toMatchObject({ protocol: 'cord-connector', connector_online: false });

    const adapter = await relayAdapter(g, 'alice', connectorId);
    const error = await errorOf(
      adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000)),
    );
    expect(isAdapterError(error) && error.code).toBe('agent_offline');

    const test = connectionTestResponseSchema.parse(
      (await g.send('POST', `/v1/agents/${agentId}/test`, { user: 'alice' })).json(),
    );
    expect(test.result.ok).toBe(false);
    expect(test.result.message).toContain("isn't connected");
  });

  it('routes a turn end to end through the connector, and the connection test passes', async () => {
    const g = await gateway();
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);

    const adapter = await relayAdapter(g, 'alice', connectorId);
    await adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000));
    expect(adapter.capabilities.cancellation).toBe(true);
    const events = await collect(adapter.sendTurn(turn('t_1'), AbortSignal.timeout(2000)));
    const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.delta] : [])).join('');
    expect(text).toBe('Hello from your computer.');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(connector.opened[0]?.agent).toBe('claude-code');
    expect(
      connector.received.filter((r) => r.message.type === 'user.turn').map((r) => r.message),
    ).toEqual([expect.objectContaining({ turn_id: 't_1', text: 'What is on my screen?' })]);
    await adapter.close();
    await waitFor(() => connector.closedByGateway.length === 1);

    const test = connectionTestResponseSchema.parse(
      (await g.send('POST', `/v1/agents/${agentId}/test`, { user: 'alice' })).json(),
    );
    expect(test.result.ok).toBe(true);
    expect(test.agent).toMatchObject({ status: 'ready', connector_online: true });
  });

  it('passes a barge-in on as turn.cancel', async () => {
    const g = await gateway();
    const streamUntilCancelled: FakeConnectorScript = async (t, ctx) => {
      ctx.send({ type: 'run.started', event_id: 'e0', turn_id: t.turn_id, seq: 0 });
      ctx.send({ type: 'text.start', event_id: 'e1', turn_id: t.turn_id, seq: 1, message_id: 'm' });
      for (let n = 2; !ctx.signal.aborted && n < 400; n += 1) {
        ctx.send({
          type: 'text.delta',
          event_id: `e${n}`,
          turn_id: t.turn_id,
          seq: n,
          message_id: 'm',
          delta: 'word ',
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const { connectorId, connector } = await g.connect('alice', { script: streamUntilCancelled });
    const adapter = await relayAdapter(g, 'alice', connectorId);
    await adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000));
    const controller = new AbortController();
    for await (const event of adapter.sendTurn(turn('t_barge'), controller.signal)) {
      if (event.type === 'text.delta') controller.abort(new Error('barge_in'));
    }
    await waitFor(() => connector.received.some((r) => r.message.type === 'turn.cancel'));
    expect(connector.received.find((r) => r.message.type === 'turn.cancel')?.message).toEqual({
      type: 'turn.cancel',
      turn_id: 't_barge',
      reason: 'barge_in',
    });
    await adapter.close();
  });

  it('fails a turn when the computer drops mid-turn, and never resends it', async () => {
    const g = await gateway();
    const drop: { now?: () => void } = {};
    const dropMidTurn: FakeConnectorScript = async (t, ctx) => {
      ctx.send({ type: 'run.started', event_id: 'e0', turn_id: t.turn_id, seq: 0 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      drop.now?.();
    };
    const { connectorId, connector } = await g.connect('alice', { script: dropMidTurn });
    drop.now = () => connector.terminate();
    const adapter = await relayAdapter(g, 'alice', connectorId);
    await adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000));
    const error = await errorOf(
      collect(adapter.sendTurn(turn('t_drop'), AbortSignal.timeout(2000))),
    );
    expect(isAdapterError(error) && error.code).toBe('connection_lost');
    expect(connector.received.filter((r) => r.message.type === 'user.turn')).toHaveLength(1);
    // The next turn does not replay the lost one: the computer is gone, so it says so.
    const next = await errorOf(
      collect(adapter.sendTurn(turn('t_next'), AbortSignal.timeout(2000))),
    );
    expect(isAdapterError(next) && next.code).toBe('agent_offline');
    await adapter.close();
  });

  it('revoking a computer closes its socket and its token stops working', async () => {
    const g = await gateway();
    const { connectorId, token, connector } = await g.connect('alice');
    const res = await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'alice' });
    expect(res.statusCode).toBe(204);
    expect(await connector.closed).toBe(RELAY_CLOSE.revoked);
    expect(await upgradeStatus(g.socketUrl, { Authorization: `Bearer ${token}` })).toBe(401);
  });

  it("never lets one user reach another user's computer", async () => {
    const g = await gateway();
    const { connectorId, connector } = await g.connect('alice');

    const saved = await g.send('POST', '/v1/agents', {
      user: 'bob',
      body: {
        name: 'Not mine',
        protocol: 'cord-connector',
        endpoint_url: connectorEndpointUrl(connectorId, 'claude-code'),
      },
    });
    expect(saved.statusCode).toBe(400);

    expect(g.hub.socketFor('bob', connectorId, 'claude-code')).toBeInstanceOf(OfflineSocket);
    const adapter = await relayAdapter(g, 'bob', connectorId);
    const error = await errorOf(
      adapter.connect({ callId: 'c', sessionId: 's' }, AbortSignal.timeout(2000)),
    );
    expect(isAdapterError(error) && error.code).toBe('agent_offline');
    expect(connector.opened).toEqual([]);

    expect(
      (await g.send('DELETE', `/v1/connectors/${connectorId}`, { user: 'bob' })).statusCode,
    ).toBe(404);
    expect(g.hub.isOnline('alice', connectorId)).toBe(true);
  });

  it('refuses an agent the computer does not offer, and an API key', async () => {
    const g = await gateway();
    const { connectorId } = await g.pair('alice');
    const unknown = await g.send('POST', '/v1/agents', {
      user: 'alice',
      body: {
        name: 'Nope',
        protocol: 'cord-connector',
        endpoint_url: connectorEndpointUrl(connectorId, 'codex'),
      },
    });
    expect(unknown.statusCode).toBe(400);
    const keyed = await g.send('POST', '/v1/agents', {
      user: 'alice',
      body: {
        name: 'Nope',
        protocol: 'cord-connector',
        endpoint_url: connectorEndpointUrl(connectorId, 'claude-code'),
        credential: 'sk-x',
      },
    });
    expect(keyed.statusCode).toBe(400);
  });

  it('deleting my data revokes my computers and closes their sockets', async () => {
    const g = await gateway();
    const { connector, token } = await g.connect('alice');
    await g.connect('bob');
    const res = await g.send('DELETE', '/v1/me/data', { user: 'alice' });
    const body = deleteMyDataResponseSchema.parse(res.json());
    expect(body.deleted.connectors).toBe(1);
    expect(await connector.closed).toBe(RELAY_CLOSE.revoked);
    expect(await upgradeStatus(g.socketUrl, { Authorization: `Bearer ${token}` })).toBe(401);
    expect(await g.stores.connectors.list('bob')).toHaveLength(1);
  });
});
