import { randomBytes } from 'node:crypto';

import { RELAY_TICKET_AUDIENCE } from '@twring/contracts';

import type { ServerIdentity } from './identity';

/**
 * How long a device ticket or install proof lives. The relay accepts up to 600 s; 540 leaves a
 * minute for clock difference between this server and the relay.
 */
export const RELAY_PROOF_LIFETIME_SECONDS = 540;

/** A fresh single-use id: 24 random bytes, 32 base64url characters. */
export function newJti(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * A one-time ticket the phone hands the relay to register its push tokens: a compact JWS (EdDSA,
 * server key) `{ iss: <server id>, sub: <device id>, aud: 'twring-relay', exp, jti }`.
 */
export function mintDeviceTicket(
  identity: ServerIdentity,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  return identity.sign({
    iss: identity.id,
    sub: deviceId,
    aud: RELAY_TICKET_AUDIENCE,
    iat: now,
    exp: now + RELAY_PROOF_LIFETIME_SECONDS,
    jti: newJti(),
  });
}
