import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { buildApp } from './app';
import {
  createRequestAuth,
  devAuthenticator,
  DEV_USER_ID,
  supabaseAuthenticator,
  mcpAuthenticator,
  supabaseJwks,
  type Authenticator,
} from './auth';

// ADR-021: the gateway verifies Supabase access tokens against the project's JWKS. A local key
// pair and a stub JWKS server stand in for Supabase.

const USER = '8f1c2a52-0000-4000-8000-000000000001';

interface Signer {
  kid: string;
  alg: 'ES256' | 'RS256';
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  jwk: JWK;
}

async function signer(kid: string, alg: 'ES256' | 'RS256' = 'ES256'): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  return { kid, alg, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } };
}

interface StubJwks {
  url: string;
  keys: JWK[];
  requests: number;
  /** Answer 500 (or drop the connection) instead of the key set. */
  failing: 'no' | 'http' | 'down';
  close(): Promise<void>;
}

async function startJwks(keys: JWK[]): Promise<StubJwks> {
  const stub = { keys, requests: 0, failing: 'no' } as StubJwks;
  const server: Server = createServer((request, response) => {
    stub.requests += 1;
    if (stub.failing === 'down') {
      request.socket.destroy();
      return;
    }
    if (stub.failing === 'http' || request.url !== '/auth/v1/.well-known/jwks.json') {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: stub.keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((resolve) => server.close(() => resolve()));
  return stub;
}

interface Claims {
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  nbf?: number;
}

function token(key: Signer, base: string, claims: Claims = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ role: 'authenticated', email: 'someone@example.com' })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(claims.iss ?? `${base}/auth/v1`)
    .setAudience(claims.aud ?? 'authenticated')
    .setSubject(claims.sub ?? USER)
    .setIssuedAt(now)
    .setExpirationTime(claims.exp ?? now + 3600);
  if (claims.nbf !== undefined) jwt.setNotBefore(claims.nbf);
  return jwt.sign(key.privateKey);
}

/** A tiny app with one /v1 route that echoes the verified user. */
function appWith(authenticate: Authenticator) {
  const auth = createRequestAuth(authenticate);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    auth,
    onError: () => undefined,
  });
  app.get('/v1/whoami', (request) => ({ user: auth.userFor(request) }));
  return app;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function setup(options: { alg?: 'ES256' | 'RS256'; cooldownMs?: number } = {}) {
  const key = await signer('key-1', options.alg);
  const jwks = await startJwks([key.jwk]);
  cleanups.push(() => jwks.close());
  const keys = supabaseJwks(jwks.url, { cooldownMs: options.cooldownMs ?? 0 });
  const app = appWith(supabaseAuthenticator({ supabaseUrl: jwks.url, keys }));
  cleanups.push(() => app.close());
  const get = (authorization?: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/whoami',
      ...(authorization !== undefined && { headers: { authorization } }),
    });
  return { key, jwks, app, get, base: jwks.url };
}

