import { createSocket } from 'node:dgram';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import {
  errorResponseSchema,
  relayIpResponseSchema,
  relayProbeResponseSchema,
  type RelayProbeCheck,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app';
import { loadRelayEnv } from './config';
import { openRelayDb } from './db';
import type { EmailSender } from './email';
import { InstallStore } from './installs';
import {
  isPublicIp,
  nodeProbeNet,
  PROBE_CHECK_TIMEOUT_MS,
  resolveWith,
  runProbe,
  type ProbeNet,
} from './probe';

const START = Date.parse('2026-11-01T00:00:00.000Z');
const noEmail: EmailSender = { send: () => Promise.resolve('sent') };
const PUBLIC_IP = '8.8.4.4';

/** A scripted network: records every call, answers as told, never touches a real socket. */
class FakeNet implements ProbeNet {
  readonly calls: string[] = [];
  resolved: string[][] = [[PUBLIC_IP]];
  open = new Set<string>(['http', 'https', 'tcp7881', 'udp7882']);
  serverId = '';
  hang = new Set<string>();
  resolveCount = 0;
  resolveHangs = false;
  resolve(host: string) {
    this.calls.push(`resolve ${host}`);
    if (this.resolveHangs) return new Promise<string[]>(() => undefined);
    const answer = this.resolved[Math.min(this.resolveCount, this.resolved.length - 1)]!;
    this.resolveCount += 1;
    return Promise.resolve(answer);
  }
  private wait<T>(check: string, value: T): Promise<T> {
    return this.hang.has(check) ? new Promise<T>(() => undefined) : Promise.resolve(value);
  }
  tcpConnect(ip: string, port: number) {
    this.calls.push(`tcp ${ip}:${port}`);
    return this.wait('tcp7881', this.open.has('tcp7881'));
  }
  udpExchange(ip: string, port: number, message: string) {
    this.calls.push(`udp ${ip}:${port} ${message}`);
    return this.wait('udp7882', this.open.has('udp7882') ? message : undefined);
  }
  get(url: { scheme: 'http' | 'https'; ip: string; port: number; host: string; path: string }) {
    this.calls.push(`${url.scheme} ${url.ip}:${url.port} ${url.host}${url.path}`);
    if (this.hang.has(url.scheme)) return new Promise<never>(() => undefined);
    if (!this.open.has(url.scheme)) return Promise.reject(new Error('closed'));
    return Promise.resolve({ status: 200, body: JSON.stringify({ server_id: this.serverId }) });
  }
}

async function setup(envOverrides: Record<string, string> = {}) {
  const clock = { now: START, mono: 1000 };
  const net = new FakeNet();
  const timeouts: { ms: number; controller: AbortController }[] = [];
  /** By default every timeout fires almost at once; `manual` leaves them to the test. */
  const timing = { manual: false };
  const env = loadRelayEnv({
    RELAY_FREE_UNTIL: '2027-06-30',
    RELAY_ADMIN_TOKEN: 'admin-token-that-is-long-enough-0123456789',
    LOG_LEVEL: 'warn',
    ...envOverrides,
  });
  const db = openRelayDb(':memory:');
  const app = await buildApp({
    env,
    db,
    email: noEmail,
    partners: [],
    now: () => clock.now,
    every: () => () => undefined,
    probe: {
      net,
      clock: () => clock.mono,
      timeout: (ms) => {
        const controller = new AbortController();
        timeouts.push({ ms, controller });
        if (!timing.manual) setTimeout(() => controller.abort(), 5);
        return controller.signal;
      },
    },
    logStream: new Writable({ write: (_c, _e, done) => done() }),
  });
  const installs = new InstallStore(db);
  let n = 0;
  const newInstall = (options: { address?: string; verified?: boolean } = {}) => {
    n += 1;
    const { install, key } = installs.create(
      {
        serverId: `srv_test${n}`,
        publicKey: `pk${n}`,
        email: 'owner@example.com',
        news: false,
        ...(options.address !== undefined && { address: options.address }),
        paidUntil: '2027-06-30T00:00:00.000Z',
      },
      clock.now,
    );
    if (options.verified !== false) {
      db.sqlite
        .prepare('UPDATE installs SET verified_at = ? WHERE id = ?')
        .run(new Date(clock.now).toISOString(), install.id);
    }
    return { id: install.id, key, serverId: install.serverId };
  };
  const probe = (
    key: string,
    body: { address: string; checks: RelayProbeCheck[]; nonce?: string },
  ) =>
    app.inject({
      method: 'POST',
      url: '/v1/probe',
      headers: { authorization: `Bearer ${key}` },
      payload: { nonce: 'n0nce_1', ...body },
    });
  const setAddress = (key: string, address: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/v1/installs/address',
      headers: { authorization: `Bearer ${key}` },
      payload: { address },
    });
  return { app, db, clock, net, timeouts, timing, newInstall, probe, setAddress, installs };
}

