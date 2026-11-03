import { loadGatewayEnv, type GatewayEnv } from '@twring/config/gateway';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CallHistoryItem,
  callSummarySchema,
  createCallResponseSchema,
  errorResponseSchema,
  GATEWAY_IDENTITY,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { TokenVerifier } from 'livekit-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import type { RoomService } from '../livekit/rooms';
import { mintCallerToken, mintGatewayToken } from '../livekit/tokens';

import { CallRegistry, type SavedAgentCall } from './registry';
import type { CallRoutesOptions } from './routes';
import { feedbackRecordSchema } from './feedback-store';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';

const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'APIfaketestkey',
  apiSecret: 'fake-secret-value-for-tests-0123456789',
};

class FakeRooms implements RoomService {
  readonly deleted: string[] = [];

  deleteRoom(name: string): Promise<void> {
    this.deleted.push(name);
    return Promise.resolve();
  }

  readonly removed: string[] = [];
  removeParticipant(room: string, identity: string): Promise<void> {
    this.removed.push(`${room}/${identity}`);
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }
}

const apps: ReturnType<typeof buildApp>[] = [];

it('stores owner feedback, rejects invalid bodies and foreign calls, and replaces a retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cord-feedback-'));
  try {
    const { app, registry } = setup({ CORD_DATA_DIR: dir });
    const agent: SavedAgentCall = {
      userId: 'owner',
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Agent',
      protocol: 'cord-rest',
      voiceId: 'flux-aura-en',
      keyterms: [],
      createAgent: () => Promise.reject(new Error('unused')),
    };
    const call = await registry.create(agent);
    const post = (user: string, body: object, id = call.call_id) =>
      app.inject({
        method: 'POST',
        url: `/v1/calls/${id}/feedback`,
        payload: body,
        headers: { 'x-test-user': user, 'x-app-version': '1.2.3' },
      });
    expect((await post('other', { rating: 3 })).statusCode).toBe(404);
    expect((await post('owner', { rating: 3 }, `call_${'z'.repeat(20)}`)).statusCode).toBe(404);
    for (const body of [{ rating: 0 }, { rating: 6 }, { rating: 4, issues: ['slow', 'slow'] }])
      expect((await post('owner', body)).statusCode).toBe(400);
    expect(
      (await post('owner', { rating: 2, issues: ['slow'], note: 'private note' })).statusCode,
    ).toBe(200);
    expect((await post('owner', { rating: 5 })).statusCode).toBe(200);
    const rows = feedbackRecordSchema
      .array()
      .parse(JSON.parse(await readFile(join(dir, 'call-feedback.json'), 'utf8')));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_id: call.call_id,
      user_id: 'owner',
      agent_id: agent.agentId,
      protocol: 'cord-rest',
      rating: 5,
      issues: [],
      app_version: '1.2.3',
    });
  } finally {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('accepts feedback for a finished call the registry no longer holds, from call history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cord-feedback-'));
  try {
    const callId = `call_${'q'.repeat(20)}`;
    const agentId = `agt_${'b'.repeat(20)}`;
    const history: NonNullable<CallRoutesOptions['history']> = {
      list: (userId) =>
        Promise.resolve(
          userId === 'owner' ? [{ call_id: callId, agent_id: agentId } as CallHistoryItem] : [],
        ),
    };
    const { app } = setup({ CORD_DATA_DIR: dir }, () => undefined, { history });
    const post = (user: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/calls/${callId}/feedback`,
        payload: { rating: 4, issues: ['misheard'] },
        headers: { 'x-test-user': user },
      });
    expect((await post('other')).statusCode).toBe(404);
    expect((await post('owner')).statusCode).toBe(200);
    const rows = feedbackRecordSchema
      .array()
      .parse(JSON.parse(await readFile(join(dir, 'call-feedback.json'), 'utf8')));
    expect(rows[0]).toMatchObject({ call_id: callId, agent_id: agentId, rating: 4 });
  } finally {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await rm(dir, { recursive: true, force: true });
  }
});

it('tracks a live call to a specific saved agent', async () => {
  const { registry } = setup();
  const saved: SavedAgentCall = {
    userId: 'owner',
    agentId: `agt_${'a'.repeat(20)}`,
    agentName: 'Agent',
    protocol: 'cord-rest',
    voiceId: 'flux-aura-en',
    keyterms: [],
    createAgent: () => Promise.reject(new Error('unused')),
  };
  const created = await registry.create(saved);
  expect(registry.hasLiveCallToAgent('owner', saved.agentId)).toBe(true);
  expect(registry.hasLiveCallToAgent('other', saved.agentId)).toBe(false);
  expect(registry.hasLiveCallToAgent('owner', `agt_${'b'.repeat(20)}`)).toBe(false);
  await registry.end(created.call_id);
  expect(registry.hasLiveCallToAgent('owner', saved.agentId)).toBe(false);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  envOverrides: Record<string, string> = {},
  configureTransport: (transport: FakeTransport) => void = () => undefined,
  callExtras: Pick<CallRoutesOptions, 'history'> = {},
) {
  const env: GatewayEnv = loadGatewayEnv(gatewayEnvFixture(envOverrides));
  const rooms = new FakeRooms();
  const transports: FakeTransport[] = [];
  const logger = recordingLogger();
  const control = { failTokens: false };
  const registry = new CallRegistry({
    env,
    liveKitUrl: LIVEKIT.url,
    rooms,
    tokens: {
      caller: (request) =>
        control.failTokens
          ? Promise.reject(new Error('signing failed: invalid API key sk_live_x'))
          : mintCallerToken(LIVEKIT, request),
      gateway: (request) => mintGatewayToken(LIVEKIT, request),
    },
    transports: () => {
      const transport = new FakeTransport();
      configureTransport(transport);
      transports.push(transport);
      return transport;
    },
    scheduler: new ManualScheduler(),
    logger,
  });
  const app = buildApp({
    env,
    onError: () => undefined,
    // Tests name the acting user in a header; one user has one call at a time.
    userFor: (request) => String(request.headers['x-test-user'] ?? 'dev'),
    calls: { registry, createRatePerMinute: env.CALL_CREATE_RATE_PER_MINUTE, ...callExtras },
  });
  apps.push(app);
  const createCall = (user = 'dev') =>
    app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload: {},
      remoteAddress: '203.0.113.7',
      headers: { 'x-test-user': user },
    });
  return { app, registry, rooms, transports, logger, createCall, control };
}

describe('POST /v1/calls/:callId/approvals/:approvalId', () => {
  it('applies once and hides calls and approvals that the owner cannot access', async () => {
    const { app, registry, createCall } = setup();
    const call = createCallResponseSchema.parse((await createCall('owner')).json());
    let decided = false;
    vi.spyOn(registry, 'decideApprovalFor').mockImplementation((userId, callId, approvalId) => {
      if (registry.getFor(userId, callId) === undefined || approvalId !== 'apr_1') return 'unknown';
      if (decided) return 'decided';
      decided = true;
      return 'applied';
    });
    const post = (user: string, callId: string, approvalId: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/calls/${callId}/approvals/${approvalId}`,
        payload: { decision: 'approve' },
        headers: { 'x-test-user': user },
      });
    expect((await post('other', call.call_id, 'apr_1')).statusCode).toBe(404);
    expect((await post('owner', call.call_id, 'unknown')).statusCode).toBe(404);
    expect((await post('owner', 'call_aaaaaaaaaaaaaaaaaaaa', 'apr_1')).statusCode).toBe(404);
    expect((await post('owner', call.call_id, 'apr_1')).statusCode).toBe(204);
    const repeat = await post('owner', call.call_id, 'apr_1');
    expect(repeat.statusCode).toBe(409);
    expect(errorResponseSchema.parse(repeat.json()).error.code).toBe('approval_already_decided');
  });
});

