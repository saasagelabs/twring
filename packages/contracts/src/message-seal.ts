import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';

import { base64urlDecode, base64urlEncode, SealError } from './seal-core';
import {
  e2eDeviceIdSchema,
  e2eDeviceKindSchema,
  MAX_PAIRED_DEVICES,
  phoneApprovalIdSchema,
  publicKeySchema,
  type TrustNote,
} from './sealed-chat';
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
const PAIR_MAC_PREFIX = utf8.encode('twring-pair-mac-v1');

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

/**
 * AAD for a message body and its wrapped keys. The server's message id is not bound (R2).
 *
 * With `chunk` and `final` given it is v2 and binds the chunk's final flag too, so the server
 * cannot cut a streamed reply short by marking an earlier chunk final (ADR-044 amendment).
 * Without `final` it is byte for byte v1. The version tag differs, so a v2 seal never opens
 * under a v1 AAD.
 */
export function messageAad(a: {
  accountId: string;
  agentId: string;
  senderDevice: string;
  senderSeq: number;
  chunk?: number;
  final?: boolean;
}): Uint8Array {
  if (a.chunk !== undefined && a.final !== undefined)
    return utf8.encode(
      JSON.stringify([
        'twring-e2e-v2',
        a.accountId,
        a.agentId,
        a.senderDevice,
        a.senderSeq,
        a.chunk,
        a.final,
      ]),
    );
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

/**
 * AAD for a trust note (C3 #11, Task 27): binds the approval and the approving phone. No account
 * id: `messageAad`'s account id is a computer's connector id, and a note goes to every device of
 * the account; the wraps already name each recipient's key.
 */
export function trustNoteAad(a: { approvalId: string; senderDevice: string }): Uint8Array {
  return utf8.encode(JSON.stringify(['twring-trust-v1', a.approvalId, a.senderDevice]));
}

/** AAD for a sealed file: sealed before upload, so no upload id; its key rides the payload. */
export function fileAad(a: { accountId: string; agentId: string }): Uint8Array {
  return utf8.encode(JSON.stringify(['twring-e2e-file-v1', a.accountId, a.agentId]));
}

/** Bytes a sealed file adds: the 24-byte nonce in front and the 16-byte tag (ADR-045). */
export const SEALED_FILE_OVERHEAD = NONCE_BYTES + 16;

export function newFileKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/** A file sealed with its own key: nonce || ciphertext || tag. The key rides in the sealed message. */
export function sealFile(key: Uint8Array, bytes: Uint8Array, aad: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) throw new SealError('could not seal contents');
  return aeadSeal(key, bytes, aad);
}

/** Files are never empty: the phone and the connector refuse 0-byte files before sealing. */
export function openFile(key: Uint8Array, blob: Uint8Array, aad: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES || blob.length <= SEALED_FILE_OVERHEAD)
    throw new SealError('could not open sealed contents');
  return aeadOpen(key, blob.subarray(0, NONCE_BYTES), blob.subarray(NONCE_BYTES), aad);
}

/**
 * The wrap key depends only on (my private key, their public key), and one X25519 costs about
 * 3 ms, so opening a long thread would spend seconds on it. Cache it in memory, bounded, keyed by
 * a hash of both keys (never the private key itself). Oldest entry goes first.
 */
const WRAP_CACHE_MAX = 32;
const WRAP_CACHE_TAG = utf8.encode('twring-wrap-cache-v1');
const wrapKeyCache = new Map<string, Uint8Array>();

/** For tests: how many wrap keys are cached. */
export function wrapKeyCacheSize(): number {
  return wrapKeyCache.size;
}

function wrapKeyFor(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  need32(myPrivate, 'private key');
  need32(theirPublic, 'public key');
  const cacheKey = base64urlEncode(sha256(concat(WRAP_CACHE_TAG, myPrivate, theirPublic)));
  const cached = wrapKeyCache.get(cacheKey);
  if (cached) return cached;
  const derived = deriveWrapKey(myPrivate, theirPublic);
  if (wrapKeyCache.size >= WRAP_CACHE_MAX) {
    const oldest = wrapKeyCache.keys().next().value;
    if (oldest !== undefined) wrapKeyCache.delete(oldest);
  }
  wrapKeyCache.set(cacheKey, derived);
  return derived;
}

