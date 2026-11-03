import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { highestBuildNumber, makeAscToken, nextBuildNumber } from './next-ios-build-number.mjs';

/** The TestFlight workflow's build number: one past the highest build App Store Connect has. */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const b64url = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('makeAscToken', () => {
  it('signs an ES256 token App Store Connect accepts', () => {
    const token = makeAscToken({
      keyId: 'KEY123',
      issuerId: 'issuer-1',
      privateKeyPem: pem,
      nowSeconds: 1000,
    });
    const [h = '', p = '', s = ''] = token.split('.');
    expect(b64url(h)).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(b64url(p)).toEqual({ iss: 'issuer-1', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });
});

describe('highestBuildNumber', () => {
  it('takes the highest leading integer of each build version', () => {
    const body = {
      data: [
        { attributes: { version: '17' } },
        { attributes: { version: '9' } },
        { attributes: { version: '18.1' } },
      ],
    };
    expect(highestBuildNumber(body)).toBe(18);
  });

  it('is 0 with no builds and ignores versions without a leading number', () => {
    expect(highestBuildNumber({ data: [] })).toBe(0);
    expect(highestBuildNumber({ data: [{ attributes: { version: 'beta' } }] })).toBe(0);
  });
});

describe('nextBuildNumber', () => {
  it('asks for the app builds and returns the highest plus one', async () => {
    let url = '';
    let auth = '';
    const fetchImpl = (u, init) => {
      url = u;
      auth = init.headers.Authorization ?? '';
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ attributes: { version: '17' } }] }), {
          status: 200,
        }),
      );
    };
    await expect(nextBuildNumber({ fetchImpl, appId: '6824735840', token: 'tok' })).resolves.toBe(
      18,
    );
    expect(url).toContain('/v1/builds?');
    expect(url).toContain('filter%5Bapp%5D=6824735840');
    expect(auth).toBe('Bearer tok');
  });

  it('stops with the status and Apple error title, never the token', async () => {
    const fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            errors: [{ title: 'Authentication credentials are missing or invalid.' }],
          }),
          { status: 401 },
        ),
      );
    const err = await nextBuildNumber({ fetchImpl, appId: '1', token: 'secret-token' }).catch(
      (e) => e,
    );
    expect(String(err)).toContain('401');
    expect(String(err)).toContain('Authentication credentials are missing or invalid.');
    expect(String(err)).not.toContain('secret-token');
  });
});
