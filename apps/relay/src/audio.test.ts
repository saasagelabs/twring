import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';

import {
  errorResponseSchema,
  GATEWAY_IDENTITY,
  relayAudioSessionResponseSchema,
} from '@twring/contracts';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { loadRelayEnv } from './config';
import { openRelayDb } from './db';
import type { EmailSender } from './email';
import { emailSendKey, InstallStore } from './installs';
import { UsageStore } from './usage';

const START = Date.parse('2026-11-01T00:00:00.000Z');
const MINUTE = 60_000;
const LIVEKIT = {
  RELAY_LIVEKIT_URL: 'wss://audio.twring.test',
  RELAY_LIVEKIT_API_KEY: 'APIrelaytest',
  RELAY_LIVEKIT_API_SECRET: 'relay-livekit-secret-for-tests-0123456789',
};
const noEmail: EmailSender = { send: () => Promise.resolve('sent') };

async function setup(envOverrides: Record<string, string> = {}) {
  const clock = { now: START };
  const deleted: string[] = [];
  const logs: string[] = [];
  /** Room deletions that fail before succeeding (LiveKit briefly down). */
  const failDeletes = { left: 0 };
  /** Rooms that exist on (fake) LiveKit. */
  const live = new Set<string>();
  /** The relay's periodic jobs (email retry, audio sweeper); tests run them by hand. */
  const timers: (() => Promise<void>)[] = [];
  const sweep = async () => {
    for (const run of timers) await run();
  };
  const env = loadRelayEnv({
    RELAY_FREE_UNTIL: '2027-06-30',
    RELAY_ADMIN_TOKEN: 'admin-token-that-is-long-enough-0123456789',
    LOG_LEVEL: 'warn',
    RELAY_AUDIO_ENABLED: 'true',
    ...LIVEKIT,
    ...envOverrides,
  });
  const db = openRelayDb(':memory:');
  const app = await buildApp({
    env,
    db,
    email: noEmail,
    partners: [],
    now: () => clock.now,
    every: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
    audioRooms: {
      deleteRoom: (name) => {
        if (failDeletes.left > 0) {
          failDeletes.left -= 1;
          return Promise.reject(new Error('livekit down'));
        }
        deleted.push(name);
        live.delete(name);
        return Promise.resolve();
      },
      listRooms: (names) => Promise.resolve(names.filter((name) => live.has(name))),
    },
    logStream: new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        logs.push(chunk.toString());
        done();
      },
    }),
  });
  const installs = new InstallStore(db);
  let n = 0;
  const newInstall = (options: { verified?: boolean; paidUntil?: string } = {}) => {
    n += 1;
    const { install, key } = installs.create(
      {
        serverId: `srv_test${n}`,
        publicKey: `pk${n}`,
        email: 'owner@example.com',
        news: false,
        paidUntil: options.paidUntil ?? '2027-06-30T00:00:00.000Z',
      },
      clock.now,
    );
    if (options.verified !== false) {
      db.sqlite
        .prepare('UPDATE installs SET verified_at = ? WHERE id = ?')
        .run(new Date(clock.now).toISOString(), install.id);
    }
    return { id: install.id, key };
  };
  const start = (key: string, callId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/audio/sessions',
      headers: { authorization: `Bearer ${key}` },
      payload: { call_id: callId },
    });
  const end = (key: string, room: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/audio/sessions/${encodeURIComponent(room)}`,
      headers: { authorization: `Bearer ${key}` },
    });
  const endByCall = (key: string, callId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/audio/sessions/by-call/${encodeURIComponent(callId)}`,
      headers: { authorization: `Bearer ${key}` },
    });
  /** LiveKit's webhook: the body signed with the relay's LiveKit key, as LiveKit sends it. */
  const webhook = async (
    event: Record<string, unknown>,
    sign: { secret?: string; unsigned?: boolean } = {},
  ) => {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = { 'content-type': 'application/webhook+json' };
    if (sign.unsigned !== true) {
      const token = new AccessToken(
        LIVEKIT.RELAY_LIVEKIT_API_KEY,
        sign.secret ?? LIVEKIT.RELAY_LIVEKIT_API_SECRET,
      );
      token.sha256 = createHash('sha256').update(body).digest('base64');
      headers.authorization = await token.toJwt();
    }
    return app.inject({ method: 'POST', url: '/v1/livekit/webhook', headers, payload: body });
  };
  const minutes = (installId: string) =>
    new UsageStore(db).forDay(installId, '2026-11-01').audio_minutes ?? 0;
  /** LiveKit's view of a room: it opens with the first join, finishes when it closes. */
  const roomStarted = async (room: string) => {
    live.add(room);
    return webhook({ event: 'room_started', room: { name: room } });
  };
  const roomFinished = async (room: string) => {
    live.delete(room);
    return webhook({ event: 'room_finished', room: { name: room } });
  };
  /** A started session: its room, after LiveKit said it started. */
  const call = async (key: string, callId: string) => {
    const { room } = relayAudioSessionResponseSchema.parse((await start(key, callId)).json());
    await roomStarted(room);
    return room;
  };
  return {
    app,
    db,
    clock,
    deleted,
    logs,
    failDeletes,
    live,
    installs,
    newInstall,
    start,
    end,
    endByCall,
    webhook,
    minutes,
    sweep,
    roomStarted,
    roomFinished,
    call,
  };
}

