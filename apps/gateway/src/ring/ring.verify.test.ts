import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  errorResponseSchema,
  ringResponseSchema,
  ringStatusResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { ManualScheduler, recordingLogger } from '../calls/testing';
import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';
import { MemoryCollection } from '../store/collection';

import { RingService } from './service';
import {
  DeviceRepository,
  InviteRepository,
  inviteRecordSchema,
  RingSettingsRepository,
  type InviteRecord,
} from './store';

/** Verifier edge cases for rings (ADR-024): races, long-polls, and refusals on answer. */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const code = (res: { json(): unknown }) => errorResponseSchema.parse(res.json()).error.code;

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function callingGateway(allowance = { callSeconds: 0, calls: 5 }) {
  const g = await startConnectorGateway({ ring: {}, calls: { allowance } });
  gateways.push(g);
  const paired = await g.connect('alice');
  const agentId = await g.createAgent('alice', paired.connectorId);
  return { g, ...paired, agentId };
}

async function ringOk(g: ConnectorGateway, token: string, extra: Record<string, unknown> = {}) {
  const res = await g.send('POST', '/v1/connectors/ring', {
    headers: bearer(token),
    body: { local_agent: 'claude-code', reason: 'The build failed', ...extra },
  });
  expect(res.statusCode).toBe(201);
  return ringResponseSchema.parse(res.json());
}

/** A ring service on a manual clock with in-memory stores, for races the HTTP layer can't time. */
function bareService() {
  const scheduler = new ManualScheduler();
  const clock = { ms: Date.parse('2026-10-01T09:00:00.000Z') };
  const stores = {
    devices: new DeviceRepository(new MemoryCollection()),
    settings: new RingSettingsRepository(new MemoryCollection()),
    invites: new InviteRepository(new MemoryCollection()),
  };
  const service = new RingService({
    stores,
    inCall: () => false,
    scheduler,
    now: () => new Date(clock.ms),
    logger: recordingLogger(),
  });
  const ring = async () => {
    const result = await service.ring({
      userId: 'alice',
      connectorId: `con_${'a'.repeat(20)}`,
      localAgent: 'claude-code',
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Laptop Claude',
      reason: 'The build failed',
    });
    if (!('invite' in result)) throw new Error(`refused: ${result.refused}`);
    return result.invite.id;
  };
  return { service, scheduler, clock, stores, ring };
}

