import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

import { loadGatewayEnv } from '@twring/config/gateway';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { VoiceSampleCache } from './agents/voice-samples';
import { buildApp } from './app';
import {
  createRequestAuth,
  devAuthenticator,
  DEV_USER_ID,
  supabaseAuthenticator,
  supabaseJwks,
  type Authenticator,
} from './auth';
import { createMemoryStores } from './store/repositories';

// Edge cases of Supabase token verification and /v1 gating (ADR-021): header parsing, claim
// shapes Supabase can mint (anon key, service role, anonymous sign-ins), key selection, a JWKS
// that hangs or lies, and every route/method variant a client could send.

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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    handler?.(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests,
  };
}

/** A stub Supabase JWKS; `keys` may be swapped to simulate rotation. */
async function startJwks(initial: JWK[]) {
  const state = { keys: initial };
  const server = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: state.keys }));
  });
  return Object.assign(state, server);
}

/** A token with full control over header and claims; an `undefined` value drops that field. */
function rawToken(
  key: Signer,
  base: string,
  options: { header?: Record<string, unknown>; payload?: Record<string, unknown> } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: `${base}/auth/v1`,
    aud: 'authenticated',
    sub: USER,
    role: 'authenticated',
    iat: now,
    exp: now + 3600,
    ...options.payload,
  };
  const header: Record<string, unknown> = {
    alg: key.alg,
    kid: key.kid,
    typ: 'JWT',
    ...options.header,
  };
  for (const record of [payload, header]) {
    for (const [name, value] of Object.entries(record)) {
      if (value === undefined) delete record[name];
    }
  }
  return new SignJWT(payload).setProtectedHeader(header as { alg: string }).sign(key.privateKey);
}

function appWith(authenticate: Authenticator) {
  const auth = createRequestAuth(authenticate);
  const app = buildApp({
    env: loadGatewayEnv(gatewayEnvFixture()),
    auth,
    onError: () => undefined,
  });
  app.get('/v1/whoami', (request) => ({ user: auth.userFor(request) }));
  cleanups.push(() => app.close());
  return app;
}

function whoami(app: ReturnType<typeof appWith>, authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/whoami',
    ...(authorization !== undefined && { headers: { authorization } }),
  });
}

function codeOf(response: { json(): unknown }): string {
  return (response.json() as { error: { code: string } }).error.code;
}

async function setup(options: { alg?: 'ES256' | 'RS256'; cooldownMs?: number } = {}) {
  const key = await signer('key-1', options.alg);
  const jwks = await startJwks([key.jwk]);
  const keys = supabaseJwks(jwks.url, { cooldownMs: options.cooldownMs ?? 0 });
  const app = appWith(supabaseAuthenticator({ supabaseUrl: jwks.url, keys }));
  return {
    key,
    jwks,
    app,
    base: jwks.url,
    get: (authorization?: string) => whoami(app, authorization),
  };
}