const ALL: RelayProbeCheck[] = ['http', 'https', 'tcp7881', 'udp7882'];

describe('isPublicIp', () => {
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:a00:1::1',
    '3fff::1',
    'not-an-ip',
  ])('refuses %s', (ip) => {
    expect(isPublicIp(ip)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0', '172.32.0.1', '2606:4700::1'])(
    'accepts %s',
    (ip) => {
      expect(isPublicIp(ip)).toBe(true);
    },
  );
});

describe('runProbe', () => {
  const deps = (net: ProbeNet) => ({
    net,
    clock: () => 0,
    timeout: () => AbortSignal.timeout(5),
  });

  it('refuses a name that resolves to any non-public address, and connects nowhere', async () => {
    const net = new FakeNet();
    net.resolved = [[PUBLIC_IP, '10.0.0.5']];
    const out = await runProbe(deps(net), {
      address: 'home.example.com',
      serverId: 's',
      checks: ALL,
      nonce: 'n',
    });
    expect(out).toEqual({ ok: false, reason: 'not_public' });
    expect(net.calls).toEqual(['resolve home.example.com']);
  });

  it('resolves once and sends every check to the validated IP (no rebinding)', async () => {
    const net = new FakeNet();
    net.serverId = 's';
    net.resolved = [[PUBLIC_IP], ['127.0.0.1']];
    const out = await runProbe(deps(net), {
      address: 'home.example.com',
      serverId: 's',
      checks: ALL,
      nonce: 'n',
    });
    expect(out.ok).toBe(true);
    expect(net.resolveCount).toBe(1);
    expect(net.calls.filter((c) => c.includes('127.0.0.1'))).toEqual([]);
    expect(net.calls).toContain(`https ${PUBLIC_IP}:443 home.example.com/v1/server`);
    expect(net.calls).toContain(`udp ${PUBLIC_IP}:7882 twring-probe n`);
  });

  it('refuses a private IP literal without resolving', async () => {
    const net = new FakeNet();
    const out = await runProbe(deps(net), {
      address: '192.168.0.10',
      serverId: 's',
      checks: ALL,
      nonce: 'n',
    });
    expect(out).toEqual({ ok: false, reason: 'not_public' });
    expect(net.calls).toEqual([]);
  });

  it('fails the HTTPS check when the server id is another server', async () => {
    const net = new FakeNet();
    net.serverId = 'someone-else';
    const out = await runProbe(deps(net), {
      address: 'home.example.com',
      serverId: 's',
      checks: ['https'],
      nonce: 'n',
    });
    expect(out).toEqual({ ok: true, results: { https: { ok: false } } });
  });

  it('refuses an https URL on another port, or one that does not parse', async () => {
    for (const address of ['https://box.example.com:8443', 'https://[bad']) {
      const net = new FakeNet();
      const out = await runProbe(deps(net), { address, serverId: 's', checks: ALL, nonce: 'n' });
      expect(out).toEqual({ ok: false, reason: 'invalid_address' });
      expect(net.calls).toEqual([]);
    }
  });

  it('probes an https URL on 443', async () => {
    const net = new FakeNet();
    net.serverId = 's';
    await runProbe(deps(net), {
      address: 'https://box.example.com:443/',
      serverId: 's',
      checks: ['https'],
      nonce: 'n',
    });
    expect(net.calls).toContain(`https ${PUBLIC_IP}:443 box.example.com/v1/server`);
  });

  it('gives up on a name server that never answers', async () => {
    const net = new FakeNet();
    net.resolveHangs = true;
    const out = await runProbe(deps(net), {
      address: 'home.example.com',
      serverId: 's',
      checks: ALL,
      nonce: 'n',
    });
    expect(out).toEqual({ ok: false, reason: 'unresolved' });
  });

  it('prefers IPv4 when the name has both', async () => {
    const net = new FakeNet();
    net.resolved = [['2606:4700::1', PUBLIC_IP]];
    await runProbe(deps(net), {
      address: 'home.example.com',
      serverId: 's',
      checks: ['tcp7881'],
      nonce: 'n',
    });
    expect(net.calls).toEqual(['resolve home.example.com', `tcp ${PUBLIC_IP}:7881`]);
  });

  it('refuses when the target IP is over its budget', async () => {
    const net = new FakeNet();
    const out = await runProbe(
      { ...deps(net), allowTarget: () => false },
      { address: 'home.example.com', serverId: 's', checks: ALL, nonce: 'n' },
    );
    expect(out).toEqual({ ok: false, reason: 'busy' });
    expect(net.calls).toEqual(['resolve home.example.com']);
  });
});