describe('session refs', () => {
  it('a ring whose session_ref looks like a command-line flag is refused (400)', async () => {
    const { g, token } = await callingGateway();
    for (const ref of ['--dangerously-skip-permissions', '-c', '--last']) {
      const res = await g.send('POST', '/v1/connectors/ring', {
        headers: bearer(token),
        body: { local_agent: 'claude-code', reason: 'x', session_ref: ref },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('stored session refs', () => {
  it('a flag-shaped ref stored before the rule still loads, and is never sent to the computer', async () => {
    expect(
      inviteRecordSchema.safeParse({
        id: `inv_${'a'.repeat(26)}`,
        user_id: 'alice',
        connector_id: `con_${'a'.repeat(20)}`,
        local_agent: 'claude-code',
        agent_id: `agt_${'a'.repeat(20)}`,
        agent_name: 'Laptop Claude',
        reason: 'x',
        session_ref: '--dangerously-skip-permissions',
        status: 'missed',
        created_at: '2026-10-01T09:00:00.000Z',
        expires_at: '2026-10-01T09:00:30.000Z',
      }).success,
    ).toBe(true);

    const rows = new MemoryCollection<InviteRecord>();
    const g = await startConnectorGateway({ ring: { invites: rows }, calls: {} });
    gateways.push(g);
    const { token, connectorId, connector } = await g.connect('alice');
    await g.createAgent('alice', connectorId);
    const { invite_id: id } = await ringOk(g, token, { session_ref: 'sess-1' });
    await rows.update((items) => ({
      items: items.map((row) => ({ ...row, session_ref: '--dangerously-skip-permissions' })),
      result: undefined,
    }));
    expect((await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' })).statusCode).toBe(
      201,
    );
    const transport = g.calls!.transports[0]!;
    await waitFor(() => transport.states.includes('ready'));
    transport.emit({ type: 'caller_joined' });
    await waitFor(() => connector.opened.length > 0);
    expect(connector.opened[0]!.resume_ref).toBeUndefined();
  });
});

describe('answer refused by the ordinary call rules', () => {
  it('daily limit: the answer is refused and the ring ends declined with the reason', async () => {
    const { g, token, agentId } = await callingGateway({ callSeconds: 0, calls: 1 });
    // Today's only call is used up.
    const call = await g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: agentId } });
    expect(call.statusCode).toBe(201);
    await g.calls!.registry.endCallsForUser('alice');
    await waitFor(() => !g.calls!.registry.hasLiveCall('alice'));

    const { invite_id: id } = await ringOk(g, token);
    const answer = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(answer.statusCode).toBe(429);
    expect(code(answer)).toBe('daily_limit_reached');
    expect(
      (await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) })).json(),
    ).toEqual({ status: 'declined', note: "Couldn't connect: daily calling used" });
  });

  it('owner on another call: the answer is 409 call_in_progress and the ring ends declined', async () => {
    const { g, token, agentId } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    const call = await g.send('POST', '/v1/calls', { user: 'alice', body: { agent_id: agentId } });
    expect(call.statusCode).toBe(201);
    const answer = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(answer.statusCode).toBe(409);
    expect(code(answer)).toBe('call_in_progress');
    expect(
      (await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) })).json(),
    ).toEqual({ status: 'declined', note: "Couldn't connect: already on a call" });
  });

  it('computer offline: the waiting long-poll wakes with the declined reason', async () => {
    const g = await startConnectorGateway({ ring: {}, calls: {} });
    gateways.push(g);
    // Paired but never connected: the computer is offline.
    const { connectorId, token } = await g.pair('alice');
    await g.createAgent('alice', connectorId);
    const { invite_id: id } = await ringOk(g, token);
    const poll = g.send('GET', `/v1/connectors/ring/${id}?wait=25`, { headers: bearer(token) });
    const answer = await g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' });
    expect(answer.statusCode).toBe(409);
    expect((await poll).json()).toEqual({
      status: 'declined',
      note: "Couldn't connect: computer offline",
    });
  });

  it('answer vs decline from a second phone: exactly one wins', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    const [a, d] = await Promise.all([
      g.send('POST', `/v1/invites/${id}/answer`, { user: 'alice' }),
      g.send('POST', `/v1/invites/${id}/decline`, { user: 'alice', body: { note: 'busy' } }),
    ]);
    const final = ringStatusResponseSchema.parse(
      (await g.send('GET', `/v1/connectors/ring/${id}`, { headers: bearer(token) })).json(),
    );
    if (a.statusCode === 201) {
      expect(d.statusCode).toBe(409);
      expect(final.status).toBe('answered');
    } else {
      expect(d.statusCode).toBe(200);
      expect(code(a)).toBe('invite_already_handled');
      expect(final.status).toBe('declined');
      expect(g.calls!.registry.activeCount).toBe(0);
    }
  });
});

describe('a failed push vs an answer in flight', () => {
  it('a ring answered while its push is still failing is not settled unreachable', async () => {
    const scheduler = new ManualScheduler();
    let failPush!: () => void;
    const pushDone = new Promise<void>((resolve) => (failPush = resolve));
    const stores = {
      devices: new DeviceRepository(new MemoryCollection()),
      settings: new RingSettingsRepository(new MemoryCollection()),
      invites: new InviteRepository(new MemoryCollection()),
    };
    await stores.devices.upsert({
      user_id: 'alice',
      device_id: 'phone-0001',
      fcm_token: 'fcm-dead-aaaaaaaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      updated_at: '2026-10-01T09:00:00.000Z',
    });
    const service = new RingService({
      stores,
      push: {
        send: async () => {
          await pushDone;
          return 'failed';
        },
      },
      inCall: () => false,
      scheduler,
      now: () => new Date('2026-10-01T09:00:00.000Z'),
      logger: recordingLogger(),
    });
    const result = await service.ring({
      userId: 'alice',
      connectorId: `con_${'a'.repeat(20)}`,
      localAgent: 'claude-code',
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Laptop Claude',
      reason: 'The build failed',
    });
    if (!('invite' in result)) throw new Error('refused');
    const id = result.invite.id;
    // The app showed the ring from its poll and the person answered.
    const claim = await service.claimAnswer('alice', id);
    expect(claim.kind).toBe('claimed');
    failPush();
    await service.idle();
    if (claim.kind === 'claimed') await claim.release(true);
    expect((await service.get('alice', id))?.status).toBe('answered');
  });
});