describe('token shape', () => {
  it('accepts a token without kid when one key matches its algorithm', async () => {
    const { key, get, base } = await setup();
    const jwt = await rawToken(key, base, { header: { kid: undefined } });
    expect((await get(`Bearer ${jwt}`)).statusCode).toBe(200);
  });

  it('without kid and several same-algorithm keys, refuses (401, never 503)', async () => {
    // Supabase always sets kid; jose will not guess between candidate keys, which is fail-closed.
    const key = await signer('key-1');
    const other = await signer('key-2');
    const jwks = await startJwks([other.jwk, key.jwk]);
    const app = appWith(
      supabaseAuthenticator({ supabaseUrl: jwks.url, keys: supabaseJwks(jwks.url) }),
    );
    for (const signing of [key, await signer('stranger')]) {
      const jwt = await rawToken(signing, jwks.url, { header: { kid: undefined } });
      const refused = await whoami(app, `Bearer ${jwt}`);
      expect(refused.statusCode).toBe(401);
      expect(codeOf(refused)).toBe('auth_invalid');
    }
    // With its kid the same token verifies.
    expect((await whoami(app, `Bearer ${await rawToken(key, jwks.url)}`)).statusCode).toBe(200);
  });

  it('refuses an RS256 token whose kid names the EC key (algorithm confusion)', async () => {
    const { get, base } = await setup({ alg: 'ES256' });
    const response = await get(`Bearer ${await rawToken(await signer('key-1', 'RS256'), base)}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });

  it('refuses issuer variations, including a trailing slash', async () => {
    const { key, get, base } = await setup();
    for (const iss of [`${base}/auth/v1/`, `${base}/AUTH/v1`, base, 'supabase']) {
      const response = await get(`Bearer ${await rawToken(key, base, { payload: { iss } })}`);
      expect(response.statusCode, iss).toBe(401);
      expect(codeOf(response)).toBe('auth_invalid');
    }
  });

  it('normalises trailing slashes on SUPABASE_URL for both issuer and JWKS URL', async () => {
    const key = await signer('key-1');
    const jwks = await startJwks([key.jwk]);
    const app = appWith(supabaseAuthenticator({ supabaseUrl: `${jwks.url}//` }));
    expect((await whoami(app, `Bearer ${await rawToken(key, jwks.url)}`)).statusCode).toBe(200);
  });

  it('accepts an audience array containing authenticated, refuses one without', async () => {
    const { key, get, base } = await setup();
    const ok = await rawToken(key, base, { payload: { aud: ['authenticated', 'other'] } });
    expect((await get(`Bearer ${ok}`)).statusCode).toBe(200);
    const bad = await rawToken(key, base, { payload: { aud: ['anon', 'service_role'] } });
    expect((await get(`Bearer ${bad}`)).statusCode).toBe(401);
  });

  it.each<[string, Record<string, unknown>]>([
    ['role anon and no sub (the anon key shape)', { role: 'anon', sub: undefined }],
    ['role anon with a sub', { role: 'anon' }],
    ['role service_role', { role: 'service_role' }],
    ['no role', { role: undefined }],
    ['an anonymous sign-in (is_anonymous)', { is_anonymous: true }],
    ['no exp', { exp: undefined }],
    ['a numeric sub', { sub: 12345 }],
    ['sub dev-user', { sub: DEV_USER_ID }],
    ['a path-like sub', { sub: '../../etc/passwd' }],
    ['a sub with a colon', { sub: `${USER}:x` }],
    ['an upper-case uuid sub', { sub: USER.toUpperCase() }],
  ])('refuses a correctly signed token with %s', async (_name, payload) => {
    const { key, get, base } = await setup();
    const response = await get(`Bearer ${await rawToken(key, base, { payload })}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });

  it('refuses a token issued to an OAuth client app (client_id claim): connector only', async () => {
    const { key, get, base } = await setup();
    for (const clientId of ['b6c3a1d2-0000-4000-8000-000000000001', '']) {
      const jwt = await rawToken(key, base, { payload: { client_id: clientId } });
      const response = await get(`Bearer ${jwt}`);
      expect(response.statusCode).toBe(401);
      expect(codeOf(response)).toBe('auth_invalid');
    }
  });

  it('accepts a regular user whose token says is_anonymous: false', async () => {
    const { key, get, base } = await setup();
    const jwt = await rawToken(key, base, { payload: { is_anonymous: false } });
    expect((await get(`Bearer ${jwt}`)).statusCode).toBe(200);
  });

  it('refuses a refresh token sent as the access token', async () => {
    const { get } = await setup();
    // Supabase refresh tokens are short opaque strings, not JWTs.
    const response = await get('Bearer 5wqz3n7xkb2h');
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });
});

describe('authorization header', () => {
  it('accepts any casing of the Bearer scheme and extra spaces (RFC 7235, RFC 6750)', async () => {
    const { key, get, base } = await setup();
    const jwt = await rawToken(key, base);
    for (const header of [`bearer ${jwt}`, `BEARER ${jwt}`, `Bearer  ${jwt}`, ` Bearer ${jwt} `]) {
      expect((await get(header)).statusCode, header.slice(0, 9)).toBe(200);
    }
  });

  it('still refuses other schemes and tokens with inner spaces', async () => {
    const { key, get, base } = await setup();
    const jwt = await rawToken(key, base);
    for (const header of [`Bearerx ${jwt}`, `Basic ${jwt}`, `Bearer ${jwt} extra`, jwt]) {
      const response = await get(header);
      expect(response.statusCode).toBe(401);
      expect(codeOf(response)).toBe('auth_required');
    }
  });

  it('answers 401 auth_required for an oversized header without parsing it', async () => {
    const { get } = await setup();
    const response = await get(`Bearer ${'a'.repeat(100_000)}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_required');
  });

  it('uses only the first of repeated Authorization headers (Node drops duplicates)', async () => {
    const { key, app, base } = await setup();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const jwt = await rawToken(key, base);
    const status = (headers: string[]) =>
      new Promise<number>((resolve, reject) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `GET /v1/whoami HTTP/1.1\r\nHost: x\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`,
          );
        });
        let data = '';
        socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
        socket.on('end', () => resolve(Number(data.split(' ')[1])));
        socket.on('error', reject);
      });
    expect(await status([`Authorization: Bearer ${jwt}`, 'Authorization: Bearer junk'])).toBe(200);
    expect(await status(['Authorization: Bearer junk', `Authorization: Bearer ${jwt}`])).toBe(401);
  });
});