describe('POST /v1/probe', () => {
  it('reports each check with its delay', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'home.example.com' });
    ctx.net.serverId = install.serverId;
    ctx.net.open.delete('udp7882');
    const res = await ctx.probe(install.key, { address: 'home.example.com', checks: ALL });
    expect(res.statusCode).toBe(200);
    const body = relayProbeResponseSchema.parse(res.json());
    expect(body.results).toEqual({
      http: { ok: true, ms: 0 },
      https: { ok: true, ms: 0 },
      tcp7881: { ok: true, ms: 0 },
      udp7882: { ok: false },
    });
  });

  it('dedupes repeated checks', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'home.example.com' });
    await ctx.probe(install.key, {
      address: 'home.example.com',
      checks: ['tcp7881', 'tcp7881', 'tcp7881'],
    });
    expect(ctx.net.calls.filter((c) => c.startsWith('tcp'))).toHaveLength(1);
  });

  it('times each check out after 4 s', async () => {
    const ctx = await setup();
    ctx.timing.manual = true;
    const install = ctx.newInstall({ address: 'home.example.com' });
    ctx.net.hang.add('udp7882');
    ctx.net.serverId = install.serverId;
    const pending = ctx.probe(install.key, {
      address: 'home.example.com',
      checks: ['udp7882', 'https'],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The name lookup, then one per check.
    expect(ctx.timeouts.map((t) => t.ms)).toEqual([
      PROBE_CHECK_TIMEOUT_MS,
      PROBE_CHECK_TIMEOUT_MS,
      PROBE_CHECK_TIMEOUT_MS,
    ]);
    expect(PROBE_CHECK_TIMEOUT_MS).toBe(4000);
    for (const t of ctx.timeouts) t.controller.abort();
    const res = await pending;
    expect(relayProbeResponseSchema.parse(res.json()).results).toEqual({
      udp7882: { ok: false },
      https: { ok: true, ms: 0 },
    });
  });

  it('refuses an address other than the registered one, and probes nothing', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'home.example.com' });
    const res = await ctx.probe(install.key, { address: '169.254.169.254', checks: ALL });
    expect(res.statusCode).toBe(409);
    expect(ctx.net.calls).toEqual([]);
  });

  it('targets the stored spelling even when the request differs only in case', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'home.example.com' });
    const res = await ctx.probe(install.key, { address: 'HOME.example.com/', checks: ['tcp7881'] });
    expect(res.statusCode).toBe(200);
    expect(ctx.net.calls).toEqual(['resolve home.example.com', `tcp ${PUBLIC_IP}:7881`]);
  });

  it('answers a failed check only when its timeout ends (no timing leak)', async () => {
    const ctx = await setup();
    ctx.timing.manual = true;
    const install = ctx.newInstall({ address: 'home.example.com' });
    ctx.net.open.delete('tcp7881');
    let settled = false;
    const pending = ctx
      .probe(install.key, { address: 'home.example.com', checks: ['tcp7881'] })
      .then((res) => {
        settled = true;
        return res;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    for (const t of ctx.timeouts) t.controller.abort();
    const res = await pending;
    expect(relayProbeResponseSchema.parse(res.json()).results).toEqual({ tcp7881: { ok: false } });
  });

  it('caps probes per target IP across installs at 20 an hour', async () => {
    const ctx = await setup();
    const keys = ['a', 'b', 'c'].map((name) => ({
      name,
      key: ctx.newInstall({ address: `${name}.example.com` }).key,
    }));
    let ok = 0;
    for (const { name, key } of keys) {
      for (let i = 0; i < 10; i += 1) {
        const res = await ctx.probe(key, { address: `${name}.example.com`, checks: ['http'] });
        if (res.statusCode === 200) ok += 1;
        else expect(res.statusCode).toBe(429);
      }
    }
    expect(ok).toBe(20);
  });

  it('answers 400, not 500, for a stored address that does not parse', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'https://[bad' });
    const res = await ctx.probe(install.key, { address: 'https://[bad', checks: ALL });
    expect(res.statusCode).toBe(400);
  });

  it('refuses when no address is registered', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const res = await ctx.probe(install.key, { address: 'home.example.com', checks: ALL });
    expect(res.statusCode).toBe(409);
    expect(ctx.net.calls).toEqual([]);
  });

  it('refuses a registered name that resolves inside', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'home.example.com' });
    ctx.net.resolved = [['127.0.0.1']];
    const res = await ctx.probe(install.key, { address: 'home.example.com', checks: ALL });
    expect(res.statusCode).toBe(400);
    expect(ctx.net.calls).toEqual(['resolve home.example.com']);
  });

  it('allows 10 probes per install per hour', async () => {
    const ctx = await setup();
    const a = ctx.newInstall({ address: 'a.example.com' });
    const b = ctx.newInstall({ address: 'b.example.com' });
    for (let i = 0; i < 10; i += 1) {
      expect(
        (await ctx.probe(a.key, { address: 'a.example.com', checks: ['http'] })).statusCode,
      ).toBe(200);
    }
    const over = await ctx.probe(a.key, { address: 'a.example.com', checks: ['http'] });
    expect(over.statusCode).toBe(429);
    expect(
      (await ctx.probe(b.key, { address: 'b.example.com', checks: ['http'] })).statusCode,
    ).toBe(200);
    ctx.clock.now += 3_600_000;
    expect(
      (await ctx.probe(a.key, { address: 'a.example.com', checks: ['http'] })).statusCode,
    ).toBe(200);
  });

  it('needs a relay key and refuses revoked and paused installs', async () => {
    const ctx = await setup();
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/v1/probe',
          payload: { address: 'a.example.com', checks: ['http'], nonce: 'n' },
        })
      ).statusCode,
    ).toBe(401);
    const revoked = ctx.newInstall({ address: 'a.example.com' });
    ctx.installs.revoke(revoked.id, ctx.clock.now);
    expect(
      (await ctx.probe(revoked.key, { address: 'a.example.com', checks: ['http'] })).statusCode,
    ).toBe(401);
    const paused = ctx.newInstall({ address: 'p.example.com', verified: false });
    ctx.clock.now += 8 * 86_400_000;
    const res = await ctx.probe(paused.key, { address: 'p.example.com', checks: ['http'] });
    expect(res.statusCode).toBe(403);
    expect(ctx.net.calls).toEqual([]);
  });

  it('holds the whole relay to 16 probes in flight (429), then frees the slots', async () => {
    const ctx = await setup();
    ctx.timing.manual = true;
    ctx.net.resolveHangs = true;
    const keys = Array.from({ length: 17 }, (_, i) =>
      ctx.newInstall({ address: `h${i}.example.com` }),
    );
    const pending = keys
      .slice(0, 16)
      .map((install, i) =>
        ctx.probe(install.key, { address: `h${i}.example.com`, checks: ['http'] }),
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const over = await ctx.probe(keys[16]!.key, { address: 'h16.example.com', checks: ['http'] });
    expect(over.statusCode).toBe(429);
    expect(errorResponseSchema.parse(over.json()).error.code).toBe('rate_limited');
    for (const t of ctx.timeouts) t.controller.abort();
    await Promise.all(pending);
    ctx.net.resolveHangs = false;
    ctx.timing.manual = false;
    const after = await ctx.probe(keys[16]!.key, { address: 'h16.example.com', checks: ['http'] });
    expect(after.statusCode).toBe(200);
  });

  it('charges a per-name budget (20 an hour) before resolving the name', async () => {
    const ctx = await setup();
    const installs = Array.from({ length: 3 }, () =>
      ctx.newInstall({ address: 'same.example.com' }),
    );
    let refused = 0;
    for (const install of installs) {
      for (let i = 0; i < 8; i += 1) {
        const res = await ctx.probe(install.key, { address: 'same.example.com', checks: ['http'] });
        if (res.statusCode === 429) refused += 1;
      }
    }
    expect(refused).toBe(4);
    expect(ctx.net.calls.filter((call) => call.startsWith('resolve'))).toHaveLength(20);
  });

  it('refuses a malformed request', async () => {
    const ctx = await setup();
    const install = ctx.newInstall({ address: 'a.example.com' });
    const res = await ctx.probe(install.key, {
      address: 'a.example.com',
      checks: ['http'],
      nonce: 'bad nonce',
    });
    expect(res.statusCode).toBe(400);
    expect(errorResponseSchema.parse(res.json()).error.code).toBe('invalid_request');
  });
});

