import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { loadGatewayEnv } from '@twring/config/gateway';
import {
  createCallResponseSchema,
  deleteMyDataResponseSchema,
  errorResponseSchema,
  meUsageResponseSchema,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app';
import { createLoggerOptions } from '../logger';
import type { RoomService } from '../livekit/rooms';
import { TEST_KEYS } from '../connectors/harness';
import { JsonFileCollection, MemoryCollection } from '../store/collection';
import { createMemoryStores } from '../store/repositories';
import { RefusalCounter, type RefusalRow } from './refusal-counter';

import {
  DailyLimits,
  dailyUsageRowSchema,
  nextUtcMidnight,
  utcDay,
  type DailyUsageRow,
  type ServiceCap,
} from './daily-limits';
import { CallRegistry } from './registry';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';

const NOON = Date.parse('2026-09-30T12:00:00Z');

function limits(allowance = { callSeconds: 600, calls: 3 }, start = NOON) {
  const clock = { now: start };
  const rows = new MemoryCollection<DailyUsageRow>();
  return { clock, rows, limits: new DailyLimits(rows, allowance, () => new Date(clock.now)) };
}

describe('DailyLimits', () => {
  it('counts calls and seconds against the UTC day', async () => {
    const { limits: daily } = limits();
    const first = await daily.admit('u1');
    expect(first).toEqual({ admitted: true, day: '2026-09-30', remainingSeconds: 600 });
    await daily.addCallSeconds('u1', '2026-09-30', 125.4);
    expect(await daily.admit('u1')).toMatchObject({ admitted: true, remainingSeconds: 474 });
    expect(await daily.usage('u1')).toEqual({
      day: '2026-09-30',
      resets_at: '2026-10-01T00:00:00.000Z',
      call_seconds_used: 125,
      call_seconds_allowed: 600,
      calls_used: 2,
      calls_allowed: 3,
    });
    // Other users are counted separately.
    expect((await daily.usage('u2')).calls_used).toBe(0);
  });

  it('refuses once the calls or the seconds are used up, with the reset time', async () => {
    const { limits: daily } = limits();
    for (let i = 0; i < 3; i++) expect((await daily.admit('u1')).admitted).toBe(true);
    expect(await daily.admit('u1')).toEqual({
      admitted: false,
      resetsAt: new Date('2026-10-01T00:00:00Z'),
    });

    const other = limits().limits;
    await other.admit('u2');
    await other.addCallSeconds('u2', '2026-09-30', 600);
    expect((await other.admit('u2')).admitted).toBe(false);
  });

  it('starts again after UTC midnight and prunes old days', async () => {
    const { limits: daily, clock, rows } = limits({ callSeconds: 60, calls: 1 });
    await daily.admit('u1');
    await daily.addCallSeconds('u1', '2026-09-30', 60);
    expect((await daily.admit('u1')).admitted).toBe(false);
    clock.now = Date.parse('2026-10-01T00:00:00Z');
    expect(await daily.admit('u1')).toMatchObject({ admitted: true, day: '2026-10-01' });
    // A call that started yesterday still lands on yesterday.
    await daily.addCallSeconds('u1', '2026-09-30', 5);
    expect((await daily.usage('u1')).call_seconds_used).toBe(0);
    clock.now = Date.parse('2026-10-03T08:00:00Z');
    await daily.admit('u1');
    expect((await rows.read()).map((r) => r.day)).toEqual(['2026-10-03']);
  });

  it('treats 0 as unlimited', async () => {
    const { limits: daily } = limits({ callSeconds: 0, calls: 0 });
    for (let i = 0; i < 100; i++) await daily.admit('u1');
    await daily.addCallSeconds('u1', '2026-09-30', 86_000);
    expect(await daily.admit('u1')).toEqual({ admitted: true, day: '2026-09-30' });
    const usage = await daily.usage('u1');
    expect(usage.call_seconds_allowed).toBeNull();
    expect(usage.calls_allowed).toBeNull();
    expect(meUsageResponseSchema.parse(usage)).toEqual(usage);
  });

  it('gives back a call that never started', async () => {
    const { limits: daily } = limits({ callSeconds: 0, calls: 1 });
    await daily.admit('u1');
    await daily.refund('u1', '2026-09-30');
    expect((await daily.admit('u1')).admitted).toBe(true);
  });

  it('keeps the count across a restart (file store)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-daily-'));
    try {
      const file = join(dir, 'daily-usage.json');
      const open = () =>
        new DailyLimits(
          new JsonFileCollection(file, dailyUsageRowSchema),
          { callSeconds: 600, calls: 2 },
          () => new Date(NOON),
        );
      const before = open();
      await before.admit('u1');
      await before.addCallSeconds('u1', '2026-09-30', 90);
      const after = open();
      expect(await after.usage('u1')).toMatchObject({ calls_used: 1, call_seconds_used: 90 });
      await after.admit('u1');
      expect((await after.admit('u1')).admitted).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('computes UTC days and the next midnight', () => {
    const lateEvening = new Date('2026-12-31T23:59:59.999Z');
    expect(utcDay(lateEvening)).toBe('2026-12-31');
    expect(nextUtcMidnight(lateEvening).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('DailyLimits: service-wide cap (wave 1, task 4)', () => {
  function capped(capSeconds: number, start = NOON) {
    const clock = { now: start };
    const rows = new MemoryCollection<DailyUsageRow>();
    const crossed: { used: number; cap: number }[] = [];
    const daily = new DailyLimits(rows, { callSeconds: 0, calls: 0 }, () => new Date(clock.now), {
      callSeconds: capSeconds,
      onThreshold: (used, cap) => crossed.push({ used, cap }),
    });
    return { clock, daily, crossed };
  }

  it("refuses new calls once everyone's seconds today reach the cap", async () => {
    const { daily } = capped(1000);
    await daily.admit('u1');
    await daily.addCallSeconds('u1', '2026-09-30', 600);
    await daily.admit('u2');
    await daily.addCallSeconds('u2', '2026-09-30', 399);
    // 999 of 1000 used: still admitted (it may run past the cap; only new calls stop).
    expect(await daily.admit('u3')).toMatchObject({ admitted: true });
    await daily.addCallSeconds('u3', '2026-09-30', 30);
    expect(await daily.admit('u4')).toEqual({
      admitted: false,
      service: true,
      resetsAt: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('starts again at UTC midnight', async () => {
    const { clock, daily } = capped(100);
    await daily.admit('u1');
    await daily.addCallSeconds('u1', '2026-09-30', 150);
    expect(await daily.admit('u2')).toMatchObject({ admitted: false, service: true });
    clock.now = Date.parse('2026-10-01T00:00:01Z');
    expect(await daily.admit('u2')).toMatchObject({ admitted: true });
  });

  it('tells the owner once a day when 80% is used', async () => {
    const { clock, daily, crossed } = capped(1000);
    await daily.addCallSeconds('u1', '2026-09-30', 700);
    expect(crossed).toEqual([]);
    await daily.addCallSeconds('u2', '2026-09-30', 150);
    await daily.addCallSeconds('u3', '2026-09-30', 100);
    expect(crossed).toEqual([{ used: 850, cap: 1000 }]);
    clock.now = Date.parse('2026-10-01T09:00:00Z');
    await daily.addCallSeconds('u1', '2026-10-01', 900);
    expect(crossed).toHaveLength(2);
  });

  it('a failing alert never fails the call bookkeeping', async () => {
    const rows = new MemoryCollection<DailyUsageRow>();
    const daily = new DailyLimits(rows, { callSeconds: 0, calls: 0 }, () => new Date(NOON), {
      callSeconds: 100,
      onThreshold: () => {
        throw new Error('mail down');
      },
    });
    await expect(daily.addCallSeconds('u1', '2026-09-30', 90)).resolves.toBeUndefined();
    expect((await rows.read())[0]?.call_seconds).toBe(90);
  });

  it('0 means no service cap', async () => {
    const { daily } = capped(0);
    await daily.addCallSeconds('u1', '2026-09-30', 1_000_000);
    expect(await daily.admit('u2')).toMatchObject({ admitted: true });
  });
});

class FakeRooms implements RoomService {
  deleteRoom(): Promise<void> {
    return Promise.resolve();
  }
  removeParticipant(): Promise<void> {
    return Promise.resolve();
  }
  ping(): Promise<void> {
    return Promise.resolve();
  }
}

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(
  allowance: { callSeconds: number; calls: number },
  service?: ServiceCap,
  extra: { refusals?: Pick<RefusalCounter, 'count'>; logs?: string[] } = {},
) {
  const env = loadGatewayEnv(gatewayEnvFixture({ CALL_MAX_DURATION_S: '1800' }));
  const scheduler = new ManualScheduler();
  const now = () => new Date(NOON + scheduler.now());
  const daily = new DailyLimits(new MemoryCollection<DailyUsageRow>(), allowance, now, service);
  const transports: FakeTransport[] = [];
  const registry = new CallRegistry({
    env,
    liveKitUrl: 'wss://cord-test.livekit.invalid',
    rooms: new FakeRooms(),
    tokens: {
      caller: () => Promise.resolve('caller-token'),
      gateway: () => Promise.resolve('gateway-token'),
    },
    transports: () => {
      const transport = new FakeTransport();
      // The caller joins at once, so only the duration caps end the call.
      queueMicrotask(() => transport.emit({ type: 'caller_joined' }));
      transports.push(transport);
      return transport;
    },
    scheduler,
    logger: recordingLogger(),
    now,
    onCallFinished: ({ ownerId, startedAt, durationS }) =>
      daily.addCallSeconds(ownerId, utcDay(startedAt), durationS),
  });
  const refusalRows = new MemoryCollection<RefusalRow>();
  const refusals = new RefusalCounter(refusalRows, () => new Date('2026-09-30T12:00:00.000Z'));
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      extra.logs?.push(chunk.toString());
      done();
    },
  });
  const app = buildApp({
    env,
    onError: () => undefined,
    userFor: () => 'user-1',
    ...(extra.logs !== undefined && {
      logger: { ...createLoggerOptions({ ...env, LOG_LEVEL: 'warn' }), stream: sink },
    }),
    calls: {
      registry,
      createRatePerMinute: 100,
      dailyLimits: daily,
      refusals: extra.refusals ?? refusals,
    },
    usage: { dailyLimits: daily },
  });
  apps.push(app);
  const createCall = () => app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
  return { app, daily, scheduler, transports, registry, createCall, refusalRows };
}

describe('daily limits over the API', () => {
  it("refuses a call with service_busy once today's service-wide calling is used up", async () => {
    const { createCall, daily } = setup({ callSeconds: 0, calls: 0 }, { callSeconds: 60 });
    await daily.addCallSeconds('someone-else', '2026-09-30', 61);
    const refused = await createCall();
    expect(refused.statusCode).toBe(503);
    const body = errorResponseSchema.parse(refused.json());
    expect(body.error).toMatchObject({
      code: 'service_busy',
      resets_at: '2026-10-01T00:00:00.000Z',
    });
    expect(body.error.message).toMatch(/very busy today/);
  });

  it('counts each refused call for the daily report', async () => {
    const { app, createCall, daily, refusalRows } = setup(
      { callSeconds: 0, calls: 0 },
      { callSeconds: 60 },
    );
    const admitted = await createCall();
    expect(admitted.statusCode).toBe(201);
    expect(await refusalRows.read()).toEqual([]);
    const callId = createCallResponseSchema.parse(admitted.json()).call_id;
    await app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` });
    await daily.addCallSeconds('someone-else', '2026-09-30', 61);
    await createCall();
    await createCall();
    expect(await refusalRows.read()).toEqual([
      { day: '2026-09-30', code: 'service_busy', count: 2 },
    ]);
  });

  it('a refusal that cannot be counted is logged, and the caller is still told why', async () => {
    const logs: string[] = [];
    const { createCall, daily } = setup(
      { callSeconds: 0, calls: 0 },
      { callSeconds: 60 },
      { refusals: { count: () => Promise.reject(new Error('damaged file')) }, logs },
    );
    await daily.addCallSeconds('someone-else', '2026-09-30', 61);
    const refused = await createCall();
    expect(refused.statusCode).toBe(503);
    expect(errorResponseSchema.parse(refused.json()).error.code).toBe('service_busy');
    expect(logs.some((line) => line.includes('"event":"refusal_count_failed"'))).toBe(true);
  });

  it('refuses a call over the limit with daily_limit_reached and the reset time', async () => {
    const { createCall, registry, app } = setup({ callSeconds: 0, calls: 1 });
    const first = await createCall();
    expect(first.statusCode).toBe(201);
    const callId = createCallResponseSchema.parse(first.json()).call_id;
    await app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` });
    const refused = await createCall();
    expect(refused.statusCode).toBe(429);
    const body = errorResponseSchema.parse(refused.json());
    expect(body.error.code).toBe('daily_limit_reached');
    expect(body.error.resets_at).toBe('2026-10-01T00:00:00.000Z');
    expect(registry.activeCount).toBe(0);
  });

  it('ends a call with a daily_limit notice when the allowance runs out, and counts it', async () => {
    const { createCall, scheduler, transports, app, registry } = setup({
      callSeconds: 120,
      calls: 0,
    });
    expect((await createCall()).statusCode).toBe(201);
    await flushMicrotasks();
    scheduler.advance(119_000);
    await flushMicrotasks();
    expect(transports[0]?.endReasons).toEqual([]);
    scheduler.advance(1_000);
    await flushMicrotasks();
    expect(transports[0]?.endReasons).toEqual(['daily_limit']);
    await registry.shutdown();

    const usage = meUsageResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/me/usage' })).json(),
    );
    expect(usage).toMatchObject({ call_seconds_used: 120, call_seconds_allowed: 120 });
    const refused = await createCall();
    expect(errorResponseSchema.parse(refused.json()).error.code).toBe('daily_limit_reached');
  });

  it('keeps the per-call cap reason when it is shorter than what is left today', async () => {
    const { createCall, scheduler, transports } = setup({ callSeconds: 3600, calls: 0 });
    await createCall();
    await flushMicrotasks();
    scheduler.advance(1_800_000);
    await flushMicrotasks();
    expect(transports[0]?.endReasons).toEqual(['max_duration']);
  });
});

/** A collection whose next update waits until `release()`: holds a request inside `admit`. */
class GatedCollection<T> extends MemoryCollection<T> {
  entered = false;
  private gate: Promise<void> | undefined;
  release: () => void = () => undefined;

  hold(): void {
    this.gate = new Promise((resolve) => (this.release = resolve));
  }

  override update<R>(
    change: (items: readonly T[]) => { items: readonly T[]; result: R },
  ): Promise<R> {
    const gate = this.gate;
    this.gate = undefined;
    this.entered = true;
    return gate === undefined ? super.update(change) : gate.then(() => super.update(change));
  }
}

describe('daily limits: edge cases', () => {
  function registryFor(env: ReturnType<typeof loadGatewayEnv>, daily: DailyLimits) {
    const scheduler = new ManualScheduler();
    const transports: FakeTransport[] = [];
    const registry = new CallRegistry({
      env,
      liveKitUrl: 'wss://cord-test.livekit.invalid',
      rooms: new FakeRooms(),
      tokens: {
        caller: () => Promise.resolve('caller-token'),
        gateway: () => Promise.resolve('gateway-token'),
      },
      transports: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      scheduler,
      logger: recordingLogger(),
      now: () => new Date(NOON + scheduler.now()),
      onCallFinished: ({ ownerId, startedAt, durationS }) =>
        daily.addCallSeconds(ownerId, utcDay(startedAt), durationS),
    });
    return { registry, scheduler, transports };
  }

  it('does not start a call to an agent whose data was deleted while the allowance was checked', async () => {
    const env = loadGatewayEnv(gatewayEnvFixture({ CALL_MAX_DURATION_S: '1800' }));
    const rows = new GatedCollection<DailyUsageRow>();
    const daily = new DailyLimits(rows, { callSeconds: 600, calls: 5 }, () => new Date(NOON));
    const { registry } = registryFor(env, daily);
    const app = buildApp({
      env,
      onError: () => undefined,
      userFor: () => 'user-1',
      calls: {
        registry,
        createRatePerMinute: 100,
        dailyLimits: daily,
        resolveAgent: () =>
          Promise.resolve({
            userId: 'user-1',
            agentId: 'agt_1',
            agentName: 'Laptop Claude',
            protocol: 'cord-connector',
            voiceId: 'aura-2-thalia-en',
            keyterms: [],
            createAgent: () => Promise.reject(new Error('not used')),
          }),
      },
    });
    apps.push(app);
    rows.hold();
    const response = app.inject({
      method: 'POST',
      url: '/v1/calls',
      payload: { agent_id: `agt_${'a'.repeat(20)}` },
    });
    await vi.waitFor(() => expect(rows.entered).toBe(true));
    // "Delete my data" runs while the allowance is being checked.
    await registry.endCallsForUser('user-1');
    rows.release();
    const res = await response;
    expect(res.statusCode).toBe(404);
    expect(registry.activeCount).toBe(0);
    // The refused call is not counted.
    expect((await daily.usage('user-1')).calls_used).toBe(0);
  });

  it('still starts calls when the usage file is damaged (the allowance fails open)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-daily-'));
    try {
      const file = join(dir, 'daily-usage.json');
      await writeFile(file, '{not json', 'utf8');
      const env = loadGatewayEnv(gatewayEnvFixture({ CALL_MAX_DURATION_S: '1800' }));
      const daily = new DailyLimits(
        new JsonFileCollection(file, dailyUsageRowSchema),
        { callSeconds: 600, calls: 5 },
        () => new Date(NOON),
      );
      const { registry } = registryFor(env, daily);
      const app = buildApp({
        env,
        onError: () => undefined,
        userFor: () => 'user-1',
        calls: { registry, createRatePerMinute: 100, dailyLimits: daily },
      });
      apps.push(app);
      const res = await app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
      expect(res.statusCode).toBe(201);
      await registry.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tells a phone that has not joined yet that the allowance ran out', async () => {
    const env = loadGatewayEnv(gatewayEnvFixture({ CALL_MAX_DURATION_S: '1800' }));
    const daily = new DailyLimits(
      new MemoryCollection<DailyUsageRow>(),
      { callSeconds: 600, calls: 0 },
      () => new Date(NOON),
    );
    await daily.admit('user-1');
    await daily.addCallSeconds('user-1', '2026-09-30', 598);
    const { registry, scheduler, transports } = registryFor(env, daily);
    const app = buildApp({
      env,
      onError: () => undefined,
      userFor: () => 'user-1',
      calls: { registry, createRatePerMinute: 100, dailyLimits: daily },
    });
    apps.push(app);
    expect((await app.inject({ method: 'POST', url: '/v1/calls', payload: {} })).statusCode).toBe(
      201,
    );
    await flushMicrotasks();
    // Two seconds left: the cap fires before the phone has joined the room.
    scheduler.advance(2_000);
    await flushMicrotasks();
    const transport = transports[0]!;
    expect(transport.endReasons).toEqual(['daily_limit']);
    // The gateway stays in the room so the phone can read why, instead of leaving at once.
    expect(transport.closeCount).toBe(0);
    transport.emit({ type: 'caller_joined' });
    await vi.waitFor(() => expect(transport.closeCount).toBe(1));
  });

  it('parallel calls cannot overshoot the seconds: one call at a time per user', async () => {
    const { createCall, scheduler, transports, daily } = setup({ callSeconds: 120, calls: 0 });
    expect((await createCall()).statusCode).toBe(201);
    for (let i = 0; i < 2; i++) {
      const refused = await createCall();
      expect(refused.statusCode).toBe(409);
      expect(errorResponseSchema.parse(refused.json()).error.code).toBe('call_in_progress');
    }
    await flushMicrotasks();
    scheduler.advance(120_000);
    await flushMicrotasks();
    expect(transports.map((t) => t.endReasons)).toEqual([['daily_limit']]);
    await vi.waitFor(async () => expect((await daily.usage('user-1')).call_seconds_used).toBe(120));
    // The refused starts were never counted, and the day's seconds are used exactly once.
    expect((await daily.usage('user-1')).calls_used).toBe(1);
    expect((await createCall()).statusCode).toBe(429);
  });

  it('"Delete my data" does not reset the daily allowance', async () => {
    const env = loadGatewayEnv(gatewayEnvFixture({ CALL_MAX_DURATION_S: '1800' }));
    const daily = new DailyLimits(
      new MemoryCollection<DailyUsageRow>(),
      { callSeconds: 600, calls: 2 },
      () => new Date(NOON),
    );
    const { registry } = registryFor(env, daily);
    const app = buildApp({
      env,
      onError: () => undefined,
      userFor: () => 'user-1',
      calls: { registry, createRatePerMinute: 100, dailyLimits: daily },
      usage: { dailyLimits: daily },
      agents: {
        stores: createMemoryStores(TEST_KEYS),
        policy: { env: 'development' },
        writeRatePerMinute: 100,
      },
      me: { deleteRatePerMinute: 100 },
    });
    apps.push(app);
    // Two calls today, one after the other; the second is still live at the deletion.
    for (let i = 0; i < 2; i++) {
      const created = await app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
      expect(created.statusCode).toBe(201);
      if (i === 0) {
        const callId = createCallResponseSchema.parse(created.json()).call_id;
        await app.inject({ method: 'POST', url: `/v1/calls/${callId}/end` });
      }
    }
    const deleted = await app.inject({ method: 'DELETE', url: '/v1/me/data' });
    expect(deleted.statusCode).toBe(200);
    expect(deleteMyDataResponseSchema.parse(deleted.json()).live_calls_ended).toBe(1);
    const usage = meUsageResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/v1/me/usage' })).json(),
    );
    expect(usage.calls_used).toBe(2);
    const refused = await app.inject({ method: 'POST', url: '/v1/calls', payload: {} });
    expect(errorResponseSchema.parse(refused.json()).error.code).toBe('daily_limit_reached');
  });

  it('a call that crosses UTC midnight counts against the day it started on', async () => {
    const late = Date.parse('2026-09-30T23:59:00Z');
    const clock = { now: late };
    const daily = new DailyLimits(
      new MemoryCollection<DailyUsageRow>(),
      { callSeconds: 600, calls: 0 },
      () => new Date(clock.now),
    );
    expect(await daily.admit('user-1')).toMatchObject({ admitted: true, day: '2026-09-30' });
    clock.now = late + 300_000; // five minutes later: 00:04 on 1 October
    await daily.addCallSeconds('user-1', '2026-09-30', 300);
    expect(await daily.usage('user-1')).toMatchObject({
      day: '2026-10-01',
      call_seconds_used: 0,
      calls_used: 0,
    });
    expect(await daily.admit('user-1')).toMatchObject({ admitted: true, remainingSeconds: 600 });
  });
});