const verify = (token: string) =>
  new TokenVerifier(LIVEKIT.RELAY_LIVEKIT_API_KEY, LIVEKIT.RELAY_LIVEKIT_API_SECRET).verify(token);

describe('POST /v1/audio/sessions', () => {
  it('names the room under the install and limits both tokens to it for 10 minutes', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const res = await ctx.start(install.key, 'call_abc');
    expect(res.statusCode).toBe(201);
    const session = relayAudioSessionResponseSchema.parse(res.json());
    expect(session.url).toBe('wss://audio.twring.test');
    expect(session.room).toBe(`inst_${install.id}_call_abc`);
    expect(session.expires_at).toBe(new Date(START + 10 * MINUTE).toISOString());

    const caller = await verify(session.caller_token);
    expect(caller.sub).toBe('caller-call_abc');
    expect(caller.video).toMatchObject({
      room: session.room,
      roomJoin: true,
      canPublishSources: ['microphone'],
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    expect(caller.video?.roomAdmin).toBeUndefined();
    expect(caller.video?.roomCreate).toBeUndefined();
    expect(caller.video?.roomList).toBeUndefined();
    expect(caller.roomConfig).toMatchObject({ name: session.room, maxParticipants: 2 });
    expect(caller.exp! - caller.nbf!).toBe(600);

    const server = await verify(session.server_token);
    expect(server.sub).toBe(GATEWAY_IDENTITY);
    expect(server.video).toMatchObject({ room: session.room, roomJoin: true, agent: true });
    expect(server.video?.roomAdmin).toBeUndefined();
    expect(server.roomConfig).toMatchObject({ name: session.room, maxParticipants: 2 });
    expect(server.exp! - server.nbf!).toBe(600);
  });

  it('refuses a call id that is not room-safe', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    for (const bad of ['', 'a/b', '../x', 'x'.repeat(65)]) {
      expect((await ctx.start(install.key, bad)).statusCode, bad).toBe(400);
    }
  });

  it('cannot reach another install: the same call id gets its own room', async () => {
    const ctx = await setup();
    const a = ctx.newInstall();
    const b = ctx.newInstall();
    const roomA = relayAudioSessionResponseSchema.parse((await ctx.start(a.key, 'call_x')).json());
    const roomB = relayAudioSessionResponseSchema.parse((await ctx.start(b.key, 'call_x')).json());
    expect(roomA.room).not.toBe(roomB.room);
    expect(roomB.room.startsWith(`inst_${b.id}_`)).toBe(true);
    // A repeat of a call id on the same install is refused.
    expect((await ctx.start(a.key, 'call_x')).statusCode).toBe(409);
  });

  it('refuses a paused, an expired and a revoked install', async () => {
    const ctx = await setup();
    const paused = ctx.newInstall({ verified: false });
    ctx.clock.now = START + 30 * 86_400_000;
    const pausedRes = await ctx.start(paused.key, 'call_p');
    expect(pausedRes.statusCode).toBe(403);
    expect(errorResponseSchema.parse(pausedRes.json()).error.code).toBe('audio_paused');

    const expired = ctx.newInstall({ paidUntil: '2026-11-15T00:00:00.000Z' });
    const expiredRes = await ctx.start(expired.key, 'call_e');
    expect(expiredRes.statusCode).toBe(403);
    expect(errorResponseSchema.parse(expiredRes.json()).error.code).toBe('audio_expired');

    const revoked = ctx.newInstall();
    ctx.installs.revoke(revoked.id, ctx.clock.now);
    expect((await ctx.start(revoked.key, 'call_r')).statusCode).toBe(401);
    expect((await ctx.start('twr_unknown', 'call_u')).statusCode).toBe(401);
  });

  it('holds each install to its calls at once and minutes per day', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '2', RELAY_AUDIO_MINUTES_PER_DAY: '10' });
    const install = ctx.newInstall();
    const c1 = await ctx.call(install.key, 'c1');
    await ctx.call(install.key, 'c2');
    const busy = await ctx.start(install.key, 'c3');
    expect(busy.statusCode).toBe(429);
    expect(errorResponseSchema.parse(busy.json()).error.code).toBe('audio_limit_reached');
    // Another install is not held back by this one.
    expect((await ctx.start(ctx.newInstall().key, 'c3')).statusCode).toBe(201);

    ctx.clock.now += 10 * MINUTE;
    await ctx.roomFinished(c1);
    expect(ctx.minutes(install.id)).toBe(10);
    const res = await ctx.start(install.key, 'c4');
    expect(res.statusCode).toBe(429);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('audio_limit_reached');
  });

  it('sessions still open count toward the daily minutes', async () => {
    const ctx = await setup({ RELAY_AUDIO_MINUTES_PER_DAY: '10' });
    const install = ctx.newInstall();
    expect((await ctx.start(install.key, 'c1')).statusCode).toBe(201);
    ctx.clock.now += 11 * MINUTE;
    const res = await ctx.start(install.key, 'c2');
    expect(res.statusCode).toBe(429);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('audio_limit_reached');
  });

  it('gives an install inside its unconfirmed-email grace no audio (audio_paused)', async () => {
    const ctx = await setup();
    const fresh = ctx.newInstall({ verified: false });
    const res = await ctx.start(fresh.key, 'call_u');
    expect(res.statusCode).toBe(403);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('audio_paused');
  });

  it('holds the whole relay to its calls at once across installs', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT_TOTAL: '2' });
    await ctx.call(ctx.newInstall().key, 'a1');
    await ctx.call(ctx.newInstall().key, 'b1');
    const res = await ctx.start(ctx.newInstall().key, 'c1');
    expect(res.statusCode).toBe(429);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('audio_limit_reached');
  });

  it('holds the whole relay to its minutes per day across installs (open calls count)', async () => {
    const ctx = await setup({ RELAY_AUDIO_DAILY_MINUTES_TOTAL: '10' });
    const a = ctx.newInstall();
    const room = await ctx.call(a.key, 'a1');
    ctx.clock.now += 6 * MINUTE;
    await ctx.roomFinished(room);
    await ctx.call(ctx.newInstall().key, 'b1');
    ctx.clock.now += 5 * MINUTE;
    const res = await ctx.start(ctx.newInstall().key, 'c1');
    expect(res.statusCode).toBe(429);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('audio_limit_reached');
  });

  it('answers 503 when audio is off on this relay', async () => {
    const ctx = await setup({ RELAY_AUDIO_ENABLED: 'false' });
    const res = await ctx.start(ctx.newInstall().key, 'call_a');
    expect(res.statusCode).toBe(503);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('service_unavailable');
  });
});

