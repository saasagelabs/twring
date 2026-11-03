import { generateKeyPairSync } from 'node:crypto';

import Fastify from 'fastify';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { AppleRevokeError, AppleSignInRevoker, type AppleFetch } from './apple-signin';
import { registerMeRoutes } from './me/routes';

const keyPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const CONFIG = { keyPem, keyId: 'KEY1234567', teamId: 'TEAM123456', clientId: 'com.twring.app' };

type Answer = { status: number; body?: unknown } | Error;

/** A fake Apple: answers the token and revoke endpoints in order, and records the forms. */
function fakeApple(token: Answer, revoke: Answer = { status: 200 }) {
  const calls: { url: string; form: Record<string, string> }[] = [];
  const fetchImpl = vi.fn<AppleFetch>((url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    const answer = url.endsWith('/auth/token') ? token : revoke;
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({
      status: answer.status,
      json: () =>
        answer.body === undefined
          ? Promise.reject(new SyntaxError('empty'))
          : Promise.resolve(answer.body),
    });
  });
  return { calls, fetchImpl };
}

describe('AppleSignInRevoker', () => {
  it('exchanges the code and revokes the refresh token with a signed client secret', async () => {
    const apple = fakeApple({
      status: 200,
      body: { access_token: 'at', refresh_token: 'rt', id_token: 'x' },
    });
    const revoker = new AppleSignInRevoker(CONFIG, apple.fetchImpl);
    await expect(revoker.revokeCode('code-1')).resolves.toBe('revoked');

    expect(apple.calls.map((call) => call.url)).toEqual([
      'https://appleid.apple.com/auth/token',
      'https://appleid.apple.com/auth/revoke',
    ]);
    const [token, revoke] = apple.calls;
    expect(token?.form).toMatchObject({
      client_id: 'com.twring.app',
      code: 'code-1',
      grant_type: 'authorization_code',
    });
    expect(revoke?.form).toMatchObject({
      client_id: 'com.twring.app',
      token: 'rt',
      token_type_hint: 'refresh_token',
    });
    const secret = token?.form.client_secret ?? '';
    expect(decodeProtectedHeader(secret)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    const claims = decodeJwt(secret);
    expect(claims).toMatchObject({
      iss: 'TEAM123456',
      sub: 'com.twring.app',
      aud: 'https://appleid.apple.com',
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);
    expect(revoke?.form.client_secret).toBe(secret);
  });

  it('revokes the access token when Apple gives no refresh token', async () => {
    const apple = fakeApple({ status: 200, body: { access_token: 'at' } });
    await new AppleSignInRevoker(CONFIG, apple.fetchImpl).revokeCode('c');
    expect(apple.calls[1]?.form).toMatchObject({ token: 'at', token_type_hint: 'access_token' });
  });

  it('reports an expired or used code without revoking anything', async () => {
    const apple = fakeApple({ status: 400, body: { error: 'invalid_grant' } });
    await expect(new AppleSignInRevoker(CONFIG, apple.fetchImpl).revokeCode('old')).resolves.toBe(
      'invalid_code',
    );
    expect(apple.calls).toHaveLength(1);
  });

  it.each<[string, Answer, Answer, AppleRevokeError]>([
    [
      'Apple is unreachable',
      new TypeError('fetch failed'),
      { status: 200 },
      new AppleRevokeError('token', undefined),
    ],
    [
      'the token call fails',
      { status: 500, body: {} },
      { status: 200 },
      new AppleRevokeError('token', 500),
    ],
    [
      'the client is refused',
      { status: 400, body: { error: 'invalid_client' } },
      { status: 200 },
      new AppleRevokeError('token', 400),
    ],
    [
      'Apple sends no token',
      { status: 200, body: {} },
      { status: 200 },
      new AppleRevokeError('token', 200),
    ],
    [
      'the revoke fails',
      { status: 200, body: { refresh_token: 'rt' } },
      { status: 503 },
      new AppleRevokeError('revoke', 503),
    ],
  ])('throws when %s', async (_name, token, revoke, expected) => {
    const apple = fakeApple(token, revoke);
    await expect(
      new AppleSignInRevoker(CONFIG, apple.fetchImpl).revokeCode('c'),
    ).rejects.toMatchObject({ step: expected.step, status: expected.status });
  });

  it('reuses its client secret for a few minutes, then signs a new one', async () => {
    let now = 1_800_000_000_000;
    const apple = fakeApple({ status: 200, body: { refresh_token: 'rt' } });
    const revoker = new AppleSignInRevoker(CONFIG, apple.fetchImpl, { now: () => now });
    await revoker.revokeCode('a');
    await revoker.revokeCode('b');
    now += 9 * 60_000;
    await revoker.revokeCode('c');
    const secrets = apple.calls
      .filter((call) => call.url.endsWith('/auth/token'))
      .map((call) => call.form.client_secret);
    expect(secrets[0]).toBe(secrets[1]);
    expect(secrets[2]).not.toBe(secrets[0]);
  });
});

describe('POST /v1/me/apple-revoke', () => {
  async function server(revoker?: {
    revokeCode(code: string): Promise<'revoked' | 'invalid_code'>;
  }) {
    const app = Fastify();
    registerMeRoutes(app, {
      stores: undefined,
      deleteRatePerMinute: 2,
      ...(revoker !== undefined && { appleRevoker: revoker }),
    });
    await app.ready();
    return app;
  }
  const post = (app: Awaited<ReturnType<typeof server>>, body: unknown) =>
    app.inject({ method: 'POST', url: '/v1/me/apple-revoke', payload: body as object });

  it('revokes with the code from the phone: 204', async () => {
    const revokeCode = vi.fn(() => Promise.resolve('revoked' as const));
    const app = await server({ revokeCode });
    const response = await post(app, { authorization_code: 'code-1' });
    expect(response.statusCode).toBe(204);
    expect(revokeCode).toHaveBeenCalledWith('code-1');
  });

  it('says so when the server has no Sign in with Apple key: 503', async () => {
    const response = await post(await server(), { authorization_code: 'c' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
  });

  it.each([
    [{}],
    [{ authorization_code: '' }],
    [{ authorization_code: 'c', extra: 1 }],
    [{ authorization_code: 'x'.repeat(2049) }],
  ])('refuses a malformed body: 400 (%j)', async (body) => {
    const revokeCode = vi.fn(() => Promise.resolve('revoked' as const));
    const response = await post(await server({ revokeCode }), body);
    expect(response.statusCode).toBe(400);
    expect(revokeCode).not.toHaveBeenCalled();
  });

  it('explains an expired code (400) and an Apple failure (502)', async () => {
    const expired = await post(
      await server({ revokeCode: () => Promise.resolve('invalid_code') }),
      { authorization_code: 'c' },
    );
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ error: { code: 'invalid_request' } });

    const failed = await post(
      await server({ revokeCode: () => Promise.reject(new AppleRevokeError('revoke', 503)) }),
      { authorization_code: 'c' },
    );
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: { code: 'apple_revoke_failed' } });
  });

  it('is rate limited per caller', async () => {
    const app = await server({ revokeCode: () => Promise.resolve('revoked') });
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await post(app, { authorization_code: 'c' })).statusCode);
    }
    expect(statuses).toEqual([204, 204, 429]);
  });
});
