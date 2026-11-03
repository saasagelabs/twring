import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { base64urlDecode } from './seal-core';
import { serverIdFor, serverIdSchema } from './selfhost';

/**
 * Server identity proof: `GET /v1/server?nonce=...` answers the server's raw Ed25519 public key
 * and a compact JWS (EdDSA) by that key over `{ aud, server_id, nonce, iat }`. The app checks it
 * with `verifyServerProof`, so a server cannot claim another server's id without its key.
 */
export const SERVER_PROOF_AUDIENCE = 'twring-app/server';
/** How far `iat` may be from the phone's clock. */
export const SERVER_PROOF_MAX_SKEW_MS = 5 * 60_000;

/** The phone's fresh challenge: 16 to 64 base64url characters. */
export const serverNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);

/** The proof fields of a `/v1/server` answer (present only when a nonce was sent). */
export const serverProofInfoSchema = z.object({
  server_id: serverIdSchema,
  public_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  proof: z.string().max(2048).optional(),
});
export type ServerProofInfo = z.infer<typeof serverProofInfoSchema>;

export type ServerProofResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'wrong_server'
        | 'malformed'
        | 'id_mismatch'
        | 'bad_signature'
        | 'claims_mismatch';
    };

const proofClaimsSchema = z.object({
  aud: z.literal(SERVER_PROOF_AUDIENCE),
  server_id: serverIdSchema,
  nonce: serverNonceSchema,
  iat: z.number().int(),
});

/** JSON in base64url; the proof's header and claims are plain ASCII (anything else is refused). */
function decodeJson(part: string): unknown {
  const bytes = base64urlDecode(part);
  if (bytes.some((byte) => byte > 0x7f)) throw new Error('not ascii');
  return JSON.parse(String.fromCharCode(...bytes));
}

/** Pure check of a server's identity proof; never throws. */
export function verifyServerProof(
  info: { server_id: string; public_key?: string; proof?: string },
  /** `serverId`: the id the QR or the saved server named; any other server is refused. */
  expected: { nonce: string; nowMs: number; serverId: string },
): ServerProofResult {
  if (info.server_id !== expected.serverId) return { ok: false, reason: 'wrong_server' };
  if (info.public_key === undefined || info.proof === undefined) {
    return { ok: false, reason: 'missing' };
  }
  try {
    const publicKey = base64urlDecode(info.public_key);
    if (publicKey.length !== 32) return { ok: false, reason: 'malformed' };
    if (serverIdFor(publicKey) !== info.server_id) return { ok: false, reason: 'id_mismatch' };
    const parts = info.proof.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [header, payload, signature] = parts as [string, string, string];
    const head = decodeJson(header) as { alg?: unknown };
    if (head.alg !== 'EdDSA') return { ok: false, reason: 'malformed' };
    const signed = utf8ToBytes(`${header}.${payload}`);
    if (!ed25519.verify(base64urlDecode(signature), signed, publicKey)) {
      return { ok: false, reason: 'bad_signature' };
    }
    const claims = proofClaimsSchema.safeParse(decodeJson(payload));
    if (
      !claims.success ||
      claims.data.server_id !== info.server_id ||
      claims.data.nonce !== expected.nonce ||
      Math.abs(claims.data.iat * 1000 - expected.nowMs) > SERVER_PROOF_MAX_SKEW_MS
    ) {
      return { ok: false, reason: 'claims_mismatch' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