describe('ending a session: LiveKit settles the minutes, not the server', () => {
  it('an immediate end report then an hour of use bills the hour; the line stays held until LiveKit says the room finished', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '1' });
    const install = ctx.newInstall();
    const room = await ctx.call(install.key, 'call_m');
    expect((await ctx.end(install.key, room)).statusCode).toBe(204);
    // The relay closes the room itself on Twring's LiveKit.
    expect(ctx.deleted).toEqual([room]);
    expect(ctx.minutes(install.id)).toBe(0);
    expect((await ctx.start(install.key, 'call_n')).statusCode).toBe(429);
    // A modified server keeps the room going (LiveKit refreshes its tokens).
    ctx.live.add(room);
    ctx.clock.now += 60 * MINUTE;
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(0);
    expect((await ctx.start(install.key, 'call_n')).statusCode).toBe(429);
    await ctx.roomFinished(room);
    expect(ctx.minutes(install.id)).toBe(60);
    expect((await ctx.start(install.key, 'call_n')).statusCode).toBe(201);
  });

  it('a join after the end deletes the room again, and the minutes keep counting', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const room = await ctx.call(install.key, 'call_j');
    ctx.clock.now += 2 * MINUTE;
    await ctx.end(install.key, room);
    await ctx.roomFinished(room);
    expect(ctx.minutes(install.id)).toBe(2);
    ctx.clock.now += 5 * MINUTE;
    await ctx.webhook({ event: 'participant_joined', room: { name: room } });
    expect(ctx.deleted).toEqual([room, room]);
    ctx.clock.now += 3 * MINUTE;
    await ctx.roomFinished(room);
    // Start to the last finish, counted once: 10 minutes in all.
    expect(ctx.minutes(install.id)).toBe(10);
  });

  it('with no word from LiveKit 3 minutes after the end, the sweeper settles at the end time only once LiveKit says the room is gone', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const room = await ctx.call(install.key, 'call_q');
    ctx.clock.now += 4 * MINUTE;
    await ctx.end(install.key, room);
    ctx.live.add(room); // the delete did not take yet
    ctx.clock.now += 3 * MINUTE;
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(0);
    ctx.live.delete(room);
    ctx.clock.now += 1 * MINUTE;
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(4);
    // A late room_finished and another end report count nothing more.
    await ctx.roomFinished(room);
    expect((await ctx.end(install.key, room)).statusCode).toBe(204);
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(4);
  });

  it('a session whose room never started is closed at 10 minutes, billed 0, line freed', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '1' });
    const install = ctx.newInstall();
    expect((await ctx.start(install.key, 'call_z')).statusCode).toBe(201);
    ctx.clock.now += 9 * MINUTE;
    await ctx.sweep();
    expect((await ctx.start(install.key, 'call_y')).statusCode).toBe(429);
    ctx.clock.now += 1 * MINUTE;
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(0);
    expect((await ctx.start(install.key, 'call_y')).statusCode).toBe(201);
  });

  it('a session with no room_started but a live room is not closed by the sweeper', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '1' });
    const install = ctx.newInstall();
    const { room } = relayAudioSessionResponseSchema.parse(
      (await ctx.start(install.key, 'call_x')).json(),
    );
    ctx.live.add(room);
    ctx.clock.now += 11 * MINUTE;
    await ctx.sweep();
    expect((await ctx.start(install.key, 'call_w')).statusCode).toBe(429);
  });

  it("refuses another install's room and leaves it open", async () => {
    const ctx = await setup();
    const a = ctx.newInstall();
    const b = ctx.newInstall();
    const room = await ctx.call(a.key, 'call_o');
    expect((await ctx.end(b.key, room)).statusCode).toBe(404);
    expect(ctx.deleted).toEqual([]);
    expect((await ctx.endByCall(b.key, 'call_o')).statusCode).toBe(404);
    expect(ctx.deleted).toEqual([]);
  });

  it('end by call id deletes the room of a session the server never learned', async () => {
    const ctx = await setup();
    const a = ctx.newInstall();
    const room = await ctx.call(a.key, 'call_lost');
    ctx.clock.now += 2 * MINUTE;
    expect((await ctx.endByCall(a.key, 'call_lost')).statusCode).toBe(204);
    expect(ctx.deleted).toEqual([room]);
    await ctx.roomFinished(room);
    expect(ctx.minutes(a.id)).toBe(2);
    expect((await ctx.endByCall(a.key, 'a b')).statusCode).toBe(400);
  });

  it('the two-hour net closes the room too, retrying a failed delete on the next sweep', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const room = await ctx.call(install.key, 'call_long');
    ctx.clock.now += 121 * MINUTE;
    ctx.failDeletes.left = 1;
    await ctx.sweep();
    expect(ctx.minutes(install.id)).toBe(120);
    expect(ctx.deleted).toEqual([]);
    expect(ctx.logs.join('')).toContain('audio_room_delete_failed');
    await ctx.sweep();
    expect(ctx.deleted).toEqual([room]);
    await ctx.sweep();
    expect(ctx.deleted).toEqual([room]);
    expect(ctx.minutes(install.id)).toBe(120);
  });

  it('a session settled with no word from LiveKit logs that webhooks are missing', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    expect((await ctx.start(install.key, 'call_quiet')).statusCode).toBe(201);
    ctx.clock.now += 10 * MINUTE;
    await ctx.sweep();
    const line = ctx.logs
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find((entry) => entry.event === 'audio_webhooks_missing');
    expect(line).toMatchObject({ level: 40, install_id: install.id });
    expect(JSON.stringify(line)).not.toContain('call_quiet');
  });

  it('a session never reported ended counts at most 2 hours, and frees its line', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '1' });
    const install = ctx.newInstall();
    await ctx.call(install.key, 'call_s');
    ctx.clock.now += 3 * 3600_000;
    expect((await ctx.start(install.key, 'call_t')).statusCode).toBe(201);
    expect(ctx.minutes(install.id)).toBe(120);
  });
});

