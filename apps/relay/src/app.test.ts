import { createHash, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  errorResponseSchema,
  relayInstallProofClaims,
  relayInstallResponseSchema,
  relayStatusResponseSchema,
  serverIdFor,
} from '@twring/contracts';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp, rateKeyFor } from './app';
import { FixedWindowLimiter } from './rate-limit';
import { loadRelayEnv } from './config';
import { openRelayDb, type RelayDb } from './db';
import type { EmailMessage, EmailSender } from './email';
import { loadPartners, type Partner } from './installs';

const ADMIN_TOKEN = 'admin-token-that-is-long-enough-0123456789';
const PARTNER_TOKEN = 'partner-secret-token-abc';
const DAY = 86_400_000;
const START = Date.parse('2026-11-01T00:00:00.000Z');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class FakeEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];
  result: 'sent' | 'retry' | 'rejected' = 'sent';
  send(message: EmailMessage) {
    if (this.result === 'sent') this.sent.push(message);
    return Promise.resolve(this.result);
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface Server {
  privateKey: KeyObject;
  publicKey: string;
  serverId: string;
}

function newServer(): Server {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x!, 'base64url');
  return { privateKey: pair.privateKey, publicKey: jwk.x!, serverId: serverIdFor(raw) };
}

interface ProofOptions {
  lifetimeSeconds?: number;
  aud?: string;
  jti?: string | null;
}

async function proofFor(
  server: Server,
  claims: { server_id: string; email: string; news?: boolean; address?: string },
  at: number,
  options: ProofOptions = {},
): Promise<string> {
  const iat = Math.floor(at / 1000);
  const base = relayInstallProofClaims(
    { news: false, ...claims },
    { jti: options.jti ?? randomBytes(16).toString('base64url'), nowSeconds: iat },
  );
  const payload: Record<string, unknown> = {
    ...base,
    exp: iat + (options.lifetimeSeconds ?? 300),
    ...(options.aud !== undefined && { aud: options.aud }),
  };
  if (options.jti === null) delete payload.jti;
  return new SignJWT(payload).setProtectedHeader({ alg: 'EdDSA' }).sign(server.privateKey);
}

async function setup(
  options: { partners?: Partner[]; db?: RelayDb; env?: Record<string, string> } = {},
) {
  const clock = { now: START };
  const email = new FakeEmail();
  const logs: string[] = [];
  const timers: (() => Promise<void>)[] = [];
  const env = loadRelayEnv({
    RELAY_FREE_UNTIL: '2027-06-30',
    RELAY_ADMIN_TOKEN: ADMIN_TOKEN,
    RELAY_PUBLIC_URL: 'https://relay.example.test',
    LOG_LEVEL: 'trace',
    ...options.env,
  });
  const db = options.db ?? openRelayDb(':memory:');
  const app = await buildApp({
    env,
    db,
    email,
    now: () => clock.now,
    partners: options.partners ?? [],
    every: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
    logStream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(chunk.toString());
        done();
      },
    }),
  });
  const tick = async () => {
    for (const run of timers) await run();
  };
  return { app, db, email, logs, clock, tick };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function register(
  ctx: Ctx,
  server: Server,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
) {
  const emailAddress = (overrides.email as string | undefined) ?? 'owner@example.com';
  const news = (overrides.news as boolean | undefined) ?? false;
  const address = overrides.address as string | undefined;
  const proof =
    (overrides.proof as string | undefined) ??
    (await proofFor(
      server,
      {
        server_id: server.serverId,
        email: emailAddress,
        news,
        ...(address !== undefined && { address }),
      },
      ctx.clock.now,
    ));
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/installs',
    headers,
    remoteAddress,
    payload: {
      email: emailAddress,
      news,
      server_id: server.serverId,
      public_key: server.publicKey,
      ...overrides,
      proof,
    },
  });
}

function status(ctx: Ctx, key: string) {
  return ctx.app.inject({
    method: 'GET',
    url: '/v1/status',
    headers: { authorization: `Bearer ${key}` },
  });
}

function confirm(ctx: Ctx, token: string) {
  return ctx.app.inject({
    method: 'POST',
    url: '/v1/installs/verify',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: `t=${encodeURIComponent(token)}`,
  });
}