function deriveWrapKey(myPrivate: Uint8Array, theirPublic: Uint8Array): Uint8Array {
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
      .object({
        message_id: threadMessageIdSchema,
        text: z.string().max(MAX_QUOTE_CHARS + 1),
        /** Whose message is quoted; the agent reads "your" or "my" earlier message. */
        from: z.enum(['agent', 'owner']).optional(),
      })
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
    /** Not a message: the sender could not open the message this answers (`text` is empty). */
    notice: z.literal('couldnt_open').optional(),
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

/** A sealed approval's id: made by the computer, 130 random bits, never by the server. */
export const sealedApprovalIdSchema = z.string().regex(/^apv_[a-z2-7]{26}$/);

/** Same limits as a plain approval card (threads.ts `approval`). */
export const MAX_SEALED_APPROVAL_TITLE_CHARS = 140;
export const MAX_SEALED_APPROVAL_DESCRIPTION_CHARS = 500;

/** A device as a trust note names it. */
const trustEntrySchema = z
  .object({
    id: e2eDeviceIdSchema,
    kind: e2eDeviceKindSchema,
    name: z.string().min(1).max(60),
    public_key: publicKeySchema,
    connector_id: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Sealed approvals in private chats (C3 #11). Not a chat message: `kind` is required here and
 * absent from `sealedPayloadSchema` (strict), so one can never be opened as the other.
 */
export const sealedControlPayloadSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approval'),
      approval_id: sealedApprovalIdSchema,
      title: z.string().max(MAX_SEALED_APPROVAL_TITLE_CHARS),
      description: z.string().max(MAX_SEALED_APPROVAL_DESCRIPTION_CHARS).optional(),
      expires_at: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval_decision'),
      approval_id: sealedApprovalIdSchema,
      decision: z.enum(['approve', 'deny']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('trust_add'),
      approval_id: phoneApprovalIdSchema,
      add: trustEntrySchema.extend({ kind: z.literal('phone') }).strict(),
      /** The approving phone's trusted devices; only the new phone reads these. */
      known: z.array(trustEntrySchema).max(MAX_PAIRED_DEVICES),
    })
    .strict(),
]);
export type SealedControlPayload = z.infer<typeof sealedControlPayloadSchema>;

export function sealControl(
  messageKey: Uint8Array,
  plaintext: SealedControlPayload,
  aad: Uint8Array,
): { nonce: string; body: string } {
  need32(messageKey, 'message key');
  const payload = sealedControlPayloadSchema.parse(plaintext);
  const sealed = aeadSeal(messageKey, utf8.encode(JSON.stringify(payload)), aad);
  return {
    nonce: base64urlEncode(sealed.subarray(0, NONCE_BYTES)),
    body: base64urlEncode(sealed.subarray(NONCE_BYTES)),
  };
}

/** Throws SealError, as `openBody` does, also for a chat message's payload. */
export function openControl(
  messageKey: Uint8Array,
  nonce: string,
  body: string,
  aad: Uint8Array,
): SealedControlPayload {
  need32(messageKey, 'message key');
  const plain = aeadOpen(messageKey, base64urlDecode(nonce), base64urlDecode(body), aad);
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(plain));
  } catch {
    throw new SealError('malformed sealed payload');
  }
  const parsed = sealedControlPayloadSchema.safeParse(json);
  if (!parsed.success) throw new SealError('malformed sealed payload');
  return parsed.data;
}

export type TrustAddPayload = Extract<SealedControlPayload, { kind: 'trust_add' }>;

/**
 * Seals a trust note: a fresh key, the payload with `trustNoteAad`, and the key wrapped by the
 * approving phone (sender-authenticated) to each recipient.
 */