describe('POST /v1/livekit/webhook', () => {
  it('a server that crashed without ending: room_finished frees the line and counts real minutes', async () => {
    const ctx = await setup({ RELAY_AUDIO_MAX_CONCURRENT: '1' });
    const install = ctx.newInstall();
    const room = await ctx.call(install.key, 'call_w');
    expect((await ctx.start(install.key, 'call_v')).statusCode).toBe(429);
    ctx.clock.now += 7 * MINUTE;
    expect((await ctx.roomFinished(room)).statusCode).toBe(200);
    expect(ctx.minutes(install.id)).toBe(7);
    expect((await ctx.start(install.key, 'call_v')).statusCode).toBe(201);
    // The server's late end report counts nothing more.
    expect((await ctx.end(install.key, room)).statusCode).toBe(204);
    expect(ctx.minutes(install.id)).toBe(7);
  });

  it('refuses an unsigned or wrongly signed webhook and ends nothing', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const { room } = relayAudioSessionResponseSchema.parse(
      (await ctx.start(install.key, 'call_s')).json(),
    );
    ctx.clock.now += 3 * MINUTE;
    const event = { event: 'room_finished', room: { name: room } };
    expect((await ctx.webhook(event, { unsigned: true })).statusCode).toBe(401);
    expect(
      (await ctx.webhook(event, { secret: 'another-secret-that-is-long-enough-0123' })).statusCode,
    ).toBe(401);
    expect(ctx.minutes(install.id)).toBe(0);
  });
});