function linkToken(message: EmailMessage): string {
  const match = /https:\/\/relay\.example\.test\/v1\/installs\/verify\?t=([A-Za-z0-9_-]+)/.exec(
    message.text,
  );
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('POST /v1/installs', () => {
  it('returns a twr_ key once and stores only its hash', async () => {
    const ctx = await setup();
    const server = newServer();
    const response = await register(ctx, server);
    expect(response.statusCode).toBe(201);
    const body = relayInstallResponseSchema.parse(response.json());
    expect(body.relay_key).toMatch(/^twr_[A-Za-z0-9_-]{43}$/);
    expect(body.verified).toBe(false);

    const rows = ctx.db.sqlite.prepare('SELECT * FROM installs').all();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(body.relay_key);
    expect(dump).not.toContain(body.relay_key.slice(4));
    expect(dump).toContain(sha256Hex(body.relay_key));
    // Status works with the key: it is shown once and usable.
    expect((await status(ctx, body.relay_key)).statusCode).toBe(200);
  });

  it('paid_until comes from RELAY_FREE_UNTIL', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    expect(body.paid_until).toBe('2027-06-30T00:00:00.000Z');
  });

  it('rejects an invalid email with 400', async () => {
    const ctx = await setup();
    const response = await register(ctx, newServer(), { email: 'not-an-email' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a server id that does not belong to the public key', async () => {
    const ctx = await setup();
    const server = newServer();
    const other = newServer();
    const proof = await proofFor(
      server,
      { server_id: other.serverId, email: 'owner@example.com' },
      ctx.clock.now,
    );
    const response = await register(ctx, server, { server_id: other.serverId, proof });
    expect(response.statusCode).toBe(400);
    expect(ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM installs').get()).toEqual({ n: 0 });
  });

  it('rejects a proof signed by another key', async () => {
    const ctx = await setup();
    const server = newServer();
    const thief = newServer();
    const proof = await proofFor(
      thief,
      { server_id: server.serverId, email: 'owner@example.com' },
      ctx.clock.now,
    );
    const response = await register(ctx, server, { proof });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a proof over another email or server id', async () => {
    const ctx = await setup();
    const server = newServer();
    const proof = await proofFor(
      server,
      { server_id: server.serverId, email: 'someone-else@example.com' },
      ctx.clock.now,
    );
    expect((await register(ctx, server, { proof })).statusCode).toBe(401);
  });

  it('rejects an expired proof and one that lives too long', async () => {
    const ctx = await setup();
    const server = newServer();
    const claims = { server_id: server.serverId, email: 'owner@example.com' };
    const old = await proofFor(server, claims, ctx.clock.now - 3_600_000);
    expect((await register(ctx, server, { proof: old })).statusCode).toBe(401);
    const forever = await proofFor(server, claims, ctx.clock.now, { lifetimeSeconds: 30 * 86_400 });
    expect((await register(ctx, server, { proof: forever })).statusCode).toBe(401);
  });

  it('a second registration for a server id signed by another key is 409 and changes nothing', async () => {
    const ctx = await setup();
    const server = newServer();
    const first = relayInstallResponseSchema.parse((await register(ctx, server)).json());
    const before = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM installs').all());

    // Same server id and email, but a different public key and a proof by that key.
    const other = newServer();
    const proof = await proofFor(
      other,
      { server_id: server.serverId, email: 'owner@example.com' },
      ctx.clock.now,
    );
    // The id must match the key, so this is refused before the duplicate check...
    const forged = await register(ctx, server, { public_key: other.publicKey, proof });
    expect([400, 409]).toContain(forged.statusCode);
    expect(JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM installs').all())).toBe(before);
    expect((await status(ctx, first.relay_key)).statusCode).toBe(200);
  });

  it('a stored install with another key answers 409 to a valid new registration', async () => {
    const ctx = await setup();
    const server = newServer();
    await register(ctx, server);
    // Simulate an install row whose key differs (e.g. a key rotated by hand).
    ctx.db.sqlite
      .prepare('UPDATE installs SET public_key = ? WHERE server_id = ?')
      .run(newServer().publicKey, server.serverId);
    const before = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM installs').all());
    const response = await register(ctx, server);
    expect(response.statusCode).toBe(409);
    expect(JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM installs').all())).toBe(before);
  });

  it('the same server re-registering gets a new key; the old key stops working', async () => {
    const ctx = await setup();
    const server = newServer();
    const first = relayInstallResponseSchema.parse((await register(ctx, server)).json());
    const second = await register(ctx, server);
    expect(second.statusCode).toBe(201);
    const body = relayInstallResponseSchema.parse(second.json());
    expect(body.install_id).toBe(first.install_id);
    expect(body.relay_key).not.toBe(first.relay_key);
    expect((await status(ctx, first.relay_key)).statusCode).toBe(401);
    expect((await status(ctx, body.relay_key)).statusCode).toBe(200);
  });

  it('is limited to 5 per hour per address', async () => {
    const ctx = await setup();
    for (let i = 0; i < 5; i += 1) {
      expect((await register(ctx, newServer())).statusCode).toBe(201);
    }
    expect((await register(ctx, newServer())).statusCode).toBe(429);
    ctx.clock.now += 3_600_000;
    expect((await register(ctx, newServer())).statusCode).toBe(201);
  });

  it('logs neither the key nor the email nor the proof', async () => {
    const ctx = await setup();
    const server = newServer();
    const response = await register(ctx, server, { email: 'secret.person@example.com' });
    const body = relayInstallResponseSchema.parse(response.json());
    const token = linkToken(ctx.email.sent[0]!);
    await status(ctx, body.relay_key);
    await confirm(ctx, token);
    const logs = ctx.logs.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(body.relay_key);
    expect(logs).not.toContain('secret.person');
    expect(logs).not.toContain(token);
  });
});

describe('partners', () => {
  const partners: Partner[] = [{ id: 'acme', tokenHash: sha256Hex(PARTNER_TOKEN) }];

  it('stores the partner id from a valid partner credential', async () => {
    const ctx = await setup({ partners });
    const server = newServer();
    const response = await register(ctx, server, {}, { authorization: `Partner ${PARTNER_TOKEN}` });
    expect(response.statusCode).toBe(201);
    expect(ctx.db.sqlite.prepare('SELECT partner_id FROM installs').get()).toEqual({
      partner_id: 'acme',
    });
  });

  it('an unknown partner credential is 401', async () => {
    const ctx = await setup({ partners });
    const response = await register(ctx, newServer(), {}, { authorization: 'Partner wrong' });
    expect(response.statusCode).toBe(401);
    expect(ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM installs').get()).toEqual({ n: 0 });
  });

  it('no partner header leaves partner_id null, even if the body names one', async () => {
    const ctx = await setup({ partners });
    await register(ctx, newServer(), { partner_id: 'acme' });
    expect(ctx.db.sqlite.prepare('SELECT partner_id FROM installs').get()).toEqual({
      partner_id: null,
    });
  });

  it('loads partners from a file of hashed tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twring-relay-'));
    dirs.push(dir);
    const file = join(dir, 'partners.json');
    await writeFile(file, JSON.stringify([{ id: 'acme', token_sha256: sha256Hex(PARTNER_TOKEN) }]));
    expect(await loadPartners(file)).toEqual(partners);
  });
});

describe('verification and status', () => {
  it('sends a plain verification email with a single-use link', async () => {
    const ctx = await setup();
    const response = await register(ctx, newServer(), { news: true });
    const body = relayInstallResponseSchema.parse(response.json());
    expect(ctx.email.sent).toHaveLength(1);
    const message = ctx.email.sent[0]!;
    expect(message.to).toBe('owner@example.com');
    expect(message.subject).toBe('Confirm your Twring server');
    expect(message.text).toContain('product news');
    const words = message.text.replace(/https:\/\/\S+/, '');
    expect(words).not.toMatch(/relay|token|gateway/i);
    expect(words).not.toContain(String.fromCharCode(0x2014));
    const token = linkToken(message);
    // Only the hash of the link token is stored.
    const dump = JSON.stringify(ctx.db.sqlite.prepare('SELECT * FROM installs').all());
    expect(dump).not.toContain(token);

    const first = await confirm(ctx, token);
    expect(first.statusCode).toBe(200);
    const after = relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json());
    expect(after).toMatchObject({ state: 'active', verified: true });
    expect(
      ctx.db.sqlite.prepare('SELECT verified_at FROM installs').get() as { verified_at: string },
    ).toEqual({ verified_at: new Date(START).toISOString() });

    const again = await confirm(ctx, token);
    expect(again.statusCode).toBe(400);
  });

  it('without news consent the email does not mention product news', async () => {
    const ctx = await setup();
    await register(ctx, newServer());
    expect(ctx.email.sent[0]!.text).not.toContain('product news');
  });

  it('an unknown or expired link is refused', async () => {
    const ctx = await setup();
    await register(ctx, newServer());
    const token = linkToken(ctx.email.sent[0]!);
    expect((await confirm(ctx, 'nope')).statusCode).toBe(400);
    ctx.clock.now += 7 * DAY + 1;
    expect((await confirm(ctx, token)).statusCode).toBe(400);
  });

  it('status: unverified within 7 days, paused after, expired after paid_until', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    const read = async () =>
      relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json());
    expect(await read()).toEqual({
      state: 'unverified',
      paid_until: '2027-06-30T00:00:00.000Z',
      verified: false,
    });
    ctx.clock.now = START + 7 * DAY - 1;
    expect((await read()).state).toBe('unverified');
    ctx.clock.now = START + 7 * DAY;
    expect((await read()).state).toBe('paused');
    ctx.clock.now = Date.parse('2027-06-30T00:00:00.000Z');
    expect((await read()).state).toBe('expired');
  });

  it('a verified install is expired after paid_until', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    const token = linkToken(ctx.email.sent[0]!);
    await confirm(ctx, token);
    ctx.clock.now = Date.parse('2027-07-01T00:00:00.000Z');
    const after = relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json());
    expect(after).toMatchObject({ state: 'expired', verified: true });
  });

  it('status without a key or with an unknown key is 401', async () => {
    const ctx = await setup();
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/status' })).statusCode).toBe(401);
    expect((await status(ctx, `twr_${'A'.repeat(43)}`)).statusCode).toBe(401);
  });
});