describe('PUT /v1/installs/address', () => {
  it('sets the address the probe then targets', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    const res = await ctx.setAddress(install.key, 'https://twring.example.com');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ address: 'https://twring.example.com' });
    expect(ctx.installs.findById(install.id)?.address).toBe('https://twring.example.com');
    const probe = await ctx.probe(install.key, {
      address: 'https://twring.example.com',
      checks: ['tcp7881'],
    });
    expect(probe.statusCode).toBe(200);
    expect(ctx.net.calls).toEqual(['resolve twring.example.com', `tcp ${PUBLIC_IP}:7881`]);
  });

  it('refuses an invalid address and a missing key', async () => {
    const ctx = await setup();
    const install = ctx.newInstall();
    for (const bad of ['', 'http://x.example.com', 'https://u:p@x.example.com', 'a b', 42]) {
      expect((await ctx.setAddress(install.key, bad)).statusCode).toBe(400);
    }
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/v1/installs/address',
      payload: { address: 'a.example.com' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/ip', () => {
  it('answers the caller address, 30 times an hour', async () => {
    const ctx = await setup();
    const get = () => ctx.app.inject({ method: 'GET', url: '/v1/ip', remoteAddress: '8.8.8.50' });
    for (let i = 0; i < 30; i += 1) {
      const res = await get();
      expect(res.statusCode).toBe(200);
      expect(relayIpResponseSchema.parse(res.json())).toEqual({ ip: '8.8.8.50' });
    }
    expect((await get()).statusCode).toBe(429);
    ctx.clock.now += 3_600_000;
    expect((await get()).statusCode).toBe(200);
  });

  it('unwraps an IPv4-mapped address', async () => {
    const ctx = await setup();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/ip',
      remoteAddress: '::ffff:8.8.4.4',
    });
    expect(res.json()).toEqual({ ip: '8.8.4.4' });
  });

  it('honours the trusted proxy setting', async () => {
    const trusted = await setup({ TRUST_PROXY: 'true' });
    const res = await trusted.app.inject({
      method: 'GET',
      url: '/v1/ip',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '1.1.1.9' },
    });
    expect(res.json()).toEqual({ ip: '1.1.1.9' });
    const untrusted = await setup();
    const direct = await untrusted.app.inject({
      method: 'GET',
      url: '/v1/ip',
      remoteAddress: '1.0.0.7',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(direct.json()).toEqual({ ip: '1.0.0.7' });
  });

  it.each(['127.0.0.1', '10.0.0.4', '100.64.1.1', '::1'])(
    'answers 503 relay_misconfigured when it sees a non-public address (%s)',
    async (remoteAddress) => {
      const ctx = await setup();
      const res = await ctx.app.inject({ method: 'GET', url: '/v1/ip', remoteAddress });
      expect(res.statusCode).toBe(503);
      expect(errorResponseSchema.parse(res.json()).error.code).toBe('relay_misconfigured');
    },
  );
});