export function sealTrustNote(a: {
  payload: TrustAddPayload;
  senderDevice: string;
  senderPrivate: Uint8Array;
  recipients: { id: string; publicKey: Uint8Array }[];
}): TrustNote {
  if (a.recipients.length === 0 || a.recipients.length > MAX_PAIRED_DEVICES)
    throw new SealError('bad recipient count');
  const aad = trustNoteAad({ approvalId: a.payload.approval_id, senderDevice: a.senderDevice });
  const key = newMessageKey();
  const sealed = sealControl(key, a.payload, aad);
  return {
    approval_id: a.payload.approval_id,
    sender_device: a.senderDevice,
    ...sealed,
    keys: a.recipients.map((r) => ({
      device: r.id,
      wrapped: wrapKey(key, a.senderPrivate, r.publicKey, aad),
    })),
  };
}

/**
 * Opens a trust note for this device. Throws SealError when no key is wrapped to it, the wrap or
 * body does not open with `senderPublic` (which must come from the opener's own trusted list), or
 * the payload is not a `trust_add` for the note's approval.
 */
export function openTrustNote(
  note: TrustNote,
  me: { deviceId: string; privateKey: Uint8Array },
  senderPublic: Uint8Array,
): TrustAddPayload {
  const wrapped = note.keys.find((k) => k.device === me.deviceId);
  if (wrapped === undefined) throw new SealError('no key for this device');
  const aad = trustNoteAad({ approvalId: note.approval_id, senderDevice: note.sender_device });
  const key = unwrapKey(wrapped.wrapped, me.privateKey, senderPublic, aad);
  const payload = openControl(key, note.nonce, note.body, aad);
  if (payload.kind !== 'trust_add' || payload.approval_id !== note.approval_id)
    throw new SealError('not a trust note');
  return payload;
}

