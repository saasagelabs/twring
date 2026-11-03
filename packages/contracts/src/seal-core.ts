import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { SEALED_CIPHERTEXT_MAX_CHARS, sealedEnvelopeSchema, type SealedEnvelope } from './selfhost';

/**
 * Sealed notification contents: what the Twring relay forwards (push body, ring details) is
 * encrypted end to end between a person's server and their phone, so the relay never reads it.
 *
 * X25519 key agreement, HKDF-SHA256 (info `twring-seal-v1`) to a 32-byte key, XChaCha20-Poly1305
 * with a random 24-byte nonce. Pure functions on @noble/*: no node:crypto and no Buffer, so the
 * same file runs in Node and in React Native (Hermes). Hermes needs a `crypto.getRandomValues`
 * polyfill (the app provides one) for the key and nonce generators.
 */

const SEAL_INFO = Uint8Array.from('twring-seal-v1', (ch) => ch.charCodeAt(0));
const KEY_BYTES = 32;
const NONCE_BYTES = 24;

export class SealError extends Error {
  readonly code = 'seal_failed';
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_INDEX: Record<string, number> = Object.fromEntries(
  Array.from(B64URL, (ch, i) => [ch, i]),
);

/** Unpadded base64url, without Buffer or btoa. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict decoder: unpadded base64url only. Throws SealError on anything else. */
export function base64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new SealError('invalid base64url length');
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of text) {
    const v = B64URL_INDEX[ch];
    if (v === undefined) throw new SealError('invalid base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

function need32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== KEY_BYTES) throw new SealError(`${what} must be ${KEY_BYTES} bytes`);
}

export function generateSealKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = x25519.utils.randomSecretKey();
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** Both sides call this with their own private key and the other's public key: same result. */
export function deriveSealKey(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  need32(myPrivate, 'private key');
  need32(theirPublic, 'public key');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(myPrivate, theirPublic);
  } catch {
    throw new SealError('key agreement failed');
  }
  return hkdf(sha256, shared, undefined, SEAL_INFO, KEY_BYTES);
}

/** Most plaintext bytes one envelope can carry: the schema's ciphertext bound minus the 16-byte tag. */
export const MAX_SEAL_PLAINTEXT_BYTES = Math.floor((SEALED_CIPHERTEXT_MAX_CHARS * 3) / 4) - 16;

/** Internal: seals with a caller-chosen nonce. Only seal() and the known-answer test use it. */
export function sealWithNonce(
  key: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): SealedEnvelope {
  need32(key, 'seal key');
  if (nonce.length !== NONCE_BYTES) throw new SealError(`nonce must be ${NONCE_BYTES} bytes`);
  if (plaintext.length > MAX_SEAL_PLAINTEXT_BYTES) throw new SealError('plaintext too large');
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return { v: 1, n: base64urlEncode(nonce), c: base64urlEncode(ciphertext) };
}

/** Throws SealError for a malformed envelope, a tampered one, or the wrong key. */
export function open(key: Uint8Array, envelope: SealedEnvelope): Uint8Array {
  need32(key, 'seal key');
  const parsed = sealedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new SealError('malformed envelope');
  const nonce = base64urlDecode(parsed.data.n);
  const ciphertext = base64urlDecode(parsed.data.c);
  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    throw new SealError('could not open sealed contents');
  }
}
