import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { Writable } from 'node:stream';

import { relayDeviceResponseSchema, serverIdFor } from '@twring/contracts';
import type { ApnsRequest, PushOptions, PushOutcome } from '@twring/push';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { loadRelayEnv } from './config';
import { openRelayDb } from './db';
import type { EmailSender } from './email';
import { InstallStore, UNVERIFIED_GRACE_MS } from './installs';
import { SEALED_MESSAGE_TEXT } from './push';
import { UsageStore } from './usage';

const START = Date.parse('2026-11-01T00:00:00.000Z');
const MINUTE = 60_000;
const BUNDLE = 'com.twring.app';
const ENVELOPE = { v: 1, n: 'N'.repeat(32), c: 'SECRETCIPHERTEXT'.repeat(3) };

const noEmail: EmailSender = { send: () => Promise.resolve('sent') };

interface FcmCall {
  token: string;
  data: Readonly<Record<string, string>>;
  options: PushOptions;
}

class FakeSenders {
  readonly fcmCalls: FcmCall[] = [];
  readonly apnsCalls: ApnsRequest[] = [];
  outcome: PushOutcome = 'sent';
  readonly senders = {
    fcm: (token: string, data: Readonly<Record<string, string>>, options: PushOptions) => {
      this.fcmCalls.push({ token, data, options });
      return Promise.resolve(this.outcome);
    },
    apns: {
      bundleId: BUNDLE,
      send: (request: ApnsRequest) => {
        this.apnsCalls.push(request);
        return Promise.resolve(this.outcome);
      },
    },
  };
  get calls(): number {
    return this.fcmCalls.length + this.apnsCalls.length;
  }
}

interface Server {
  privateKey: KeyObject;
  publicKey: string;
  serverId: string;
  installId: string;
  key: string;
}

async function setup(options: { withApns?: boolean } = {}) {
  const clock = { now: START };
  const logs: string[] = [];
  const env = loadRelayEnv({
    RELAY_FREE_UNTIL: '2027-06-30',
    RELAY_ADMIN_TOKEN: 'admin-token-that-is-long-enough-0123456789',
    LOG_LEVEL: 'trace',
  });
  const db = openRelayDb(':memory:');
  const fake = new FakeSenders();
  const app = await buildApp({
    env,
    db,
    email: noEmail,
    partners: [],
    now: () => clock.now,
    every: () => () => undefined,
    senders: options.withApns === false ? { fcm: fake.senders.fcm } : fake.senders,
    logStream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  });
  const installs = new InstallStore(db);
  const newServer = (options: { verified?: boolean; paidUntil?: string } = {}): Server => {
    const pair = generateKeyPairSync('ed25519');
    const x = pair.publicKey.export({ format: 'jwk' }).x!;
    const serverId = serverIdFor(Buffer.from(x, 'base64url'));
    const { install, key } = installs.create(
      {
        serverId,
        publicKey: x,
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
    return { privateKey: pair.privateKey, publicKey: x, serverId, installId: install.id, key };
  };
  return { app, db, clock, logs, fake, newServer };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

interface TicketOptions {
  iss?: string;
  aud?: string;
  exp?: number;
  jti?: string;
  sub?: string;
  signer?: KeyObject;
}

function ticketFor(ctx: Ctx, server: Server, options: TicketOptions = {}): Promise<string> {
  const now = Math.floor(ctx.clock.now / 1000);
  return new SignJWT({
    iss: options.iss ?? server.serverId,
    sub: options.sub ?? 'dev_phone1',
    aud: options.aud ?? 'twring-relay',
    exp: options.exp ?? now + 600,
    jti: options.jti ?? randomBytes(16).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .sign(options.signer ?? server.privateKey);
}

const ANDROID = { platform: 'android', fcm_token: 'fcm-token-android-0000001' };
const IOS = { platform: 'ios', voip_token: 'a1'.repeat(32), apns_token: 'b2'.repeat(32) };
const androidWith = (n: number) => ({
  platform: 'android',
  fcm_token: `fcm-token-android-${n}-xyz`,
});

function registerDevice(ctx: Ctx, ticket: string, tokens: Record<string, string> = ANDROID) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/devices',
    payload: { ticket, ...tokens },
  });
}

async function handleFor(
  ctx: Ctx,
  server: Server,
  tokens: Record<string, string> = ANDROID,
  sub?: string,
): Promise<string> {
  const response = await registerDevice(
    ctx,
    await ticketFor(ctx, server, sub === undefined ? {} : { sub }),
    tokens,
  );
  expect(response.statusCode).toBe(201);
  return relayDeviceResponseSchema.parse(response.json()).handle;
}

function push(ctx: Ctx, key: string, handle: string, overrides: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/push',
    headers: { authorization: `Bearer ${key}` },
    payload: {
      handle,
      kind: 'ring',
      sealed: ENVELOPE,
      ttl_seconds: 30,
      priority: 'high',
      ...overrides,
    },
  });
}