describe('long-poll', () => {
  it('wakes on answered and on cancelled', async () => {
    const { g, token } = await callingGateway();
    const first = await ringOk(g, token);
    const waiting = g.send('GET', `/v1/connectors/ring/${first.invite_id}?wait=25`, {
      headers: bearer(token),
    });
    await waitFor(() => g.ring!.scheduler.pending >= 2);
    expect(
      (await g.send('POST', `/v1/invites/${first.invite_id}/answer`, { user: 'alice' })).statusCode,
    ).toBe(201);
    expect((await waiting).json()).toEqual({ status: 'answered' });
    await g.calls!.registry.endCallsForUser('alice');
    await waitFor(() => !g.calls!.registry.hasLiveCall('alice'));

    const second = await ringOk(g, token);
    const polling = g.send('GET', `/v1/connectors/ring/${second.invite_id}?wait=25`, {
      headers: bearer(token),
    });
    const before = g.ring!.scheduler.pending;
    await waitFor(() => g.ring!.scheduler.pending > before);
    await g.send('DELETE', `/v1/connectors/ring/${second.invite_id}`, { headers: bearer(token) });
    expect((await polling).json()).toEqual({ status: 'cancelled' });
  });

  it('delete-my-data mid-wait ends the long-poll with 404', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    const waiting = g.send('GET', `/v1/connectors/ring/${id}?wait=25`, { headers: bearer(token) });
    await waitFor(() => g.ring!.scheduler.pending >= 2);
    await g.ring!.service.deleteAllForUser('alice');
    expect((await waiting).statusCode).toBe(404);
  });

  it('a waiter whose connector went away releases its timer at once', async () => {
    const t = bareService();
    const id = await t.ring();
    const armed = t.scheduler.pending; // The expiry timer.
    const gone = new AbortController();
    const waiting = t.service.waitForOutcome('alice', id, 25_000, gone.signal);
    await waitFor(() => t.scheduler.pending > armed);
    gone.abort();
    expect((await waiting)?.status).toBe('pending');
    expect(t.scheduler.pending).toBe(armed);
  });

  it('a client that leaves during auth does not hold a waiter (listener before any await)', async () => {
    const { g, token } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    const armed = g.ring!.scheduler.pending;
    const connectors = g.stores.connectors;
    const lookup = connectors.findByTokenHash.bind(connectors);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let authStarted = false;
    connectors.findByTokenHash = async (hash) => {
      authStarted = true;
      await gate;
      return lookup(hash);
    };
    const port = (g.app.server.address() as AddressInfo).port;
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/v1/connectors/ring/${id}?wait=25`,
      headers: bearer(token),
    });
    req.on('error', () => undefined);
    req.end();
    await waitFor(() => authStarted);
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50)); // The server sees the close.
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(g.ring!.scheduler.pending).toBe(armed);
  });

  it('an open long-poll does not hold the server open on shutdown', async () => {
    const { g, token, connector } = await callingGateway();
    const { invite_id: id } = await ringOk(g, token);
    connector.terminate(); // Only the long-poll is left open.
    const port = (g.app.server.address() as AddressInfo).port;
    const req = request({
      host: '127.0.0.1',
      port,
      path: `/v1/connectors/ring/${id}?wait=25`,
      headers: bearer(token),
    });
    req.on('error', () => undefined);
    req.end();
    await new Promise((resolve) => setTimeout(resolve, 200)); // The poll is waiting.
    const started = Date.now();
    await g.app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a connector that is already gone does not hold a waiter for the whole wait', async () => {
    const t = bareService();
    const id = await t.ring();
    const armed = t.scheduler.pending;
    const gone = new AbortController();
    gone.abort();
    let settled = false;
    const waiting = t.service.waitForOutcome('alice', id, 25_000, gone.signal).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(true);
    expect(t.scheduler.pending).toBe(armed);
    await waiting;
  });
});

describe('logs', () => {
  it('never carry a push token, whatever the push outcome', async () => {
    const logger = recordingLogger();
    const scheduler = new ManualScheduler();
    const stores = {
      devices: new DeviceRepository(new MemoryCollection()),
      settings: new RingSettingsRepository(new MemoryCollection()),
      invites: new InviteRepository(new MemoryCollection()),
    };
    const tokens = ['fcm-sent-aaaaaaaaaaaaaaaaaaaa', 'fcm-dead-aaaaaaaaaaaaaaaaaaaa'];
    for (const [i, token] of tokens.entries()) {
      await stores.devices.upsert({
        user_id: 'alice',
        device_id: `phone-000${i}`,
        fcm_token: token,
        platform: 'android',
        app_variant: 'production',
        updated_at: '2026-10-01T09:00:00.000Z',
      });
    }
    const service = new RingService({
      stores,
      push: {
        send: (target) => {
          if (target.token.includes('dead')) return Promise.resolve('invalid');
          return Promise.reject(new Error(`boom for ${target.token}`));
        },
      },
      inCall: () => false,
      scheduler,
      logger,
    });
    await service.ring({
      userId: 'alice',
      connectorId: `con_${'a'.repeat(20)}`,
      localAgent: 'claude-code',
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Laptop Claude',
      reason: 'x',
    });
    scheduler.advance(30_000);
    await service.idle();
    const logged = JSON.stringify(logger.events);
    for (const token of tokens) expect(logged).not.toContain(token);
    expect(logger.names()).toContain('push_sent');
  });
});

describe('answer races', () => {
  it('a cancel that arrives while an answer is starting is not lost when the answer fails', async () => {
    const t = bareService();
    const id = await t.ring();
    const claim = await t.service.claimAnswer('alice', id);
    if (claim.kind !== 'claimed') throw new Error(claim.kind);
    // The agent changes its mind while the call is being started.
    await t.service.cancel('alice', id);
    // The call is refused (daily limit, computer offline): the ring must not ring on.
    await claim.release(false);
    expect((await t.service.get('alice', id))?.status).toBe('cancelled');
  });

  it('a cancel while an answer is starting loses to a successful answer', async () => {
    const t = bareService();
    const id = await t.ring();
    const claim = await t.service.claimAnswer('alice', id);
    if (claim.kind !== 'claimed') throw new Error(claim.kind);
    await t.service.cancel('alice', id);
    await claim.release(true);
    expect((await t.service.get('alice', id))?.status).toBe('answered');
  });

  it('the expiry timer firing during an answer that then fails never leaves the invite pending', async () => {
    const t = bareService();
    const id = await t.ring();
    const claim = await t.service.claimAnswer('alice', id);
    if (claim.kind !== 'claimed') throw new Error(claim.kind);
    // The timer fires a moment before the wall clock reaches expires_at (timers and Date.now()
    // are different clocks), while the answer is still starting.
    t.clock.ms += 29_999;
    t.scheduler.advance(30_000);
    await claim.release(false);
    // Whatever happens next, the ring must still end.
    t.clock.ms += 5_000;
    t.scheduler.advance(5_000);
    await t.service.idle();
    expect((await t.service.get('alice', id))?.status).toBe('missed');
  });

  it('expiry during a successful answer: answered, no voicemail', async () => {
    const t = bareService();
    const id = await t.ring();
    const claim = await t.service.claimAnswer('alice', id);
    if (claim.kind !== 'claimed') throw new Error(claim.kind);
    t.clock.ms += 31_000;
    t.scheduler.advance(31_000);
    await claim.release(true);
    await t.service.idle();
    expect((await t.service.get('alice', id))?.status).toBe('answered');
  });

  it('a stale pending invite (timer lost) does not block new rings or show as pending', async () => {
    const t = bareService();
    const id = await t.ring();
    t.service.close(); // Timers gone, invite still pending in the store.
    t.clock.ms += 31_000;
    expect(await t.service.listPending('alice')).toEqual([]);
    const next = await t.ring();
    expect(next).not.toBe(id);
  });
});