describe('relay audio config', () => {
  it('needs the LiveKit settings only with audio on, and wss outside development', () => {
    const base = {
      RELAY_FREE_UNTIL: '2027-06-30',
      RELAY_ADMIN_TOKEN: 'admin-token-that-is-long-enough-0123456789',
    };
    expect(() => loadRelayEnv(base)).not.toThrow();
    expect(() => loadRelayEnv({ ...base, RELAY_AUDIO_ENABLED: 'true' })).toThrow(
      /RELAY_LIVEKIT_URL/,
    );
    expect(() =>
      loadRelayEnv({
        ...base,
        RELAY_ENV: 'staging',
        RELAY_PUBLIC_URL: 'https://relay.example.test',
        RELAY_RESEND_API_KEY: 'x',
        RELAY_AUDIO_ENABLED: 'true',
        ...LIVEKIT,
        RELAY_LIVEKIT_URL: 'ws://audio.twring.test',
      }),
    ).toThrow(/RELAY_LIVEKIT_URL: must be wss/);
  });
});

describe('deleting an install and keeping records 90 days', () => {
  const count = (ctx: Awaited<ReturnType<typeof setup>>, table: string, id: string) =>
    (
      ctx.db.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'installs' ? 'id' : 'install_id'} = ?`,
        )
        .get(id) as { n: number }
    ).n;

  it('DELETE /v1/installs/self removes the install, its phones, usage and audio records', async () => {
    const ctx = await setup();
    const mine = ctx.newInstall();
    const other = ctx.newInstall();
    const room = await ctx.call(mine.key, 'call-1');
    await ctx.call(other.key, 'call-2');
    ctx.db.sqlite
      .prepare(
        `INSERT INTO devices (id, install_id, device_ref, handle_hash, platform, created_at)
         VALUES ('d1', ?, 'ref', 'hash1', 'android', '2026-11-01')`,
      )
      .run(mine.id);
    ctx.db.sqlite
      .prepare(
        `INSERT INTO usage_daily (install_id, day, kind, count) VALUES (?, '2026-11-01', 'ring', 3)`,
      )
      .run(mine.id);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/installs/self',
      headers: { authorization: `Bearer ${mine.key}` },
    });
    expect(res.statusCode).toBe(204);
    for (const table of ['installs', 'devices', 'usage_daily', 'audio_sessions']) {
      expect(count(ctx, table, mine.id), table).toBe(0);
    }
    expect(ctx.deleted).toContain(room);
    expect(count(ctx, 'installs', other.id)).toBe(1);
    expect(count(ctx, 'audio_sessions', other.id)).toBe(1);
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/installs/self',
      headers: { authorization: `Bearer ${mine.key}` },
    });
    expect(again.statusCode).toBe(401);
  });

  it('the sweeper prunes ended call records after 90 days, not before', async () => {
    const ctx = await setup();
    const mine = ctx.newInstall();
    const room = await ctx.call(mine.key, 'call-1');
    await ctx.roomFinished(room);
    ctx.clock.now += 89 * 86_400_000;
    await ctx.sweep();
    expect(count(ctx, 'audio_sessions', mine.id)).toBe(1);
    ctx.clock.now += 2 * 86_400_000;
    await ctx.sweep();
    expect(count(ctx, 'audio_sessions', mine.id)).toBe(0);
  });
});

describe('relay admin deletes (privacy requests)', () => {
  const count = (ctx: Awaited<ReturnType<typeof setup>>, table: string, id: string) =>
    (
      ctx.db.sqlite
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'installs' ? 'id' : 'install_id'} = ?`,
        )
        .get(id) as { n: number }
    ).n;
  const ADMIN = { authorization: 'Bearer admin-token-that-is-long-enough-0123456789' };

  it('DELETE /v1/admin/installs/:id deletes like the server itself would, rooms included', async () => {
    const ctx = await setup();
    const mine = ctx.newInstall();
    const other = ctx.newInstall();
    const room = await ctx.call(mine.key, 'call-1');
    const denied = await ctx.app.inject({ method: 'DELETE', url: `/v1/admin/installs/${mine.id}` });
    expect(denied.statusCode).toBe(401);
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/installs/${mine.id}`,
      headers: ADMIN,
    });
    expect(res.statusCode).toBe(204);
    expect(count(ctx, 'installs', mine.id)).toBe(0);
    expect(count(ctx, 'audio_sessions', mine.id)).toBe(0);
    expect(ctx.deleted).toContain(room);
    expect(count(ctx, 'installs', other.id)).toBe(1);
    const missing = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/admin/installs/${mine.id}`,
      headers: ADMIN,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /v1/admin/installs/delete-by-email deletes every install of that address, any case, and its send records', async () => {
    const ctx = await setup();
    const a = ctx.newInstall();
    const b = ctx.newInstall();
    ctx.db.sqlite
      .prepare('UPDATE installs SET email = ? WHERE id = ?')
      .run('Other@example.com', b.id);
    const keep = ctx.newInstall();
    ctx.db.sqlite
      .prepare('UPDATE installs SET email = ? WHERE id = ?')
      .run('keep@example.com', keep.id);
    ctx.db.sqlite
      .prepare('INSERT INTO email_sends (address, sent_at) VALUES (?, ?)')
      .run(emailSendKey('owner@example.com'), START);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/installs/delete-by-email',
      payload: { email: 'owner@example.com' },
    });
    expect(denied.statusCode).toBe(401);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/installs/delete-by-email',
      headers: ADMIN,
      payload: { email: 'OWNER@Example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });
    expect(count(ctx, 'installs', a.id)).toBe(0);
    expect(count(ctx, 'installs', b.id)).toBe(1);
    expect(count(ctx, 'installs', keep.id)).toBe(1);
    const sends = ctx.db.sqlite
      .prepare('SELECT COUNT(*) AS n FROM email_sends WHERE address = ?')
      .get(emailSendKey('owner@example.com')) as { n: number };
    expect(sends.n).toBe(0);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/installs/delete-by-email',
      headers: ADMIN,
      payload: { email: 42 },
    });
    expect(bad.statusCode).toBe(400);
  });
});
