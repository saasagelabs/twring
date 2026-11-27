import { utf8ToBytes } from '@noble/ciphers/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { SealError } from './seal-core';

/**
 * The code two phones compare when one approves the other (ADR-046). The new phone commits to its
 * key and a random secret before it sees the approving phone's random nonce, and reveals the
 * secret only after that nonce is fixed. So a server cannot search offline for a substitute key
 * that gives the same 6 digits: by the time it learns both random values, every key is fixed.
 */

const BYTES = 32;
const COMMIT_PREFIX = utf8ToBytes('twring-approval-commit-v1');
const SAS_PREFIX = utf8ToBytes('twring-approval-sas-v1');

function need32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== BYTES) throw new SealError(`${what} must be ${BYTES} bytes`);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A fresh 32-byte secret: the new phone's to commit to, or the approving phone's nonce. */
export function newApprovalSecret(): Uint8Array {
  return randomBytes(BYTES);
}

/** SHA-256("twring-approval-commit-v1" || newPhoneKey || secret). */
export function approvalCommitment(newPhoneKey: Uint8Array, secret: Uint8Array): Uint8Array {
  need32(newPhoneKey, 'public key');
  need32(secret, 'approval secret');
  return sha256(concat(COMMIT_PREFIX, newPhoneKey, secret));
}

/** Whether `secret` opens `commitment` for this key, compared in constant time. */
export function approvalCommitmentMatches(
  commitment: Uint8Array,
  newPhoneKey: Uint8Array,
  secret: Uint8Array,
): boolean {
  if (newPhoneKey.length !== BYTES || secret.length !== BYTES) return false;
  const expected = approvalCommitment(newPhoneKey, secret);
  if (commitment.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ commitment[i]!;
  return diff === 0;
}

/**
 * 6 digits shown as `123 456`: SHA-256("twring-approval-sas-v1" || newPhoneKey || approverKey ||
 * newNonce || approverNonce), first 4 bytes mod 10^6. Both phones pass the values in this order.
 */
export function approvalCode(
  newPhoneKey: Uint8Array,
  approverKey: Uint8Array,
  newNonce: Uint8Array,
  approverNonce: Uint8Array,
): string {
  need32(newPhoneKey, 'public key');
  need32(approverKey, 'public key');
  need32(newNonce, 'approval secret');
  need32(approverNonce, 'approval nonce');
  const h = sha256(concat(SAS_PREFIX, newPhoneKey, approverKey, newNonce, approverNonce));
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  const digits = String(n % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