function codeOf(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

describe('supabase authentication', () => {
  it('separates connected-app tokens from app sign-ins', async () => {
    const { key, base, get } = await setup();
    const keys = supabaseJwks(base);
    const mcp = mcpAuthenticator({ supabaseUrl: base, keys });
    const regular = await token(key, base);
    const connected = await new SignJWT({ role: 'authenticated', client_id: 'claude-client' })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
      .setIssuer(`${base}/auth/v1`)
      .setAudience('authenticated')
      .setSubject(USER)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key.privateKey);
    await expect(
      mcp({ headers: { authorization: `Bearer ${regular}` } } as FastifyRequest),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      mcp({ headers: { authorization: `Bearer ${connected}` } } as FastifyRequest),
    ).resolves.toMatchObject({ id: USER, clientId: 'claude-client' });
    expect((await get(`Bearer ${connected}`)).statusCode).toBe(401);
  });
  it.each(['ES256', 'RS256'] as const)('accepts a valid %s token and uses sub', async (alg) => {
    const { key, get, base } = await setup({ alg });
    const response = await get(`Bearer ${await token(key, base)}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: USER });
  });

  it('answers 401 auth_required without a bearer token', async () => {
    const { get } = await setup();
    for (const header of [undefined, '', 'Basic abc', 'Bearer', 'bearer x y']) {
      const response = await get(header);
      expect(response.statusCode).toBe(401);
      expect(codeOf(response)).toBe('auth_required');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
  });

  it.each<[string, (base: string) => Claims]>([
    ['expired', () => ({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['not yet valid', () => ({ nbf: Math.floor(Date.now() / 1000) + 600 })],
    ['from another issuer', () => ({ iss: 'https://other.supabase.co/auth/v1' })],
    ['for another audience', () => ({ aud: 'anon' })],
    ['without a subject', () => ({ sub: '' })],
  ])('answers 401 auth_invalid for a token %s', async (_name, claims) => {
    const { key, get, base } = await setup();
    const response = await get(`Bearer ${await token(key, base, claims(base))}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });

  it('tolerates small clock skew', async () => {
    const { key, get, base } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const response = await get(`Bearer ${await token(key, base, { exp: now - 5, nbf: now + 5 })}`);
    expect(response.statusCode).toBe(200);
  });

  it('answers 401 auth_invalid for a bad signature', async () => {
    const { get, base } = await setup();
    // Same kid, different key: the JWKS key does not verify it.
    const impostor = await signer('key-1');
    const response = await get(`Bearer ${await token(impostor, base)}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });

  it('refuses alg=none, HS256, and garbage', async () => {
    const { get, base } = await setup();
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = b64({
      iss: `${base}/auth/v1`,
      aud: 'authenticated',
      sub: USER,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`;
    const hs256 = await new SignJWT({ sub: USER })
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setIssuer(`${base}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-shared-secret-anyone-could-guess'));
    for (const bad of [none, hs256, 'not-a-jwt', `${payload}.${payload}.${payload}`]) {
      const response = await get(`Bearer ${bad}`);
      expect(response.statusCode, bad).toBe(401);
      expect(codeOf(response)).toBe('auth_invalid');
    }
  });

  it.each(['http', 'down'] as const)(
    'fails closed with 503 auth_unavailable when the JWKS is unreachable (%s)',
    async (failing) => {
      const { key, jwks, get, base } = await setup();
      jwks.failing = failing;
      const response = await get(`Bearer ${await token(key, base)}`);
      expect(response.statusCode).toBe(503);
      expect(codeOf(response)).toBe('auth_unavailable');
    },
  );

  it('caches the key set and picks up a rotated key', async () => {
    const { key, jwks, get, base } = await setup();
    expect((await get(`Bearer ${await token(key, base)}`)).statusCode).toBe(200);
    expect((await get(`Bearer ${await token(key, base)}`)).statusCode).toBe(200);
    expect(jwks.requests).toBe(1);

    // Supabase rotates: a new key signs, the key set now lists both.
    const next = await signer('key-2');
    jwks.keys = [key.jwk, next.jwk];
    expect((await get(`Bearer ${await token(next, base)}`)).statusCode).toBe(200);
    expect(jwks.requests).toBe(2);
    // The old key keeps verifying from the cache until Supabase drops it.
    expect((await get(`Bearer ${await token(key, base)}`)).statusCode).toBe(200);
  });

  it('does not refetch the key set for unknown key ids inside the cooldown', async () => {
    const { key, jwks, get, base } = await setup({ cooldownMs: 60_000 });
    expect((await get(`Bearer ${await token(key, base)}`)).statusCode).toBe(200);
    const stranger = await signer('key-unknown');
    for (let i = 0; i < 3; i += 1) {
      const response = await get(`Bearer ${await token(stranger, base)}`);
      expect(response.statusCode).toBe(401);
      expect(codeOf(response)).toBe('auth_invalid');
    }
    expect(jwks.requests).toBe(1);
  });

  it('never gates /health', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
  });

  it('leaves unknown /v1 paths as 404', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(response.statusCode).toBe(404);
  });
});

describe('call tokens', () => {
  it('are minted only for a verified user', async () => {
    const key = await signer('key-1');
    const jwks = await startJwks([key.jwk]);
    cleanups.push(() => jwks.close());
    const auth = createRequestAuth(
      supabaseAuthenticator({ supabaseUrl: jwks.url, keys: supabaseJwks(jwks.url) }),
    );
    // No LiveKit: an authenticated create reaches the handler and answers 503.
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      auth,
      onError: () => undefined,
      calls: { registry: undefined, createRatePerMinute: 100 },
    });
    cleanups.push(() => app.close());
    const create = (authorization?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/calls',
        payload: {},
        ...(authorization !== undefined && { headers: { authorization } }),
      });
    expect((await create()).statusCode).toBe(401);
    const expired = await token(key, jwks.url, { exp: Math.floor(Date.now() / 1000) - 600 });
    expect((await create(`Bearer ${expired}`)).statusCode).toBe(401);
    expect((await create(`Bearer ${await token(key, jwks.url)}`)).statusCode).toBe(503);
  });
});

describe('dev authentication', () => {
  it('treats every request as the development user', async () => {
    const app = appWith(devAuthenticator);
    cleanups.push(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(response.json()).toEqual({ user: DEV_USER_ID });
  });

  it('lets the load test act as several development users with x-cord-dev-user', async () => {
    const app = appWith(devAuthenticator);
    cleanups.push(() => app.close());
    const as = (user: string) =>
      app.inject({ method: 'GET', url: '/v1/whoami', headers: { 'x-cord-dev-user': user } });
    expect((await as('load-7')).json()).toEqual({ user: 'dev-user-load-7' });
    // Anything that is not a short plain name stays the single development user.
    expect((await as('../x')).json()).toEqual({ user: DEV_USER_ID });
    expect((await as('x'.repeat(65))).json()).toEqual({ user: DEV_USER_ID });
  });

  it('answers 503 auth_unavailable when the authenticator fails unexpectedly', async () => {
    const app = appWith(() => Promise.reject(new Error('boom')));
    cleanups.push(() => app.close());
    const response = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(response.statusCode).toBe(503);
    expect(codeOf(response)).toBe('auth_unavailable');
  });
});