describe('POST /v1/devices', () => {
  it('registers a phone with a valid ticket and returns a handle stored only as a hash', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const response = await registerDevice(ctx, await ticketFor(ctx, server));
    expect(response.statusCode).toBe(201);
    const { handle } = relayDeviceResponseSchema.parse(response.json());
    expect(handle).toMatch(/^hnd_[A-Za-z0-9_-]{43}$/);
    const dump = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM devices').all());
    expect(dump).not.toContain(handle);
    expect(ctx.logs.join('')).not.toContain(handle);
    expect(ctx.logs.join('')).not.toContain(ANDROID.fcm_token);
  });

  it('refuses an expired ticket', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const ticket = await ticketFor(ctx, server);
    ctx.clock.now += 601_000;
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(401);
  });

  it('refuses a ticket that lives longer than 600 seconds', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const exp = Math.floor(ctx.clock.now / 1000) + 3600;
    expect((await registerDevice(ctx, await ticketFor(ctx, server, { exp }))).statusCode).toBe(401);
  });

  it('refuses a reused ticket', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const ticket = await ticketFor(ctx, server);
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(201);
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(401);
  });

  it('refuses a ticket signed by another key', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const other = ctx.newServer();
    const ticket = await ticketFor(ctx, server, { signer: other.privateKey });
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(401);
  });

  it('refuses a ticket from an unknown server', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const ticket = await ticketFor(ctx, server, { iss: `srv_${'b'.repeat(32)}` });
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(401);
  });

  it('refuses a ticket for another audience', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const ticket = await ticketFor(ctx, server, { aud: 'twring-relay/installs' });
    expect((await registerDevice(ctx, ticket)).statusCode).toBe(401);
  });

  it('refuses a ticket from a revoked server', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    new InstallStore(ctx.db).revoke(server.installId, ctx.clock.now);
    expect((await registerDevice(ctx, await ticketFor(ctx, server))).statusCode).toBe(401);
  });

  it('refuses tokens that do not match the platform', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const response = await registerDevice(ctx, await ticketFor(ctx, server), {
      platform: 'android',
      voip_token: 'v',
    });
    expect(response.statusCode).toBe(400);
  });

  it('replaces the earlier handle when the same phone registers again', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const first = await handleFor(ctx, server);
    const second = await handleFor(ctx, server);
    expect((await push(ctx, server.key, first)).json()).toEqual({ outcome: 'invalid' });
    expect((await push(ctx, server.key, second)).json()).toEqual({ outcome: 'sent' });
  });
});