describe('key source', () => {
  it('treats a well-formed key set without the token kid as a token problem (401)', async () => {
    const key = await signer('key-1');
    const { url } = await listen((_request, response) => {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"keys":[{"kty":"EC"}]}');
    });
    const app = appWith(supabaseAuthenticator({ supabaseUrl: url }));
    const response = await whoami(app, `Bearer ${await rawToken(key, url)}`);
    expect(response.statusCode).toBe(401);
    expect(codeOf(response)).toBe('auth_invalid');
  });

  it.each(['not json', '{"keys":"nope"}', '[]', '{}'])(
    'fails closed with 503 when the JWKS answers garbage: %s',
    async (body) => {
      const key = await signer('key-1');
      const { url } = await listen((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      });
      const app = appWith(supabaseAuthenticator({ supabaseUrl: url }));
      const response = await whoami(app, `Bearer ${await rawToken(key, url)}`);
      expect(response.statusCode).toBe(503);
      expect(codeOf(response)).toBe('auth_unavailable');
    },
  );

  it('bounds a hanging JWKS with a timeout: 503, not a stalled request', async () => {
    const key = await signer('key-1');
    const { url } = await listen(() => undefined);
    const keys = supabaseJwks(url, { timeoutMs: 200 });
    const app = appWith(supabaseAuthenticator({ supabaseUrl: url, keys }));
    const started = performance.now();
    const response = await whoami(app, `Bearer ${await rawToken(key, url)}`);
    expect(response.statusCode).toBe(503);
    expect(codeOf(response)).toBe('auth_unavailable');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('shares one JWKS fetch between concurrent cold-start requests', async () => {
    const { key, jwks, get, base } = await setup();
    const jwt = await rawToken(key, base);
    const responses = await Promise.all(Array.from({ length: 20 }, () => get(`Bearer ${jwt}`)));
    expect(responses.map((response) => response.statusCode)).toEqual(Array(20).fill(200));
    expect(jwks.requests()).toBe(1);
  });

  it('picks up a key rotated during the cooldown once the cooldown ends', async () => {
    const { key, jwks, get, base } = await setup({ cooldownMs: 200 });
    expect((await get(`Bearer ${await rawToken(key, base)}`)).statusCode).toBe(200);
    const next = await signer('key-2');
    jwks.keys = [key.jwk, next.jwk];
    // Inside the cooldown the new key id is unknown: 401 (the app refreshes and retries once).
    expect((await get(`Bearer ${await rawToken(next, base)}`)).statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await get(`Bearer ${await rawToken(next, base)}`)).statusCode).toBe(200);
  });
});

