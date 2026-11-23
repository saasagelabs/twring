import { createCallResponseSchema, errorResponseSchema } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ManualScheduler, recordingLogger } from '../calls/testing';

import { startConnectorGateway, type ConnectorGateway } from './harness';
import { startFakeConnector, type FakeConnector } from './testing';

/**
 * The reconnect grace: after a gateway restart or a network blip, computers dial back in on the
 * connector's backoff (1, 2, 4, 8 s). Calls and turns wait briefly for them instead of failing.
 */

const GRACE = { windowMs: 30_000, waitMs: 8_000 };

const gateways: ConnectorGateway[] = [];
const extra: FakeConnector[] = [];
afterEach(async () => {
  for (const connector of extra.splice(0)) connector.terminate();
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway(scheduler: ManualScheduler, logger = recordingLogger()) {
  const g = await startConnectorGateway({
    calls: { allowance: { callSeconds: 0, calls: 5 } },
    reconnectGrace: GRACE,
    hubScheduler: scheduler,
    hubLogger: logger,
  });
  gateways.push(g);
  return g;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startCall = (g: ConnectorGateway, agentId: string) =>
  g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: agentId } });

function reconnect(g: ConnectorGateway, token: string): FakeConnector {
  const connector = startFakeConnector({ url: g.socketUrl, token });
  extra.push(connector);
  return connector;
}

const turns = (connector: FakeConnector) =>
  connector.received.filter((r) => r.message.type === 'user.turn');

describe('reconnect grace', () => {
  it('a mid-call turn after a server-side drop waits for the computer and is answered', async () => {
    const scheduler = new ManualScheduler();
    scheduler.advance(GRACE.windowMs + 1); // Past the boot window: only the drop counts.
    const logger = recordingLogger();
    const g = await gateway(scheduler, logger);
    const { connectorId, token } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    expect((await startCall(g, agentId)).statusCode).toBe(201);
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });

    g.hub.closeAll(); // 1001, like a gateway shutdown or proxy reload.
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    await sleep(500);
    g.calls!.stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello' });
    g.calls!.scheduler.advance(2_000); // Past the short-turn hold: the turn is committed.
    await sleep(1_500);
    const back = reconnect(g, token);
    await back.ready;

    await waitFor(() => turns(back).length === 1);
    await sleep(50);
    expect(transport.endReasons).not.toContain('agent_offline');
    expect(logger.events.find((e) => e.fields.event === 'connector_wait')?.fields).toMatchObject({
      ok: true,
    });
  }, 10_000);

  it('a call right after the gateway starts connects when the computer says hello', async () => {
    const scheduler = new ManualScheduler(); // The server just started.
    const g = await gateway(scheduler);
    const { connectorId, token } = await g.pair('alice');
    const agentId = await g.createAgent('alice', connectorId);
    scheduler.advance(1_000);
    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(201);
    const transport = g.calls!.transports[0]!;
    await sleep(200);
    expect(transport.states).not.toContain('ready');
    const back = reconnect(g, token);
    await back.ready;
    await waitFor(() => transport.states.includes('ready'));
    expect(transport.endReasons).toEqual([]);
  });

  it('a computer offline for 5 minutes still fails at once', async () => {
    const scheduler = new ManualScheduler();
    const g = await gateway(scheduler);
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    connector.terminate();
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    scheduler.advance(5 * 60_000);
    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(409);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('agent_offline');
    expect(scheduler.pending).toBe(0);
  });

  it('hanging up during the wait ends it at once, leaving no timer or listener', async () => {
    const scheduler = new ManualScheduler();
    scheduler.advance(GRACE.windowMs + 1);
    const logger = recordingLogger();
    const g = await gateway(scheduler, logger);
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    connector.terminate();
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    const created = createCallResponseSchema.parse((await startCall(g, agentId)).json());
    await waitFor(() => scheduler.pending === 1);

    const startedAt = Date.now();
    await g.send('POST', `/v1/calls/${created.call_id}/end`, { user: 'alice' });
    await waitFor(() => scheduler.pending === 0);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await waitFor(() =>
      logger.events.some((e) => e.fields.event === 'connector_wait' && e.fields.ok === false),
    );
    expect(g.calls!.registry.get(created.call_id)?.status).toMatch(/ended|failed/);
  });

  it('when the grace runs out the call ends agent_offline', async () => {
    const scheduler = new ManualScheduler();
    scheduler.advance(GRACE.windowMs + 1);
    const g = await gateway(scheduler);
    const { connectorId, connector } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    connector.terminate();
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    expect((await startCall(g, agentId)).statusCode).toBe(201);
    const transport = g.calls!.transports[0]!;
    await waitFor(() => scheduler.pending === 1);
    scheduler.advance(GRACE.waitMs);
    await waitFor(() => transport.endReasons.includes('agent_offline'));
    expect(scheduler.pending).toBe(0);
  });
});