describe('POST /v1/push', () => {
  it('needs a relay key', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    expect((await push(ctx, 'twr_wrong', handle)).statusCode).toBe(401);
    expect(ctx.fake.calls).toBe(0);
  });

  it('answers invalid for a handle of another install and never sends', async () => {
    const ctx = await setup();
    const a = ctx.newServer();
    const b = ctx.newServer();
    const handle = await handleFor(ctx, a);
    const response = await push(ctx, b.key, handle);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ outcome: 'invalid' });
    expect(ctx.fake.calls).toBe(0);
  });

  it('answers invalid for an unknown handle', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const response = await push(ctx, server.key, `hnd_${'x'.repeat(43)}`);
    expect(response.statusCode).toBe(404);
    expect(ctx.fake.calls).toBe(0);
  });

  it('answers paused for an install unconfirmed for more than 7 days, without sending', async () => {
    const ctx = await setup();
    const server = ctx.newServer({ verified: false });
    const handle = await handleFor(ctx, server);
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'sent' });
    ctx.clock.now += UNVERIFIED_GRACE_MS + 1;
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'paused' });
    expect(ctx.fake.calls).toBe(1);
  });

  it('answers expired after paid_until, without sending', async () => {
    const ctx = await setup();
    const server = ctx.newServer({ paidUntil: '2026-11-02T00:00:00.000Z' });
    const handle = await handleFor(ctx, server);
    ctx.clock.now = Date.parse('2026-11-02T00:00:00.000Z');
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'expired' });
    expect(ctx.fake.calls).toBe(0);
  });

  it('limits one handle to 10 pushes a minute', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    for (let i = 0; i < 10; i += 1) {
      expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'sent' });
    }
    const limited = await push(ctx, server.key, handle);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ outcome: 'limited' });
    expect(ctx.fake.calls).toBe(10);
    ctx.clock.now += MINUTE;
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'sent' });
  });

  it('limits one install to 60 pushes a minute and 2000 a day', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handles: string[] = [];
    for (let i = 0; i < 7; i += 1)
      handles.push(await handleFor(ctx, server, androidWith(i), `dev_${i}`));
    for (let i = 0; i < 60; i += 1) {
      expect((await push(ctx, server.key, handles[i % 6]!)).json()).toEqual({ outcome: 'sent' });
    }
    expect((await push(ctx, server.key, handles[6]!)).json()).toEqual({ outcome: 'limited' });

    let sent = 60;
    while (sent < 2000) {
      ctx.clock.now += MINUTE;
      for (let i = 0; i < 60 && sent < 2000; i += 1, sent += 1) {
        expect((await push(ctx, server.key, handles[i % 6]!)).json()).toEqual({ outcome: 'sent' });
      }
    }
    ctx.clock.now += MINUTE;
    expect((await push(ctx, server.key, handles[6]!)).json()).toEqual({ outcome: 'limited' });
    expect(ctx.fake.calls).toBe(2000);
  }, 60_000);

  it('rings an Android phone as a high-priority FCM data push with the sealed envelope', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    await push(ctx, server.key, handle, { ttl_seconds: 30 });
    expect(ctx.fake.fcmCalls).toEqual([
      {
        token: ANDROID.fcm_token,
        data: { type: 'cord.sealed', kind: 'ring', sealed: JSON.stringify(ENVELOPE) },
        options: { priority: 'high', ttlSeconds: 30 },
      },
    ]);
  });

  it('rings an iPhone through PushKit with its VoIP token', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server, IOS);
    await push(ctx, server.key, handle);
    expect(ctx.fake.apnsCalls).toEqual([
      {
        token: IOS.voip_token,
        pushType: 'voip',
        topic: `${BUNDLE}.voip`,
        priority: 10,
        ttlSeconds: 30,
        body: { type: 'cord.sealed', kind: 'ring', sealed: JSON.stringify(ENVELOPE) },
      },
    ]);
  });

  it('shows an iPhone message as an alert with fixed text and the envelope in custom data', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server, IOS);
    await push(ctx, server.key, handle, { kind: 'message', ttl_seconds: 3600 });
    const [request] = ctx.fake.apnsCalls;
    expect(request).toMatchObject({
      token: IOS.apns_token,
      pushType: 'alert',
      topic: BUNDLE,
      priority: 10,
      ttlSeconds: 3600,
      body: {
        aps: { alert: { body: SEALED_MESSAGE_TEXT }, 'mutable-content': 1 },
        type: 'cord.sealed',
        kind: 'message',
        sealed: JSON.stringify(ENVELOPE),
      },
    });
    expect(SEALED_MESSAGE_TEXT).toBe('New message on your Twring server.');
  });

  it('marks the handle stale when the push service says the token is gone', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    ctx.fake.outcome = 'invalid';
    const first = await push(ctx, server.key, handle);
    expect(first.statusCode).toBe(404);
    expect(first.json()).toEqual({ outcome: 'invalid' });
    ctx.fake.outcome = 'sent';
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'invalid' });
    expect(ctx.fake.calls).toBe(1);
  });

  it('answers 503 when the push service fails, without marking the handle stale', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    ctx.fake.outcome = 'failed';
    expect((await push(ctx, server.key, handle)).statusCode).toBe(503);
    ctx.fake.outcome = 'sent';
    expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'sent' });
  });

  it('counts usage per install per day by kind and stores or logs no contents', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    await push(ctx, server.key, handle);
    await push(ctx, server.key, handle, { kind: 'message' });
    await push(ctx, server.key, handle, { kind: 'message' });
    expect(new UsageStore(ctx.db).forDay(server.installId, '2026-11-01')).toEqual({
      ring: 1,
      message: 2,
    });
    const tables = ['devices', 'usage_daily', 'tickets_used', 'installs'];
    const dump = tables
      .map((t) => JSON.stringify(ctx.db.sqlite.prepare(`SELECT * FROM ${t}`).all()))
      .join('');
    expect(dump).not.toContain('SECRETCIPHERTEXT');
    const logs = ctx.logs.join('');
    expect(logs).not.toContain('SECRETCIPHERTEXT');
    expect(logs).not.toContain(handle);
    expect(logs).not.toContain(ANDROID.fcm_token);
    expect(logs).not.toContain(server.key);
  });
});

