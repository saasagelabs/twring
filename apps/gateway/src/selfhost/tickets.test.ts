import { generateKeyPairSync } from 'node:crypto';

import { base64urlEncode, RELAY_TICKET_AUDIENCE } from '@twring/contracts';
import { importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { serverIdentityFromKey } from './identity';
import { mintDeviceTicket, RELAY_PROOF_LIFETIME_SECONDS } from './tickets';

const identity = serverIdentityFromKey(generateKeyPairSync('ed25519').privateKey);

describe('mintDeviceTicket', () => {
  it('is an EdDSA JWS naming this server and the device, for the relay, 540 s', async () => {
    const nowMs = Date.parse('2026-10-29T10:00:00.000Z');
    const ticket = await mintDeviceTicket(identity, 'dev_abc', nowMs);
    const key = await importJWK(
      { kty: 'OKP', crv: 'Ed25519', x: base64urlEncode(identity.publicKeyRaw) },
      'EdDSA',
    );
    const { payload, protectedHeader } = await jwtVerify(ticket, key, {
      algorithms: ['EdDSA'],
      audience: RELAY_TICKET_AUDIENCE,
      issuer: identity.id,
      currentDate: new Date(nowMs),
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.sub).toBe('dev_abc');
    expect(payload.exp).toBe(nowMs / 1000 + RELAY_PROOF_LIFETIME_SECONDS);
    expect(RELAY_PROOF_LIFETIME_SECONDS).toBe(540);
    expect(payload.jti!.length).toBeGreaterThanOrEqual(16);
    const other = await mintDeviceTicket(identity, 'dev_abc', nowMs);
    const second = await jwtVerify(other, key, { currentDate: new Date(nowMs) });
    expect(second.payload.jti).not.toBe(payload.jti);
  });
});
