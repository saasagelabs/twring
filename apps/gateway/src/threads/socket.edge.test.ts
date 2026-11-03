import type { AddressInfo } from 'node:net';

import { loadGatewayEnv } from '@twring/config/gateway';
import type { ThreadSocketFrame } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import type { FastifyInstance } from 'fastify';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../app';
import { createRequestAuth, supabaseAuthenticator } from '../auth';
import { startConnectorGateway } from '../connectors/harness';
import { PhoneSocketHub } from './socket';
import type { ThreadService } from './service';
import type { SqliteThreadStore } from './store';

const ALICE = '8f1c2a52-0000-4000-8000-000000000001';
const BOB = '8f1c2a52-0000-4000-8000-000000000002';
const SUPABASE = 'https://proj.supabase.co';
const FRAME: ThreadSocketFrame = { type: 'thread.cleared', agent_id: `agt_${'a'.repeat(20)}` };

const openApps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const app of openApps.splice(0)) await app.close();
});

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', resolve));
const registry = (hub: PhoneSocketHub) =>
  (hub as unknown as { users: Map<string, unknown[]> }).users;

async function setup(
  options: { keysFail?: boolean; trustProxy?: boolean; rate?: number; authDelayMs?: number } = {},
) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const local = createLocalJWKSet({ keys: [jwk] });
  const keys: JWTVerifyGetKey = options.keysFail
    ? () => Promise.reject(new Error('jwks down'))
    : local;
  const inner = supabaseAuthenticator({ supabaseUrl: SUPABASE, keys });
  const auth = createRequestAuth(async (request) => {
    if (options.authDelayMs) await tick(options.authDelayMs);
    return inner(request);
  });
  const sign = (sub: string, over: { exp?: number | string; iss?: string; role?: string } = {}) =>
    new SignJWT({ role: over.role ?? 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setSubject(sub)
      .setIssuer(over.iss ?? `${SUPABASE}/auth/v1`)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime(over.exp ?? '10m')
      .sign(privateKey);
  const hub = new PhoneSocketHub({
    auth,
    ratePerMinute: options.rate ?? 100,
    ipRatePerMinute: options.rate ?? 100,
    trustProxy: options.trustProxy ?? false,
  });
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    auth,
    threads: {
      service: { deleteAllForUser: () => Promise.resolve(0) } as unknown as ThreadService,
      store: {} as SqliteThreadStore,
      writeRatePerMinute: 30,
      readRatePerMinute: 120,
      messagesPerDay: 500,
      socketHub: hub,
    },
  });
  openApps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const open = (path: string, headers: Record<string, string>) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      sockets.push(ws);
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });
  const status = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      sockets.push(ws);
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      ws.once('open', () => resolve(101));
      ws.once('error', reject);
    });
  return { hub, sign, open, status, port, app };
}

describe('phone socket with the Supabase authenticator', () => {
  it('accepts a valid token (any scheme case) and rejects bad ones', async () => {
    const { sign, status } = await setup();
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
    const good = await sign(ALICE);
    expect(await status('/v1/me/socket', bearer(good))).toBe(101);
    expect(await status('/v1/me/socket', { Authorization: `bearer ${good}` })).toBe(101);
    expect(await status('/v1/me/socket', { Authorization: `Basic ${good}` })).toBe(401);
    expect(await status('/v1/me/socket', { Authorization: good })).toBe(401);
    expect(await status('/v1/me/socket', bearer(`${good}x`))).toBe(401);
    const expired = await sign(ALICE, { exp: Math.floor(Date.now() / 1000) - 600 });
    expect(await status('/v1/me/socket', bearer(expired))).toBe(401);
    const foreign = await sign(ALICE, { iss: 'https://evil.example/auth/v1' });
    expect(await status('/v1/me/socket', bearer(foreign))).toBe(401);
    const anon = await sign(ALICE, { role: 'anon' });
    expect(await status('/v1/me/socket', bearer(anon))).toBe(401);
    expect(await status('/v1/me/socket', bearer(await sign('dev-user')))).toBe(401);
    expect(await status('/v1/me/socket', bearer('a'.repeat(9000)))).toBe(401);
    expect(await status('/v1/me/socket', { Authorization: 'Bearer' })).toBe(401);
    expect(await status('/v1/me/socket', {})).toBe(401);
  });

  it('answers 503 when the key source fails, never an open socket', async () => {
    const { sign, status } = await setup({ keysFail: true });
    const header = { Authorization: `Bearer ${await sign(ALICE)}` };
    expect(await status('/v1/me/socket', header)).toBe(503);
  });

  it("never delivers one user's frames to another, across reconnects and closeUser", async () => {
    const { hub, sign, open } = await setup();
    const aliceH = { Authorization: `Bearer ${await sign(ALICE)}` };
    const bobH = { Authorization: `Bearer ${await sign(BOB)}` };
    const a1 = await open('/v1/me/socket', aliceH);
    const b1 = await open('/v1/me/socket', bobH);
    const bobGot: string[] = [];
    b1.on('message', (d) => bobGot.push((d as Buffer).toString('utf8')));
    const aliceGot: string[] = [];
    a1.on('message', (d) => aliceGot.push((d as Buffer).toString('utf8')));
    hub.publish(ALICE, FRAME);
    await tick();
    expect(aliceGot).toHaveLength(1);
    expect(bobGot).toHaveLength(0);
    const aClosed = closed(a1);
    hub.closeUser(ALICE);
    expect(await aClosed).toBe(4403);
    hub.publish(ALICE, FRAME);
    const a2 = await open('/v1/me/socket', aliceH);
    const a2Got: string[] = [];
    a2.on('message', (d) => a2Got.push((d as Buffer).toString('utf8')));
    await tick();
    expect(aliceGot).toHaveLength(1);
    expect(a2Got).toHaveLength(0);
    hub.publish(ALICE, FRAME);
    hub.publish(BOB, { ...FRAME, agent_id: `agt_${'b'.repeat(20)}` });
    await tick();
    expect(a2Got).toHaveLength(1);
    expect(bobGot).toHaveLength(1);
    expect(bobGot[0]).toContain('b'.repeat(20));
    a2.send(JSON.stringify({ type: 'focus', agent_id: FRAME.agent_id }));
    await tick();
    expect(hub.isFocused(ALICE, FRAME.agent_id)).toBe(true);
    expect(hub.isFocused(BOB, FRAME.agent_id)).toBe(false);
    // The old socket's late close must not drop the new registration.
    await tick();
    expect(hub.isFocused(ALICE, FRAME.agent_id)).toBe(true);
  });

  it('holds the 3-socket cap under a burst of concurrent connects', async () => {
    const { hub, sign, port } = await setup();
    const header = { Authorization: `Bearer ${await sign(ALICE)}` };
    const made = Array.from({ length: 8 }, () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/me/socket`, { headers: header });
      sockets.push(ws);
      ws.on('error', () => undefined);
      return ws;
    });
    await tick(400);
    expect(made.filter((ws) => ws.readyState === WebSocket.OPEN)).toHaveLength(3);
    expect(registry(hub).get(ALICE)).toHaveLength(3);
  });

  it('does not register a socket whose client left during authentication', async () => {
    const { hub, sign, port } = await setup({ authDelayMs: 150 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/me/socket`, {
      headers: { Authorization: `Bearer ${await sign(ALICE)}` },
    });
    ws.on('error', () => undefined);
    await tick(50);
    ws.terminate();
    await tick(400);
    expect(registry(hub).size).toBe(0);
  });

  it('closes a frame over 4 KiB', async () => {
    const { sign, open } = await setup();
    const ws = await open('/v1/me/socket', { Authorization: `Bearer ${await sign(ALICE)}` });
    const gone = closed(ws);
    ws.send('x'.repeat(5000));
    expect(await gone).toBe(1009);
  });
});