/** What the phone's pairing MAC covers: everything the computer saves about the pair. */
export interface PairingMacInput {
  connectorPublic: Uint8Array;
  phonePublic: Uint8Array;
  connectorDeviceId: string;
  phoneDeviceId: string;
  phoneName: string;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

/**
 * HMAC-SHA256 with the QR's pairing secret over, in this order, `twring-pair-mac-v1`, then the
 * computer's public key, the phone's public key, the computer's device id, the phone's device id
 * and the phone's name, each as a 4-byte big-endian length and its bytes (text as UTF-8, as sent).
 * Binding the ids and name stops a server giving a new phone a trusted device's id.
 */
export function pairingMac(secret: Uint8Array, input: PairingMacInput): string {
  need32(input.connectorPublic, 'public key');
  need32(input.phonePublic, 'public key');
  const data = concat(
    PAIR_MAC_PREFIX,
    ...[
      input.connectorPublic,
      input.phonePublic,
      utf8.encode(input.connectorDeviceId),
      utf8.encode(input.phoneDeviceId),
      utf8.encode(input.phoneName),
    ].map(lengthPrefixed),
  );
  return base64urlEncode(hmac(sha256, secret, data));
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

/**
 * Typed pairing code (C3 #11): the fallback for people who cannot scan the QR. 16 Crockford
 * base32 characters (80 bits) shown as `7KQ2-M9XD-4HTP-W3RV`. The first group is a lookup handle
 * the server sees; the other 12 characters are a 60-bit secret it never sees, made into a second
 * MAC key on the same offer (`typedPairKey`). The QR and its 32-byte secret stay as they are.
 */
export const TYPED_PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TYPED_PAIR_LENGTH = 16;
const TYPED_PAIR_HANDLE_LENGTH = 4;
const TYPED_PAIR_INFO = utf8.encode('twring-pair-typed-v1');
const PAIR_OFFER_PREFIX = utf8.encode('twring-pair-offer-v1');

/** A fresh code from 10 random bytes, without dashes. */
export function newTypedPairCode(): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of randomBytes(10)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += TYPED_PAIR_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** `7KQ2M9XD4HTPW3RV` as `7KQ2-M9XD-4HTP-W3RV`. */
export function formatTypedPairCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/**
 * What a person typed, as the 16-character code: any case, dashes and spaces ignored, O read as
 * 0 and I or L as 1 (Crockford). Anything else (U included) or another length is undefined.
 */
export function normalizeTypedPairCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
  if (code.length !== TYPED_PAIR_LENGTH) return undefined;
  for (const char of code) if (!TYPED_PAIR_ALPHABET.includes(char)) return undefined;
  return code;
}

/** A normalised code's lookup handle (first group) and secret (the other 12 characters). */
export function splitTypedPairCode(code: string): { handle: string; secret: string } {
  return {
    handle: code.slice(0, TYPED_PAIR_HANDLE_LENGTH),
    secret: code.slice(TYPED_PAIR_HANDLE_LENGTH),
  };
}

/** The typed code's MAC key: HKDF-SHA256 over the secret's 12 characters (ASCII), no salt. */
export function typedPairKey(secret: string): Uint8Array {
  return hkdf(sha256, utf8.encode(secret), undefined, TYPED_PAIR_INFO, KEY_BYTES);
}

/**
 * Key commitment the computer registers with its offer: HMAC-SHA256 with the typed key over
 * `twring-pair-offer-v1`, the computer's public key and its device id (each length-prefixed as in
 * `pairingMac`). With a typed code the phone learns the computer's key from the server, so it
 * checks this first: a server that swaps the key cannot make a valid one without the secret.
 */
export function offerKeyMac(
  typedKey: Uint8Array,
  connectorPublic: Uint8Array,
  connectorDeviceId: string,
): string {
  need32(connectorPublic, 'public key');
  const data = concat(
    PAIR_OFFER_PREFIX,
    lengthPrefixed(connectorPublic),
    lengthPrefixed(utf8.encode(connectorDeviceId)),
  );
  return base64urlEncode(hmac(sha256, typedKey, data));
}

/** Constant-time check of `offerKeyMac`; false for anything malformed. */
export function offerKeyMacMatches(
  typedKey: Uint8Array,
  connectorPublic: Uint8Array,
  connectorDeviceId: string,
  mac: string,
): boolean {
  let given: Uint8Array;
  try {
    given = base64urlDecode(mac);
  } catch {
    return false;
  }
  const expected = base64urlDecode(offerKeyMac(typedKey, connectorPublic, connectorDeviceId));
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
  return diff === 0;
}

/** Why a listed device's trust note was not applied (logged as a reason only). */
export type TrustNoteRefusal =
  | 'no_note'
  | 'sender_not_trusted'
  | 'not_for_me'
  | 'unopenable'
  | 'wrong_device'
  /** The server said this device was removed before; a note never brings it back. */
  | 'removed';

/**
 * The rule both the computer and the phone apply to a device the server lists with a trust note
 * (C3 #11 P4b ruling 4): the note's sender must be a phone in my own trusted list, the note must
 * open with that phone's key, and it must name exactly the listed id and key, the id being the
 * key's. The caller passes only listed, active devices it does not trust yet.
 */
export function checkTrustNote(
  listed: { id: string; public_key: string; trust_note?: TrustNote },
  trusted: readonly { id: string; kind: string; public_key: string }[],
  me: { deviceId: string; privateKey: Uint8Array },
): { ok: true; add: TrustAddPayload['add'] } | { ok: false; reason: TrustNoteRefusal } {
  const note = listed.trust_note;
  if (note === undefined) return { ok: false, reason: 'no_note' };
  const sender = trusted.find((d) => d.id === note.sender_device && d.kind === 'phone');
  if (sender === undefined) return { ok: false, reason: 'sender_not_trusted' };
  if (!note.keys.some((k) => k.device === me.deviceId)) return { ok: false, reason: 'not_for_me' };
  let payload: TrustAddPayload;
  try {
    payload = openTrustNote(note, me, base64urlDecode(sender.public_key));
  } catch {
    return { ok: false, reason: 'unopenable' };
  }
  const { add } = payload;
  if (add.id !== listed.id || add.public_key !== listed.public_key || !keyMatchesId(add))
    return { ok: false, reason: 'wrong_device' };
  return { ok: true, add };
}

/** `deviceIdFor(public_key) === id`, false for a malformed key. */
export function keyMatchesId(device: { id: string; public_key: string }): boolean {
  try {
    return deviceIdFor(base64urlDecode(device.public_key)) === device.id;
  } catch {
    return false;
  }
}