describe('route gating', () => {
  async function gated() {
    const key = await signer('key-1');
    const jwks = await startJwks([key.jwk]);
    let synthesized = 0;
    const auth = createRequestAuth(
      supabaseAuthenticator({ supabaseUrl: jwks.url, keys: supabaseJwks(jwks.url) }),
    );
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      auth,
      onError: () => undefined,
      calls: { registry: undefined, createRatePerMinute: 100 },
      agents: {
        stores: createMemoryStores({
          currentVersion: 1,
          keys: new Map([[1, Buffer.alloc(32, 3).toString('base64')]]),
        }),
        policy: { env: 'development', lookup: () => Promise.resolve([]) },
        writeRatePerMinute: 100,
      },
      me: { deleteRatePerMinute: 100 },
      speechKeys: { enabled: true, writeRatePerMinute: 5 },
      voiceSamples: {
        samples: new VoiceSampleCache('unused-dir', () => {
          synthesized += 1;
          return Promise.resolve(new Uint8Array(10));
        }),
      },
    });
    cleanups.push(() => app.close());
    return { app, jwt: await rawToken(key, jwks.url), synthesized: () => synthesized };
  }

  it('gates every /v1 route and method, including HEAD and encoded paths', async () => {
    const { app, synthesized } = await gated();
    const probes: [string, string][] = [
      ['GET', '/v1/agents'],
      ['HEAD', '/v1/agents'],
      ['POST', '/v1/agents'],
      ['GET', '/v1/agents/a1'],
      ['PATCH', '/v1/agents/a1'],
      ['DELETE', '/v1/agents/a1'],
      ['POST', '/v1/agents/a1/test'],
      ['GET', '/v1/voices'],
      ['HEAD', '/v1/voices'],
      ['GET', '/v1/voices/aura-2-thalia-en/sample'],
      ['GET', '/v1/calls/history'],
      ['POST', '/v1/calls'],
      ['GET', '/v1/calls/c1'],
      ['POST', '/v1/calls/c1/end'],
      ['POST', '/v1/calls/c1/feedback'],
      ['DELETE', '/v1/me/data'],
      ['GET', '/v1/me/speech-keys'],
      ['PUT', '/v1/me/speech-keys/deepgram'],
      ['DELETE', '/v1/me/speech-keys/deepgram'],
      ['GET', '/v1/%61gents'],
      ['GET', '/v1/agents?user=dev-user'],
    ];
    for (const [method, url] of probes) {
      const response = await app.inject({ method: method as 'GET', url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.headers['www-authenticate'], `${method} ${url}`).toBe('Bearer');
      if (method !== 'HEAD') expect(codeOf(response), `${method} ${url}`).toBe('auth_required');
    }
    expect(synthesized()).toBe(0);
  });

  it('refuses before the body parser runs', async () => {
    const { app } = await gated();
    for (const payload of ['{not json', `{"x":"${'a'.repeat(200_000)}"}`]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it('never serves a case, slash, or dot variant of a /v1 route without a token', async () => {
    const { app, jwt } = await gated();
    const variants = [
      '/V1/agents',
      '/v1/Agents',
      '/v1/agents/',
      '//v1/agents',
      '/v1//agents',
      '/./v1/agents',
      '/v1/./agents',
      '/x/../v1/agents',
      '/v1/agents%2F',
      '/v1',
      '/v1/',
    ];
    for (const url of variants) {
      const anonymous = await app.inject({ method: 'GET', url });
      // Either no route matched (404) or the matched route was gated (401): never served.
      expect([401, 404], url).toContain(anonymous.statusCode);
      const signedIn = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${jwt}` },
      });
      expect(signedIn.statusCode, url).not.toBe(401);
    }
    expect((await app.inject({ method: 'OPTIONS', url: '/v1/agents' })).statusCode).toBe(404);
  });

  it('keeps dev-user data unreachable once the same stores run in supabase mode', async () => {
    const stores = createMemoryStores({
      currentVersion: 1,
      keys: new Map([[1, Buffer.alloc(32, 3).toString('base64')]]),
    });
    const agents = {
      stores,
      policy: {
        env: 'development' as const,
        lookup: () => Promise.resolve([{ address: '93.184.215.14', family: 4 as const }]),
      },
      writeRatePerMinute: 100,
    };
    const env = loadGatewayEnv(gatewayEnvFixture());
    const dev = buildApp({ env, auth: createRequestAuth(devAuthenticator), agents });
    cleanups.push(() => dev.close());
    const created = await dev.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: {
        name: 'Dev agent',
        protocol: 'cord-rest',
        endpoint_url: 'https://agent.example.com/cord/turns',
        credential: 'sk-dev-secret',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = created.json<{ id: string }>().id;

    const key = await signer('key-1');
    const jwks = await startJwks([key.jwk]);
    const signedIn = buildApp({
      env,
      auth: createRequestAuth(
        supabaseAuthenticator({ supabaseUrl: jwks.url, keys: supabaseJwks(jwks.url) }),
      ),
      agents,
      me: { deleteRatePerMinute: 100 },
    });
    cleanups.push(() => signedIn.close());
    const headers = { authorization: `Bearer ${await rawToken(key, jwks.url)}` };
    const list = await signedIn.inject({ method: 'GET', url: '/v1/agents', headers });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(agentId);
    const one = await signedIn.inject({ method: 'GET', url: `/v1/agents/${agentId}`, headers });
    expect(one.statusCode).toBe(404);
    // Deleting "my data" as a signed-in user leaves the dev-user rows alone.
    const deleted = await signedIn.inject({ method: 'DELETE', url: '/v1/me/data', headers });
    expect(deleted.statusCode).toBe(200);
    expect(await stores.agents.list(DEV_USER_ID)).toHaveLength(1);
    // And the dev token shape cannot claim it: a signed token with sub dev-user is refused.
    const forged = await rawToken(key, jwks.url, { payload: { sub: DEV_USER_ID } });
    const refused = await signedIn.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(refused.statusCode).toBe(401);
  });

  it('fails closed when a handler reads the user without the hook having run', () => {
    const auth = createRequestAuth(devAuthenticator);
    expect(() => auth.userFor({} as never)).toThrow(/not authenticated/);
  });
});

describe('profile claims', () => {
  it('reads the display name and email from a Supabase token, ignoring odd shapes', async () => {
    const key = await signer('key-1');
    const jwks = await startJwks([key.jwk]);
    const auth = createRequestAuth(
      supabaseAuthenticator({ supabaseUrl: jwks.url, keys: supabaseJwks(jwks.url) }),
    );
    const app = buildApp({
      env: loadGatewayEnv(gatewayEnvFixture()),
      auth,
      onError: () => undefined,
    });
    app.get('/v1/profile', (request) => auth.profileFor(request));
    cleanups.push(() => app.close());
    const profile = async (payload: Record<string, unknown>) => {
      const jwt = await rawToken(key, jwks.url, { payload });
      const res = await app.inject({
        method: 'GET',
        url: '/v1/profile',
        headers: { authorization: `Bearer ${jwt}` },
      });
      const body: unknown = res.json();
      return body;
    };
    expect(
      await profile({ email: 'a@x.org', user_metadata: { full_name: 'Alice L', name: 'al' } }),
    ).toEqual({ name: 'Alice L', email: 'a@x.org' });
    expect(await profile({ user_metadata: { name: 'al' } })).toEqual({ name: 'al' });
    expect(await profile({ email: 7, user_metadata: { full_name: { x: 1 } } })).toEqual({});
  });
});
