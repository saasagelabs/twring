import { z } from 'zod';

/**
 * Private chats with computer agents (ADR-044): what travels between the phone, the Twring
 * server and the connector when a chat is sealed end to end. The server stores and relays these
 * shapes but never holds a key that opens them.
 */

/** Capability both the app and the connector report before a chat can become private. */
export const SEALED_CHAT_FEATURE = 'sealed_chat';
/** A computer that can stop a private turn when the phone taps Stop (`sealed.cancel`, C3 #11). */
export const SEALED_CANCEL_FEATURE = 'sealed_cancel';
/** A computer that sends a content-free "still working" frame during a private turn (ADR-045). */
export const SEALED_WORKING_FEATURE = 'sealed_working';
export const SEALED_WORKING_INTERVAL_MS = 20_000;
/** A private turn with no reply chunk and no working frame for this long is interrupted. */
export const SEALED_TURN_IDLE_MS = 60_000;
/**
 * A computer that reads the account's devices again when told a device was removed
 * (`e2e.devices_changed`, C3 #11). Older computers still read them every 10 minutes.
 */
export const DEVICES_CHANGED_FEATURE = 'devices_changed';
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

/**
 * The lookup handle of a typed pairing code (`TYPED_PAIR_ALPHABET` in message-seal.ts): its first
 * 4 Crockford characters, upper case. The server sees only this part of the code.
 */
export const typedPairHandleSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}$/);

/** Which MAC key the phone's claim used: the QR secret, or the typed code's (C3 #11). */
export const pairKeyKindSchema = z.enum(['qr', 'typed']);

export const pairClaimSchema = z
  .object({
    offer_id: pairOfferIdSchema,
    phone_device_id: e2eDeviceIdSchema,
    phone_public_key: publicKeySchema,
    phone_name: z.string().min(1).max(60),
    mac: base64urlSchema.min(1).max(64),
    /** Absent means `qr`, as every claim before typed codes. */
    key: pairKeyKindSchema.optional(),
  })
  .strict();
export type PairClaim = z.infer<typeof pairClaimSchema>;

/**
 * Approving a second phone from a trusted one (C3 #11, Task 27). `pap_` ids are made by the
 * server and are distinct from a computer's sealed approvals (`apv_`).
 */
export const phoneApprovalIdSchema = z.string().regex(/^pap_[a-z2-7]{20}$/);
export const phoneApprovalStateSchema = z.enum([
  'pending',
  'claimed',
  'accepted',
  'denied',
  'expired',
]);
export type PhoneApprovalState = z.infer<typeof phoneApprovalStateSchema>;

/** Room for a trust note's payload: 6 device entries with 60-character names, escaped. */
export const MAX_TRUST_NOTE_BODY_CHARS = 8192;

/**
 * A trust note: a trusted phone vouches for a new one. The payload (`trust_add` in
 * message-seal.ts) is sealed with a fresh key wrapped by the approving phone to the new phone and
 * to every device it trusts. `approval_id` travels in the clear because the AAD binds it.
 */
export const trustNoteSchema = z
  .object({
    approval_id: phoneApprovalIdSchema,
    sender_device: e2eDeviceIdSchema,
    nonce: base64urlSchema.min(1).max(64),
    body: base64urlSchema.min(1).max(MAX_TRUST_NOTE_BODY_CHARS),
    keys: z.array(wrappedKeySchema).min(1).max(MAX_PAIRED_DEVICES),
  })
  .strict();
export type TrustNote = z.infer<typeof trustNoteSchema>;

/**
 * A device row as newer clients read it (`?notes=1`). Older clients parse rows strictly with
 * `e2eDeviceSchema`, so the server adds `trust_note` only when asked.
 */
export const e2eDeviceWithNoteSchema = e2eDeviceSchema
  .extend({ trust_note: trustNoteSchema.optional() })
  .strict();
export type E2eDeviceWithNote = z.infer<typeof e2eDeviceWithNoteSchema>;

/** The new phone asks to be approved. */
export const phoneApprovalRequestSchema = z
  .object({
    device_id: e2eDeviceIdSchema,
    public_key: publicKeySchema,
    name: z.string().min(1).max(60),
  })
  .strict();
export type PhoneApprovalRequest = z.infer<typeof phoneApprovalRequestSchema>;

/** Claim and deny name the trusted phone acting; accept also carries the note. */
export const phoneApprovalActorSchema = z.object({ device_id: e2eDeviceIdSchema }).strict();
export const phoneApprovalAcceptSchema = z
  .object({ device_id: e2eDeviceIdSchema, note: trustNoteSchema })
  .strict();

/** One approval as the server answers it. `approver` once claimed; `trust_note` once accepted. */
export const phoneApprovalSchema = z
  .object({
    id: phoneApprovalIdSchema,
    state: phoneApprovalStateSchema,
    device_id: e2eDeviceIdSchema,
    name: z.string().min(1).max(60),
    public_key: publicKeySchema,
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    approver: z
      .object({
        id: e2eDeviceIdSchema,
        name: z.string().min(1).max(60),
        public_key: publicKeySchema,
      })
      .strict()
      .optional(),
    trust_note: trustNoteSchema.optional(),
  })
  .strict();
export type PhoneApproval = z.infer<typeof phoneApprovalSchema>;