describe('POST /v1/calls', () => {
  it('creates a room, starts the gateway, and returns a room-scoped caller token', async () => {
    const { transports, createCall } = setup();
    const res = await createCall();
    expect(res.statusCode).toBe(201);
    const body = createCallResponseSchema.parse(res.json());
    expect(body.livekit.url).toBe(LIVEKIT.url);
    expect(body.livekit.room).toBe(`cord-call-${body.call_id.slice('call_'.length)}`);

    const claims = await new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(
      body.livekit.token,
    );
    expect(claims.video).toMatchObject({
      room: body.livekit.room,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    // LiveKit creates the room on first join from these settings (no pre-create round trip).
    expect(claims.roomConfig).toMatchObject({
      name: body.livekit.room,
      maxParticipants: 2,
      emptyTimeout: 60,
    });
    expect(claims.video?.roomAdmin).toBeUndefined();
    expect(claims.video?.roomCreate).toBeUndefined();
    expect(claims.sub).not.toBe(GATEWAY_IDENTITY);
    expect(claims.exp! - claims.nbf!).toBe(600);

    await flushMicrotasks();
    expect(transports).toHaveLength(1);
    expect(transports[0]?.states).toEqual(['ready']);
  });

  it('never returns provider error text when call setup fails', async () => {
    const { control, createCall, registry, transports } = setup();
    control.failTokens = true;
    const res = await createCall();
    expect(res.statusCode).toBe(503);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('service_unavailable');
    expect(res.body).not.toMatch(/sk_live|twirp|API key/);
    expect(registry.activeCount).toBe(0);
    expect(transports).toEqual([]);
  });

  it('refuses new calls when the kill switch is off', async () => {
    const { createCall, transports } = setup({ CALLS_ENABLED: 'false' });
    const res = await createCall();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    expect(transports).toEqual([]);
  });

  it('caps concurrent calls, including ones still being set up', async () => {
    const { createCall } = setup({ CALL_MAX_CONCURRENT: '2' });
    const results = await Promise.all([createCall('u1'), createCall('u2'), createCall('u3')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 503]);
    expect(results.find((r) => r.statusCode === 503)?.json()).toMatchObject({
      error: { code: 'capacity_exceeded' },
    });
  });

  it('refuses a second call while the user has a live one (one line per user)', async () => {
    const { app, createCall, registry } = setup({ CALL_MAX_CONCURRENT: '5' });
    const first = createCallResponseSchema.parse((await createCall()).json());
    await flushMicrotasks();
    const second = await createCall();
    expect(second.statusCode).toBe(409);
    expect(errorResponseSchema.parse(second.json()).error).toMatchObject({
      code: 'call_in_progress',
      message: "You're already on a call. End it first.",
    });
    // Another user is unaffected.
    expect((await createCall('someone-else')).statusCode).toBe(201);
    // Once the call ends, the line is free again.
    await app.inject({ method: 'POST', url: `/v1/calls/${first.call_id}/end` });
    expect((await createCall()).statusCode).toBe(201);
    expect(registry.activeCount).toBe(2);
  });

  it('lets exactly one of two simultaneous starts by the same user through', async () => {
    const { createCall, registry } = setup({ CALL_MAX_CONCURRENT: '5' });
    const results = await Promise.all([createCall(), createCall()]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)?.json()).toMatchObject({
      error: { code: 'call_in_progress' },
    });
    expect(registry.activeCount).toBe(1);
  });

  it('rate-limits call creation per person, not per address (review finding 6)', async () => {
    const { createCall, app } = setup({
      CALL_CREATE_RATE_PER_MINUTE: '1',
      CALL_MAX_CONCURRENT: '5',
    });
    const first = createCallResponseSchema.parse((await createCall('u1')).json());
    await app.inject({
      method: 'POST',
      url: `/v1/calls/${first.call_id}/end`,
      headers: { 'x-test-user': 'u1' },
    });
    const limited = await createCall('u1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // Someone else on the same address still has their own budget.
    expect((await createCall('u2')).statusCode).toBe(201);
  });

  it('rejects unexpected body fields such as a client-supplied user ID', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/calls', payload: { user_id: 'u1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('answers 503 when calling is not configured', async () => {
    const env = loadGatewayEnv(gatewayEnvFixture());
    const app = buildApp({ env, calls: { registry: undefined, createRatePerMinute: 10 } });
    apps.push(app);
    const res = await app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
    expect(res.statusCode).toBe(503);
  });
});

describe('call lifecycle over HTTP', () => {
  it('ends idempotently, deletes the room, and keeps the summary queryable', async () => {
    const { app, createCall, rooms, transports } = setup();
    const { call_id: callId, livekit } = createCallResponseSchema.parse(
      (await createCall()).json(),
    );
    await flushMicrotasks();

    const live = await app.inject({ method: 'GET', url: `/v1/calls/${callId}` });
    expect(callSummarySchema.parse(live.json()).status).toBe('connecting');

    transports[0]?.emit({ type: 'caller_joined' });
    const active = await app.inject({ method: 'GET', url: `/v1/calls/${callId}` });
    expect(active.json()).toMatchObject({ status: 'active' });

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` }),
      app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const summary = callSummarySchema.parse(first.json());
    expect(summary.status).toBe('ended');
    expect(summary.ended_at).toBeDefined();
    expect(transports[0]?.closeCount).toBe(1);
    expect(rooms.deleted).toEqual([livekit.room]);

    const again = await app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` });
    expect(again.json()).toMatchObject({ status: 'ended' });
  });

  it('returns 404 for unknown or malformed call IDs', async () => {
    const { app } = setup();
    for (const url of [
      '/v1/calls/call_zzzzzzzzzzzzzzzzzzzz/end',
      '/v1/calls/../../etc/end',
      '/v1/calls/call_zzzzzzzzzzzzzzzzzzzz',
    ]) {
      const res = await app.inject({ method: url.endsWith('/end') ? 'POST' : 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });

  it('marks a call failed and deletes its room when the gateway cannot join', async () => {
    const { app, createCall, rooms } = setup({}, (transport) => {
      transport.connectBehavior = 'reject';
    });
    const created = createCallResponseSchema.parse((await createCall()).json());
    await flushMicrotasks();
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${created.call_id}` });
    expect(res.json()).toMatchObject({ status: 'failed' });
    expect(rooms.deleted).toEqual([created.livekit.room]);
  });

  it('removes anyone other than the caller who joins the call room', async () => {
    const { createCall, rooms, transports, logger } = setup();
    const created = createCallResponseSchema.parse((await createCall()).json());
    await flushMicrotasks();
    transports[0]?.emit({ type: 'unexpected_participant', identity: 'agent-XYZ' });
    await flushMicrotasks();
    expect(rooms.removed).toEqual([`${created.livekit.room}/agent-XYZ`]);
    expect(logger.names()).toContain('unexpected_participant');
  });

  it('ends every live call on shutdown and refuses new ones', async () => {
    const { createCall, registry, transports } = setup({ CALL_MAX_CONCURRENT: '5' });
    await createCall('u1');
    await createCall('u2');
    await flushMicrotasks();
    await registry.shutdown();
    expect(transports.map((t) => t.closeCount)).toEqual([1, 1]);
    expect(registry.activeCount).toBe(0);
    expect((await createCall()).statusCode).toBe(503);
  });

  it('while draining for an update, new calls are refused with "Twring is updating"', async () => {
    const { createCall, registry } = setup({ CALL_MAX_CONCURRENT: '5' });
    await createCall('u1');
    registry.drain();
    expect(registry.activeCount).toBe(1);
    const refused = await createCall('u2');
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      error: {
        code: 'service_unavailable',
        message: 'Twring is updating. Call again in a minute.',
      },
    });
  });
});
