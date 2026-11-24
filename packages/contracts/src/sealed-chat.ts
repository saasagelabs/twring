import { z } from 'zod';

/**
 * Private chats with computer agents (ADR-044): what travels between the phone, the Twring
 * server and the connector when a chat is sealed end to end. The server stores and relays these
 * shapes but never holds a key that opens them.
 */

/** Capability both the app and the connector report before a chat can become private. */
export const SEALED_CHAT_FEATURE = 'sealed_chat';
export const MAX_PAIRED_DEVICES = 5;
export const SEALED_FORMAT_VERSION = 1;

/**
 * Most ciphertext characters (base64url) one sealed body may hold: a 4,000-character message,
 * a 280-character quote and 10 file keys, each counted at 4 UTF-8 bytes per character, plus room
 * for JSON and the AEAD tag.
 */
export const MAX_SEALED_BODY_CHARS =
  Math.ceil(((4 * 4000 + 4 * 280 + 10 * 120 + 512) * 4) / 3) + 24;

/**
 * Most ciphertext characters one sealed agent reply may hold: a 20,000-character reply at 4 UTF-8
 * bytes per character plus room for JSON and the tag. One relay frame (MAX_RELAY_MESSAGE_BYTES)
 * still bounds what a single `sealed.reply` can carry.
 */
export const MAX_SEALED_AGENT_BODY_CHARS = Math.ceil(((4 * 20_000 + 1024) * 4) / 3) + 24;

/**
 * A computer splits a long reply so no relay frame exceeds MAX_RELAY_MESSAGE_BYTES: each chunk is
 * its own envelope, and the server keeps them all, in chunk order, in one message. At most this
 * many chunks per reply.
 */
export const MAX_SEALED_REPLY_CHUNKS = 64;
/**
 * Most ciphertext characters all chunks of one reply hold together. A computer cuts a reply at
 * 20,000 UTF-16 units, and JSON escapes a control character such as U+0001 to 6 bytes, so the
 * sealed text is at most 120,000 bytes, base64url 4/3 of that. Each chunk adds its own JSON wrapper, AEAD
 * tag and base64 padding (under 40 characters); 64 per chunk leaves room for the computer's short
 * failure note.
 */
export const MAX_SEALED_REPLY_TOTAL_CHARS =
  Math.ceil((6 * 20_000 * 4) / 3) + MAX_SEALED_REPLY_CHUNKS * 64;

const MAX_WRAPPED_KEY_CHARS = 128;

/**
 * Unpadded base64url of exactly 32 bytes: 43 characters, the last one carrying 4 data bits.
 * Checked by pattern, not by decoding, so this file imports nothing that imports connectors.ts.
 */
const BYTES32_B64URL = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]*$/);

export const e2eDeviceIdSchema = z.string().regex(/^dev_[a-z2-7]{20}$/);
export type E2eDeviceId = z.infer<typeof e2eDeviceIdSchema>;

export const e2eDeviceKindSchema = z.enum(['phone', 'computer']);
export type E2eDeviceKind = z.infer<typeof e2eDeviceKindSchema>;

/** An X25519 public key: base64url that decodes to exactly 32 bytes. */
export const publicKeySchema = z.string().regex(BYTES32_B64URL);

/** A message key wrapped for one device (sender-authenticated, see message-seal.ts). */
export const wrappedKeySchema = z
  .object({
    device: e2eDeviceIdSchema,
    wrapped: base64urlSchema.min(1).max(MAX_WRAPPED_KEY_CHARS),
  })
  .strict();
export type WrappedKey = z.infer<typeof wrappedKeySchema>;

const sealedEnvelopeWithBody = (maxBodyChars: number) =>
  z
    .object({
      v: z.literal(SEALED_FORMAT_VERSION),
      sender_device: e2eDeviceIdSchema,
      sender_seq: z.number().int().positive(),
      nonce: base64urlSchema.min(1).max(64),
      body: base64urlSchema.min(1).max(maxBodyChars),
      keys: z.array(wrappedKeySchema).min(1).max(MAX_PAIRED_DEVICES),
      /** Streamed agent replies: chunks share one message key; the index is bound into the AAD. */
      chunk: z
        .object({ index: z.number().int().nonnegative(), final: z.boolean() })
        .strict()
        .optional(),
    })
    .strict();

/** A sealed message from a person's phone (or any sender at the person's message cap). */
export const sealedEnvelopeV1Schema = sealedEnvelopeWithBody(MAX_SEALED_BODY_CHARS);
/** A sealed agent reply: the same envelope, with room for the longer agent text. */
export const sealedAgentEnvelopeV1Schema = sealedEnvelopeWithBody(MAX_SEALED_AGENT_BODY_CHARS);
export type SealedEnvelopeV1 = z.infer<typeof sealedEnvelopeV1Schema>;

export const e2eDeviceSchema = z
  .object({
    id: e2eDeviceIdSchema,
    kind: e2eDeviceKindSchema,
    name: z.string().min(1).max(60),
    public_key: publicKeySchema,
    connector_id: z.string().min(1).max(64).optional(),
    added_at: z.iso.datetime(),
    revoked_at: z.iso.datetime().optional(),
  })
  .strict();
export type E2eDevice = z.infer<typeof e2eDeviceSchema>;

export const pairOfferIdSchema = z.string().regex(/^off_[a-z2-7]{20}$/);

/** What the connector's pairing QR carries (base64url JSON). `secret` is 32 random bytes. */
export const pairOfferSchema = z
  .object({
    offer_id: pairOfferIdSchema,
    connector_public_key: publicKeySchema,
    secret: z.string().regex(BYTES32_B64URL),
  })
  .strict();
export type PairOffer = z.infer<typeof pairOfferSchema>;

/** Same alphabet as `PAIRING_CODE_ALPHABET` (connectors.ts imports this file, so not imported). */
const pairChar = '[ABCDEFGHJKMNPQRSTUVWXYZ23456789]';
/** The typed fallback for the QR: `XXXX-XXXX-XXXX` from the pairing alphabet. */
export const typedPairCodeSchema = z
  .string()
  .regex(new RegExp(`^${pairChar}{4}-${pairChar}{4}-${pairChar}{4}$`));

export const pairClaimSchema = z
  .object({
    offer_id: pairOfferIdSchema,
    phone_device_id: e2eDeviceIdSchema,
    phone_public_key: publicKeySchema,
    phone_name: z.string().min(1).max(60),
    mac: base64urlSchema.min(1).max(64),
  })
  .strict();
export type PairClaim = z.infer<typeof pairClaimSchema>;