describe('resolveWith (c-ares, not the thread pool)', () => {
  const fake = (answers: { v4?: string[] | Error; v6?: string[] | Error; hang?: boolean }) => {
    const state = { cancelled: 0 };
    const answer = (value: string[] | Error | undefined) =>
      answers.hang === true
        ? new Promise<string[]>(() => undefined)
        : value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(value ?? []);
    return {
      state,
      resolver: {
        resolve4: () => answer(answers.v4),
        resolve6: () => answer(answers.v6),
        cancel: () => {
          state.cancelled += 1;
        },
      },
    };
  };

  it('joins A and AAAA answers, ignoring a family with no records', async () => {
    const { resolver } = fake({
      v4: ['8.8.8.8'],
      v6: Object.assign(new Error('x'), { code: 'ENODATA' }),
    });
    expect(await resolveWith(resolver, 'a.example.com', new AbortController().signal)).toEqual([
      '8.8.8.8',
    ]);
  });

  it('fails when neither family answers', async () => {
    const { resolver } = fake({ v4: new Error('ENOTFOUND'), v6: new Error('ENOTFOUND') });
    await expect(
      resolveWith(resolver, 'a.example.com', new AbortController().signal),
    ).rejects.toThrow();
  });

  it('cancels the lookups when the signal fires', async () => {
    const { resolver, state } = fake({ hang: true });
    const controller = new AbortController();
    const pending = resolveWith(resolver, 'a.example.com', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(state.cancelled).toBe(1);
  });
});

describe('nodeProbeNet on real loopback sockets', () => {
  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => crashes.push(error);
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    process.off('uncaughtException', onCrash);
    for (const clean of cleanups.splice(0)) clean();
  });
  const watch = () => {
    crashes.length = 0;
    process.on('uncaughtException', onCrash);
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('survives a UDP reply followed by the timeout', async () => {
    watch();
    const server = createSocket('udp4');
    server.on('message', (data, from) => server.send(data, from.port, from.address));
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const got = await nodeProbeNet.udpExchange(
      '127.0.0.1',
      server.address().port,
      'twring-probe n',
      AbortSignal.timeout(80),
    );
    expect(got).toBe('twring-probe n');
    await pause(200);
    expect(crashes).toEqual([]);
  });

  it('survives a UDP error and the timeout after it', async () => {
    watch();
    const got = await nodeProbeNet.udpExchange(
      '127.0.0.1',
      1,
      'twring-probe n',
      AbortSignal.timeout(80),
    );
    expect(got).toBeUndefined();
    await pause(200);
    expect(crashes).toEqual([]);
  });

  it('survives a TCP connect and the timeout after it (loopback fails the peer re-check)', async () => {
    watch();
    const server = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    const ok = await nodeProbeNet.tcpConnect(
      '127.0.0.1',
      (server.address() as AddressInfo).port,
      AbortSignal.timeout(80),
    );
    expect(ok).toBe(false);
    await pause(200);
    expect(crashes).toEqual([]);
  });

  it('answers the port 80 check on headers, without waiting for the body', async () => {
    watch();
    const server = createHttpServer((_req, res) => {
      res.writeHead(308, { location: 'https://x/' });
      res.write('partial');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.closeAllConnections());
    cleanups.push(() => server.close());
    const answer = await nodeProbeNet.get(
      {
        scheme: 'http',
        ip: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        host: 'home.example.com',
        path: '/v1/server',
      },
      AbortSignal.timeout(2000),
    );
    expect(answer.status).toBe(308);
    await pause(50);
    expect(crashes).toEqual([]);
  });

  it('sends an IPv6 literal Host header in brackets', async () => {
    let host: string | undefined;
    const server = createHttpServer((req, res) => {
      host = req.headers.host;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve));
    cleanups.push(() => server.close());
    await nodeProbeNet.get(
      {
        scheme: 'http',
        ip: '::1',
        port: (server.address() as AddressInfo).port,
        host: '::1',
        path: '/v1/server',
      },
      AbortSignal.timeout(2000),
    );
    expect(host).toBe('[::1]');
  });
});
