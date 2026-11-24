import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { base64urlDecode, base64urlEncode, SealError } from './seal-core';
import { MAX_QUOTE_CHARS, MAX_STORED_AGENT_MESSAGE_CHARS, threadMessageIdSchema } from './threads';

/**
 * Private chat sealing (ADR-044). Each message gets a fresh random key; the body is
 * XChaCha20-Poly1305 with an AAD that binds account, agent, sender device and per-sender seq.
 * The message key is wrapped to every trusted device with static X25519 (sender device key with
 * the recipient device key), so a recipient knows which of its verified devices sealed it: the
 * server knows every public key but holds no device private key, so it cannot forge a wrap.
 *
 * `seal-core.ts` (push sealing) is deliberately not used for the AEAD: it takes no AAD and push
 * sealing depends on it staying as it is. Pure @noble, so it runs in Node and in Hermes.
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 24;
const utf8 = { encode: utf8ToBytes };
const WRAP_INFO = utf8.encode('twring-e2e-wrap-v1');
const SAFETY_PREFIX = utf8.encode('twring-safety-v1');
const DEVICE_ID_PREFIX = utf8.encode('twring-device-id-v1');

function need32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== KEY_BYTES) throw new SealError(`${what} must be ${KEY_BYTES} bytes`);
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

export function newMessageKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/** AAD for a message body and its wrapped keys. The server's message id is not bound (R2). */
export function messageAad(a: {
  accountId: string;
  agentId: string;
  senderDevice: string;
  senderSeq: number;
  chunk?: number;
}): Uint8Array {
  return utf8.encode(
    JSON.stringify([
      'twring-e2e-v1',
      a.accountId,
      a.agentId,
      a.senderDevice,
      a.senderSeq,
      a.chunk ?? null,
    ]),
  );
}

/** AAD for a sealed file: sealed before upload, so no upload id; its key rides the payload. */
export function fileAad(a: { accountId: string; agentId: string }): Uint8Array {
  return utf8.encode(JSON.stringify(['twring-e2e-file-v1', a.accountId, a.agentId]));
}

function wrapKeyFor(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  need32(myPrivate, 'private key');
  need32(theirPublic, 'public key');
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(myPrivate, theirPublic);
  } catch {
    throw new SealError('key agreement failed');
  }
  return hkdf(sha256, shared, undefined, WRAP_INFO, KEY_BYTES);
}

function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  return concat(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plaintext));
}

function aeadOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array) {
  if (nonce.length !== NONCE_BYTES) throw new SealError('could not open sealed contents');
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    throw new SealError('could not open sealed contents');
  }
}

/** Sender-authenticated wrap: `base64url(nonce || ciphertext)`. Never an ephemeral key (R1). */
export function wrapKey(
  messageKey: Uint8Array,
  senderPrivate: Uint8Array,
  recipientPublic: Uint8Array,
  aad: Uint8Array,
): string {
  need32(messageKey, 'message key');
  return base64urlEncode(aeadSeal(wrapKeyFor(senderPrivate, recipientPublic), messageKey, aad));
}

/**
 * Throws SealError. `senderPublic` must come from the receiver's own verified device list,
 * looked up by `sender_device`, never from the server.
 */
export function unwrapKey(
  wrapped: string,
  myPrivate: Uint8Array,
  senderPublic: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const bytes = base64urlDecode(wrapped);
  if (bytes.length <= NONCE_BYTES) throw new SealError('could not open sealed contents');
  const key = aeadOpen(
    wrapKeyFor(myPrivate, senderPublic),
    bytes.subarray(0, NONCE_BYTES),
    bytes.subarray(NONCE_BYTES),
    aad,
  );
  need32(key, 'message key');
  return key;
}

export const sealedPayloadSchema = z
  .object({
    text: z.string().max(MAX_STORED_AGENT_MESSAGE_CHARS),
    quote: z
      .object({ message_id: threadMessageIdSchema, text: z.string().max(MAX_QUOTE_CHARS + 1) })
      .strict()
      .optional(),
    files: z
      .array(
        z
          .object({
            file_id: z.string().min(1).max(64),
            key: z.string().max(64),
            name: z.string().min(1).max(255),
            mime: z.string().min(1).max(255),
            size: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    voice: z.literal(false).optional(),
  })
  .strict();
export type SealedPayload = z.infer<typeof sealedPayloadSchema>;

export function sealBody(
  messageKey: Uint8Array,
  plaintext: SealedPayload,
  aad: Uint8Array,
): { nonce: string; body: string } {
  need32(messageKey, 'message key');
  const payload = sealedPayloadSchema.parse(plaintext);
  const sealed = aeadSeal(messageKey, utf8.encode(JSON.stringify(payload)), aad);
  return {
    nonce: base64urlEncode(sealed.subarray(0, NONCE_BYTES)),
    body: base64urlEncode(sealed.subarray(NONCE_BYTES)),
  };
}

/** Throws SealError for the wrong key, a different AAD, tampering or a malformed payload. */
export function openBody(
  messageKey: Uint8Array,
  nonce: string,
  body: string,
  aad: Uint8Array,
): SealedPayload {
  need32(messageKey, 'message key');
  const plain = aeadOpen(messageKey, base64urlDecode(nonce), base64urlDecode(body), aad);
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(plain));
  } catch {
    throw new SealError('malformed sealed payload');
  }
  const parsed = sealedPayloadSchema.safeParse(json);
  if (!parsed.success) throw new SealError('malformed sealed payload');
  return parsed.data;
}

/** HMAC-SHA256 over both public keys with the QR's pairing secret, in a fixed order. */
export function pairingMac(
  secret: Uint8Array,
  connectorPublic: Uint8Array,
  phonePublic: Uint8Array,
): string {
  need32(connectorPublic, 'public key');
  need32(phonePublic, 'public key');
  return base64urlEncode(hmac(sha256, secret, concat(connectorPublic, phonePublic)));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** 6 digits shown on both screens as `123 456`; the same whichever side computes it. */
export function safetyCode(a: Uint8Array, b: Uint8Array): string {
  need32(a, 'public key');
  need32(b, 'public key');
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const h = sha256(concat(SAFETY_PREFIX, first, second));
  const n = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
  const digits = String(n % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** `dev_` plus 20 base32 characters (100 bits) of a hash of the device's public key. */
export function deviceIdFor(publicKey: Uint8Array): string {
  need32(publicKey, 'public key');
  const h = sha256(concat(DEVICE_ID_PREFIX, publicKey));
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; out.length < 20; i++) {
    acc = (acc << 8) | h[i]!;
    bits += 8;
    while (bits >= 5 && out.length < 20) {
      bits -= 5;
      out += BASE32[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return `dev_${out}`;
}
