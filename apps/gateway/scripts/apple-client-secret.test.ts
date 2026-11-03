import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { appleClientSecret } from './apple-client-secret';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const NOW = new Date('2026-10-22T12:00:00.000Z');

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('appleClientSecret', () => {
  it('is an ES256 token Apple accepts: header, claims, and a signature the key verifies', () => {
    const { token, expiresAt } = appleClientSecret({
      keyPem: pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      clientId: 'com.twring.web',
      now: NOW,
    });
    const [header, payload, signature] = token.split('.');
    expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
    const claims = decode(payload!);
    expect(claims).toMatchObject({
      iss: 'TEAM123456',
      sub: 'com.twring.web',
      aud: 'https://appleid.apple.com',
      iat: NOW.getTime() / 1000,
    });
    // Apple allows at most six months; stay a day under it.
    expect(claims.exp).toBe(NOW.getTime() / 1000 + 179 * 86_400);
    expect(expiresAt.toISOString()).toBe('2027-04-19T12:00:00.000Z');
    const ok = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature!, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('refuses ids that are not what Apple issues', () => {
    const base = {
      keyPem: pem,
      keyId: 'ABC123DEFG',
      teamId: 'TEAM123456',
      clientId: 'com.twring.web',
    };
    expect(() => appleClientSecret({ ...base, keyId: 'abc' })).toThrow(/key id/i);
    expect(() => appleClientSecret({ ...base, teamId: 'x' })).toThrow(/team id/i);
    expect(() => appleClientSecret({ ...base, clientId: 'not a services id' })).toThrow(
      /services id/i,
    );
  });
});