describe('upgrade dispatcher', () => {
  it('routes on the exact path only and never lets the query carry a token', async () => {
    const { sign, status } = await setup();
    const token = await sign(ALICE);
    const h = { Authorization: `Bearer ${token}` };
    expect(await status('/v1/me/socket?x=1', h)).toBe(101);
    expect(await status('/v1/me/socket/', h)).toBe(404);
    expect(await status('/V1/me/socket', h)).toBe(404);
    expect(await status('/v1/me/socket%2f', h)).toBe(404);
    expect(await status(`/v1/me/socket?token=${token}`, {})).toBe(401);
    expect(await status('/', h)).toBe(404);
  });

  it('keeps the two sockets apart while both are mounted', async () => {
    const gw = await startConnectorGateway({ threads: {} });
    try {
      const { token } = await gw.pair('alice');
      const base = gw.socketUrl.replace('/v1/connectors/socket', '');
      const status = (path: string, headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const ws = new WebSocket(`${base}${path}`, { headers });
          sockets.push(ws);
          ws.on('unexpected-response', (_req, res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          });
          ws.once('open', () => resolve(101));
          ws.once('error', reject);
        });
      // A connector token is no user sign-in, and a user sign-in is no connector token.
      expect(await status('/v1/me/socket', { Authorization: `Bearer ${token}` })).toBe(401);
      expect(
        await status('/v1/connectors/socket', { Authorization: 'Bearer alice', 'x-user': 'alice' }),
      ).toBe(401);
      expect(await status('/v1/connectors/socket', {})).toBe(401);
      expect(
        await status('/v1/me/socket', { Authorization: 'Bearer anything', 'x-user': 'alice' }),
      ).toBe(101);
      expect(await status('/v1/connectors/socket', { Authorization: `Bearer ${token}` })).toBe(101);
    } finally {
      for (const socket of sockets.splice(0)) socket.terminate();
      await gw.close();
    }
  });

  it('rate limits per forwarded client behind a trusted proxy, ignoring forged leftmost hops', async () => {
    const { status } = await setup({ trustProxy: true, rate: 2 });
    const h = (xff: string) => ({ 'X-Forwarded-For': xff });
    expect(await status('/v1/me/socket', h('1.1.1.1'))).toBe(401);
    expect(await status('/v1/me/socket', h('9.9.9.9, 1.1.1.1'))).toBe(401);
    expect(await status('/v1/me/socket', h('8.8.8.8, 1.1.1.1'))).toBe(429);
    expect(await status('/v1/me/socket', h('2.2.2.2'))).toBe(401);
  });

  it('closeAll refuses an authentication that finishes after shutdown', async () => {
    const { hub, sign, port } = await setup({ authDelayMs: 200 });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/me/socket`, {
      headers: { Authorization: `Bearer ${await sign(ALICE)}` },
    });
    ws.on('error', () => undefined);
    sockets.push(ws);
    await tick(50);
    hub.closeAll();
    await tick(400);
    expect(registry(hub).size).toBe(0);
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });
});