describe('DELETE /v1/devices/:handle', () => {
  it('forgets a phone of the caller only', async () => {
    const ctx = await setup();
    const a = ctx.newServer();
    const b = ctx.newServer();
    const handle = await handleFor(ctx, a);
    const remove = (key: string) =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/v1/devices/${handle}`,
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await remove(b.key)).statusCode).toBe(404);
    expect((await push(ctx, a.key, handle)).json()).toEqual({ outcome: 'sent' });
    expect((await remove(a.key)).statusCode).toBe(204);
    expect((await push(ctx, a.key, handle)).json()).toEqual({ outcome: 'invalid' });
    expect(ctx.logs.join('')).not.toContain(handle);
  });
});

describe('fix round 1', () => {
  it('answers unsupported for kinds a phone cannot get, without spending any budget', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server, { platform: 'ios', voip_token: IOS.voip_token });
    for (let i = 0; i < 12; i += 1) {
      const response = await push(ctx, server.key, handle, {
        kind: i % 2 === 0 ? 'ring_cancel' : 'message',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: 'unsupported' });
    }
    expect(ctx.fake.calls).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      expect((await push(ctx, server.key, handle)).json()).toEqual({ outcome: 'sent' });
    }
    expect(ctx.fake.calls).toBe(10);
  });

  it('answers unsupported when the relay has no service for the platform', async () => {
    const ctx = await setup({ withApns: false });
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server, IOS);
    const response = await push(ctx, server.key, handle);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'unsupported' });
  });

  it('answers unsupported when the push service skips the phone', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handle = await handleFor(ctx, server);
    ctx.fake.outcome = 'skipped';
    const response = await push(ctx, server.key, handle);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'unsupported' });
  });

  it('a noisy handle does not spend the install budget', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const handles: string[] = [];
    for (let i = 0; i < 7; i += 1)
      handles.push(await handleFor(ctx, server, androidWith(i), `dev_${i}`));
    for (let i = 0; i < 40; i += 1) await push(ctx, server.key, handles[0]!);
    expect(ctx.fake.calls).toBe(10);
    for (let i = 0; i < 50; i += 1) {
      expect((await push(ctx, server.key, handles[1 + (i % 5)]!)).json()).toEqual({
        outcome: 'sent',
      });
    }
    expect((await push(ctx, server.key, handles[6]!)).json()).toEqual({ outcome: 'limited' });
  });

  it('two phones with one token share its 10 a minute', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const one = await handleFor(ctx, server, ANDROID, 'dev_a');
    const two = await handleFor(ctx, server, ANDROID, 'dev_b');
    for (let i = 0; i < 10; i += 1) await push(ctx, server.key, i % 2 === 0 ? one : two);
    expect((await push(ctx, server.key, two)).json()).toEqual({ outcome: 'limited' });
    expect(ctx.fake.calls).toBe(10);
  });

  it('a token registered by another install moves there', async () => {
    const ctx = await setup();
    const a = ctx.newServer();
    const b = ctx.newServer();
    const handleA = await handleFor(ctx, a);
    const handleB = await handleFor(ctx, b);
    expect((await push(ctx, a.key, handleA)).json()).toEqual({ outcome: 'invalid' });
    expect((await push(ctx, b.key, handleB)).json()).toEqual({ outcome: 'sent' });
  });

  it('refuses malformed tokens', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    for (const tokens of [
      { platform: 'ios', voip_token: '../../../etc/passwd' } as Record<string, string>,
      { platform: 'android', fcm_token: 'bad token with spaces 123' },
    ]) {
      expect((await registerDevice(ctx, await ticketFor(ctx, server), tokens)).statusCode).toBe(
        400,
      );
    }
  });

  it('caps a ring at 60 seconds and keeps other kinds as asked', async () => {
    const ctx = await setup();
    const server = ctx.newServer();
    const android = await handleFor(ctx, server, ANDROID, 'dev_a');
    const ios = await handleFor(ctx, server, IOS, 'dev_i');
    await push(ctx, server.key, android, { ttl_seconds: 600 });
    await push(ctx, server.key, ios, { ttl_seconds: 600 });
    await push(ctx, server.key, android, { kind: 'message', ttl_seconds: 600 });
    expect(ctx.fake.fcmCalls.map((c) => c.options.ttlSeconds)).toEqual([60, 600]);
    expect(ctx.fake.apnsCalls[0]!.ttlSeconds).toBe(60);
  });
});