describe('reconnect grace: allowance, users and leaks', () => {
  it('a call whose computer never returns gives its daily call back', async () => {
    const scheduler = new ManualScheduler();
    scheduler.advance(GRACE.windowMs + 1);
    const g = await startConnectorGateway({
      calls: { allowance: { callSeconds: 0, calls: 1 } },
      reconnectGrace: GRACE,
      hubScheduler: scheduler,
    });
    gateways.push(g);
    const { connectorId, connector, token } = await g.connect('alice');
    const agentId = await g.createAgent('alice', connectorId);
    connector.terminate();
    await waitFor(() => !g.hub.isOnline('alice', connectorId));
    const first = createCallResponseSchema.parse((await startCall(g, agentId)).json());
    const transport = g.calls!.transports[0]!;
    await waitFor(() => scheduler.pending === 1);
    scheduler.advance(GRACE.waitMs);
    await waitFor(() => transport.endReasons.includes('agent_offline'));
    await waitFor(() => {
      g.calls!.scheduler.advance(1_000);
      return /ended|failed/.test(g.calls!.registry.get(first.call_id)?.status ?? '');
    });
    const back = reconnect(g, token);
    await back.ready;
    await sleep(50);
    const again = await startCall(g, agentId);
    expect(again.statusCode).toBe(201);
  });

  it("another user's call to a paired computer id is refused, even in the boot window", async () => {
    const scheduler = new ManualScheduler();
    const g = await gateway(scheduler);
    const { connectorId } = await g.pair('alice');
    expect(g.hub.reconnecting(connectorId)).toBe(true);
    const signal = new AbortController().signal;
    const waiting = g.hub.waitForComputer('bob', connectorId, signal);
    scheduler.advance(GRACE.waitMs);
    expect(await waiting).toBe(false);
    expect(scheduler.pending).toBe(0);
  });

  it('many waiters for one computer all end on abort or timeout, leaving nothing behind', async () => {
    const scheduler = new ManualScheduler();
    const g = await gateway(scheduler);
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const waits = controllers.map((c) => g.hub.waitForComputer('alice', 'cn_x', c.signal));
    expect(scheduler.pending).toBe(20);
    for (const c of controllers.slice(0, 10)) c.abort(new Error('hang up'));
    scheduler.advance(GRACE.waitMs);
    expect(await Promise.all(waits)).toEqual(Array.from({ length: 20 }, () => false));
    expect(scheduler.pending).toBe(0);
    const waiters = (g.hub as unknown as { helloWaiters: Map<string, unknown> }).helloWaiters;
    expect(waiters.size).toBe(0);
  });

  it('a computer that never connected fails at once after the boot window', async () => {
    const scheduler = new ManualScheduler();
    const g = await gateway(scheduler);
    const { connectorId } = await g.pair('alice');
    const agentId = await g.createAgent('alice', connectorId);
    scheduler.advance(GRACE.windowMs);
    const res = await startCall(g, agentId);
    expect(res.statusCode).toBe(409);
    expect(scheduler.pending).toBe(0);
  });
});