describe('admin revoke', () => {
  async function revoke(ctx: Ctx, id: string, token: string | undefined) {
    return ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/installs/${id}/revoke`,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it('a revoked key answers 401', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    expect((await revoke(ctx, body.install_id, ADMIN_TOKEN)).statusCode).toBe(200);
    expect((await status(ctx, body.relay_key)).statusCode).toBe(401);
  });

  it('a revoked install cannot register again to get a fresh key', async () => {
    const ctx = await setup();
    const server = newServer();
    const body = relayInstallResponseSchema.parse((await register(ctx, server)).json());
    await revoke(ctx, body.install_id, ADMIN_TOKEN);
    expect((await register(ctx, server)).statusCode).toBe(403);
  });

  it('needs the admin token', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    expect((await revoke(ctx, body.install_id, undefined)).statusCode).toBe(401);
    expect((await revoke(ctx, body.install_id, `${ADMIN_TOKEN}x`)).statusCode).toBe(401);
    expect((await revoke(ctx, body.install_id, body.relay_key)).statusCode).toBe(401);
    expect((await status(ctx, body.relay_key)).statusCode).toBe(200);
  });

  it('an unknown install is 404', async () => {
    const ctx = await setup();
    expect((await revoke(ctx, 'ins_nope', ADMIN_TOKEN)).statusCode).toBe(404);
  });
});

describe('fix round 1: single-use proofs', () => {
  it('a replayed registration from another address is refused and the real key keeps working', async () => {
    const ctx = await setup();
    const server = newServer();
    const proof = await proofFor(
      server,
      { server_id: server.serverId, email: 'owner@example.com' },
      ctx.clock.now,
    );
    const first = relayInstallResponseSchema.parse((await register(ctx, server, { proof })).json());
    const replay = await register(ctx, server, { proof }, {}, '203.0.113.9');
    expect(replay.statusCode).toBe(401);
    expect((await status(ctx, first.relay_key)).statusCode).toBe(200);
  });

  it('refuses a proof without jti or with another audience', async () => {
    const ctx = await setup();
    const server = newServer();
    const claims = { server_id: server.serverId, email: 'owner@example.com' };
    const noJti = await proofFor(server, claims, ctx.clock.now, { jti: null });
    expect((await register(ctx, server, { proof: noJti })).statusCode).toBe(401);
    const otherAud = await proofFor(server, claims, ctx.clock.now, { aud: 'twring-relay' });
    expect((await register(ctx, server, { proof: otherAud })).statusCode).toBe(401);
  });

  it('news and address are signed: changing either breaks the proof', async () => {
    const ctx = await setup();
    const server = newServer();
    const claims = { server_id: server.serverId, email: 'owner@example.com', news: false };
    const proof = await proofFor(server, { ...claims, address: 'a.example' }, ctx.clock.now);
    expect(
      (await register(ctx, server, { proof, news: true, address: 'a.example' })).statusCode,
    ).toBe(401);
    expect((await register(ctx, server, { proof, address: 'b.example' })).statusCode).toBe(401);
    expect((await register(ctx, server, { proof })).statusCode).toBe(401);
    expect((await register(ctx, server, { proof, address: 'a.example' })).statusCode).toBe(201);
  });

  it('used proof ids are forgotten after they expire', async () => {
    const ctx = await setup();
    await register(ctx, newServer());
    const count = () =>
      (ctx.db.sqlite.prepare('SELECT COUNT(*) AS n FROM proofs_used').get() as { n: number }).n;
    expect(count()).toBe(1);
    ctx.clock.now += 3_600_001;
    await register(ctx, newServer());
    expect(count()).toBe(1);
  });

  it('refuses a public key that is not in canonical form', async () => {
    const ctx = await setup();
    const server = newServer();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(server.publicKey.at(-1)!);
    const variant = server.publicKey.slice(0, -1) + alphabet[last ^ 1]!;
    expect(
      Buffer.from(variant, 'base64url').equals(Buffer.from(server.publicKey, 'base64url')),
    ).toBe(true);
    expect((await register(ctx, server, { public_key: variant })).statusCode).toBe(400);
  });
});

describe('fix round 1: fair limits', () => {
  it('groups IPv6 addresses by /64', async () => {
    const ctx = await setup();
    for (let i = 1; i <= 5; i += 1) {
      expect((await register(ctx, newServer(), {}, {}, `2001:db8::${i}`)).statusCode).toBe(201);
    }
    expect((await register(ctx, newServer(), {}, {}, '2001:db8::ffff:1')).statusCode).toBe(429);
    expect((await register(ctx, newServer(), {}, {}, '2001:db8:0:1::1')).statusCode).toBe(201);
  });

  it('a full limiter evicts the oldest client instead of refusing everyone', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 0, 2);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('b')).toBe(true);
    expect(limiter.tryAcquire('c')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
  });

  it('caps new installs per hour across all addresses', async () => {
    const ctx = await setup({ env: { RELAY_INSTALLS_PER_HOUR: '3' } });
    for (let i = 1; i <= 3; i += 1) {
      expect((await register(ctx, newServer(), {}, {}, `198.51.100.${i}`)).statusCode).toBe(201);
    }
    const capped = await register(ctx, newServer(), {}, {}, '198.51.100.4');
    expect(capped.statusCode).toBe(429);
    expect(errorResponseSchema.parse(capped.json()).error.message).toMatch(/try again/i);
  });

  it('rate keys: IPv4 full address, IPv6 /64, mapped IPv4 as IPv4', () => {
    expect(rateKeyFor('198.51.100.7')).toBe('ip:198.51.100.7');
    expect(rateKeyFor('2001:db8:1:2:3:4:5:6')).toBe('ip6:2001:db8:1:2');
    expect(rateKeyFor('2001:DB8::1')).toBe('ip6:2001:db8:0:0');
    expect(rateKeyFor('::ffff:198.51.100.7')).toBe('ip:198.51.100.7');
  });
});

describe('fix round 1: safe email', () => {
  it('sends at most 3 emails per address per day, matching the domain in any case', async () => {
    const ctx = await setup();
    const addresses = [
      'victim@example.com',
      'victim@EXAMPLE.com',
      'victim@Example.COM',
      'victim@example.com',
    ];
    for (const [i, email] of addresses.entries()) {
      expect((await register(ctx, newServer(), { email }, {}, `198.51.100.${i}`)).statusCode).toBe(
        201,
      );
    }
    expect(ctx.email.sent).toHaveLength(3);
    const stored = ctx.db.sqlite.prepare('SELECT DISTINCT email FROM installs').all();
    expect(stored).toEqual([{ email: 'victim@example.com' }]);
  });

  it('holds emails past the daily cap and sends them later', async () => {
    const ctx = await setup({ env: { RELAY_EMAILS_PER_DAY: '1' } });
    await register(ctx, newServer(), { email: 'a@example.com' });
    await register(ctx, newServer(), { email: 'b@example.com' });
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['a@example.com']);
    await ctx.tick();
    expect(ctx.email.sent).toHaveLength(1);
    ctx.clock.now += DAY;
    await ctx.tick();
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['a@example.com', 'b@example.com']);
    expect((await confirm(ctx, linkToken(ctx.email.sent[1]!))).statusCode).toBe(200);
  });

  it('retries a link the email service could not take, until sent', async () => {
    const ctx = await setup();
    ctx.email.result = 'retry';
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    expect(ctx.email.sent).toHaveLength(0);
    await ctx.tick();
    ctx.email.result = 'sent';
    await ctx.tick();
    expect(ctx.email.sent).toHaveLength(1);
    await ctx.tick();
    expect(ctx.email.sent).toHaveLength(1);
    await confirm(ctx, linkToken(ctx.email.sent[0]!));
    const after = relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json());
    expect(after.verified).toBe(true);
  });

  it('gives up on a held email once the install is past its 7 days', async () => {
    const ctx = await setup();
    ctx.email.result = 'retry';
    await register(ctx, newServer());
    ctx.email.result = 'sent';
    ctx.clock.now += 7 * DAY + 1;
    await ctx.tick();
    expect(ctx.email.sent).toHaveLength(0);
  });

  it('re-registering an unverified install sends no new email within an hour', async () => {
    const ctx = await setup();
    const server = newServer();
    await register(ctx, server);
    await register(ctx, server);
    expect(ctx.email.sent).toHaveLength(1);
    ctx.clock.now += 3_600_001;
    await register(ctx, server);
    expect(ctx.email.sent).toHaveLength(2);
  });

  it('uses RELAY_RESEND_API_KEY, not RESEND_API_KEY', () => {
    const base = { RELAY_FREE_UNTIL: '2027-06-30', RELAY_ADMIN_TOKEN: ADMIN_TOKEN };
    const env = loadRelayEnv({ ...base, RELAY_RESEND_API_KEY: 're_x' });
    expect(env.RELAY_RESEND_API_KEY).toBe('re_x');
    expect('RESEND_API_KEY' in loadRelayEnv({ ...base, RESEND_API_KEY: 're_x' })).toBe(false);
  });
});

describe('fix round 1: email link needs a click', () => {
  it('GET and HEAD show a confirm page without confirming', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    const token = linkToken(ctx.email.sent[0]!);
    const verified = async () =>
      relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json()).verified;
    const page = await ctx.app.inject({ method: 'GET', url: `/v1/installs/verify?t=${token}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<form method="post" action="/v1/installs/verify">');
    expect(page.body).toContain('Confirm');
    await ctx.app.inject({ method: 'HEAD', url: `/v1/installs/verify?t=${token}` });
    expect(await verified()).toBe(false);
    expect((await confirm(ctx, token)).statusCode).toBe(200);
    expect(await verified()).toBe(true);
  });

  it('never renders a value that is not a well-formed link code', async () => {
    const ctx = await setup();
    const page = await ctx.app.inject({
      method: 'GET',
      url: `/v1/installs/verify?t=${encodeURIComponent('"><script>x</script>')}`,
    });
    expect(page.body).not.toContain('<script>');
    expect(page.body).not.toContain('<form');
  });

  it('a mistyped link path answers 404 and does not log the code', async () => {
    const ctx = await setup();
    await register(ctx, newServer());
    const token = linkToken(ctx.email.sent[0]!);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/v1/installs/verify/?t=${token}`,
    });
    expect(response.statusCode).toBe(404);
    expect(ctx.logs.join('')).not.toContain(token);
  });
});

describe('fix round 2: email grace counts from the request', () => {
  const state = async (ctx: Ctx, key: string) =>
    relayStatusResponseSchema.parse((await status(ctx, key)).json()).state;

  it('a verified install that changes its address on day 30 gets an email and a fresh grace', async () => {
    const ctx = await setup();
    const server = newServer();
    await register(ctx, server);
    await confirm(ctx, linkToken(ctx.email.sent[0]!));
    ctx.clock.now += 30 * DAY;
    const body = relayInstallResponseSchema.parse(
      (await register(ctx, server, { email: 'new@example.com' })).json(),
    );
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['owner@example.com', 'new@example.com']);
    expect(await state(ctx, body.relay_key)).toBe('unverified');
    ctx.clock.now += 7 * DAY - 1;
    expect(await state(ctx, body.relay_key)).toBe('unverified');
    ctx.clock.now += 1;
    expect(await state(ctx, body.relay_key)).toBe('paused');
  });

  it('an unverified install that re-registers on day 8 gets a new email', async () => {
    const ctx = await setup();
    const server = newServer();
    await register(ctx, server);
    ctx.clock.now += 8 * DAY;
    const body = relayInstallResponseSchema.parse((await register(ctx, server)).json());
    expect(ctx.email.sent).toHaveLength(2);
    // Same address: no fresh grace, so rings stay paused until the new link is used.
    expect(await state(ctx, body.relay_key)).toBe('paused');
    await confirm(ctx, linkToken(ctx.email.sent[1]!));
    expect(await state(ctx, body.relay_key)).toBe('active');
  });

  it('a link held by the daily cap past 7 days of install age is sent when the cap frees', async () => {
    const ctx = await setup({ env: { RELAY_EMAILS_PER_DAY: '1' } });
    const late = newServer();
    ctx.email.result = 'rejected';
    await register(ctx, late, { email: 'late@example.com' });
    ctx.email.result = 'sent';
    ctx.clock.now += 8 * DAY;
    await register(ctx, newServer(), { email: 'first@example.com' });
    await register(ctx, late, { email: 'late@example.com' });
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['first@example.com']);
    ctx.clock.now += DAY;
    await ctx.tick();
    expect(ctx.email.sent.map((m) => m.to)).toEqual(['first@example.com', 'late@example.com']);
    expect((await confirm(ctx, linkToken(ctx.email.sent[1]!))).statusCode).toBe(200);
  });

  it('the queue still gives up 7 days after the request', async () => {
    const ctx = await setup();
    const server = newServer();
    ctx.email.result = 'rejected';
    await register(ctx, server);
    ctx.clock.now += 8 * DAY;
    ctx.email.result = 'retry';
    await register(ctx, server);
    ctx.clock.now += 7 * DAY;
    ctx.email.result = 'sent';
    await ctx.tick();
    expect(ctx.email.sent).toHaveLength(0);
  });
});

describe('fix round 3: no endless grace', () => {
  it('alternating addresses from an unverified install pauses after the original 7 days', async () => {
    const ctx = await setup({ env: { RELAY_EMAILS_PER_DAY: '1' } });
    const server = newServer();
    let key = relayInstallResponseSchema.parse((await register(ctx, server)).json()).relay_key;
    const state = async () =>
      relayStatusResponseSchema.parse((await status(ctx, key)).json()).state;
    for (let week = 1; week <= 20; week += 1) {
      ctx.clock.now = START + week * 7 * DAY;
      const again = await register(ctx, server, {
        email: week % 2 === 0 ? 'owner@example.com' : 'b@example.com',
      });
      key = relayInstallResponseSchema.parse(again.json()).relay_key;
      expect(await state()).toBe('paused');
    }
  });

  it('a change from an unverified install keeps the grace start', async () => {
    const ctx = await setup();
    const server = newServer();
    await register(ctx, server);
    ctx.clock.now += 5 * DAY;
    const body = relayInstallResponseSchema.parse(
      (await register(ctx, server, { email: 'b@example.com' })).json(),
    );
    ctx.clock.now = START + 7 * DAY;
    expect(relayStatusResponseSchema.parse((await status(ctx, body.relay_key)).json()).state).toBe(
      'paused',
    );
  });
});

describe('fix round 2: no email address kept after deletion', () => {
  const sends = (ctx: Ctx) =>
    ctx.db.sqlite.prepare('SELECT address FROM email_sends').all() as { address: string }[];

  it('email_sends holds a hash of the address, never the address', async () => {
    const ctx = await setup();
    await register(ctx, newServer(), { email: 'owner@Example.com' });
    expect(ctx.email.sent).toHaveLength(1);
    const rows = sends(ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.address).toBe(sha256Hex('owner@example.com'));
    expect(JSON.stringify(rows)).not.toContain('@');
  });

  it('the sweeper prunes send records older than a day', async () => {
    const ctx = await setup();
    await register(ctx, newServer());
    ctx.clock.now += DAY + 1;
    await ctx.tick();
    expect(sends(ctx)).toHaveLength(0);
  });

  it('deleting an install deletes its address send records', async () => {
    const ctx = await setup();
    const body = relayInstallResponseSchema.parse((await register(ctx, newServer())).json());
    expect(sends(ctx)).toHaveLength(1);
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: '/v1/installs/self',
      headers: { authorization: `Bearer ${body.relay_key}` },
    });
    expect(res.statusCode).toBe(204);
    expect(sends(ctx)).toHaveLength(0);
  });
});
