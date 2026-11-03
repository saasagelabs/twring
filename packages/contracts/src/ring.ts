import { z } from 'zod';

import { agentIdSchema, agentKeytermSchema, MAX_AGENT_KEYTERMS } from './agents';
import { createCallResponseSchema } from './calls';
import { localAgentIdSchema, SESSION_REF_PATTERN, sessionScopeSchema } from './connectors';
import { fileIdSchema, MAX_ATTACHMENTS_PER_MESSAGE } from './files';
import { MAX_STORED_AGENT_MESSAGE_CHARS, threadMessageIdSchema } from './threads';

/**
 * The agent rings the owner (ADR-024). A connector asks the gateway to ring; the gateway keeps an
 * invite for 30 s and pushes it to the owner's phones; the owner answers (a normal call whose first
 * agent turn says why the agent rang), declines with a short note the agent sees, or misses it (a
 * voicemail entry in call history).
 */

/** How long an invite rings before it is missed. */
export const RING_INVITE_TTL_MS = 30_000;
/** Rings one agent may start per hour. */
export const RING_RATE_PER_AGENT_PER_HOUR = 6;
/** Longest long-poll wait the gateway honours, in seconds. */
export const RING_MAX_WAIT_S = 25;
/** Push-registered phones one user may have. */
export const MAX_DEVICES_PER_USER = 5;
/** First 64 bits of SHA-256(user id), sent in push data to bind a ring to an account. */
export function userRef(userId: string): string {
  const encoded: number[] = [];
  for (const char of userId) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x80) encoded.push(cp);
    else if (cp < 0x800) encoded.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      encoded.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      encoded.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  const bytes = Uint8Array.from(encoded);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const block = new Uint8Array(size);
  block.set(bytes);
  block[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(block.buffer);
  view.setUint32(size - 8, Math.floor(bits / 0x100000000));
  view.setUint32(size - 4, bits >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!;
      const b = words[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, q] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const choose = (e! & f!) ^ (~e! & g!);
      const t1 = (q! + s1 + choose + SHA256_K[i]! + words[i]!) >>> 0;
      const s0 =
        ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + majority) >>> 0;
      q = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, q];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  return Array.from(h.slice(0, 2), (word) => word.toString(16).padStart(8, '0')).join('');
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** After an agent's `⟪hangup⟫` reply plays, the call ends this long later unless the owner speaks. */
export const AGENT_HANGUP_LINGER_MS = 6_000;
/** Markers an agent puts in its text to end the call after the reply. Stripped from speech. */
export const HANGUP_MARKERS = ['⟪hangup⟫', '[[hangup]]'] as const;
/** Text with any hang-up marker (any letter case) removed, for saving a reply as a message. */
export function stripHangupMarkers(text: string): string {
  return text.replace(/⟪hangup⟫|\[\[hangup\]\]/gi, '').trim();
}
/**
 * When an agent may hang up, in the words every agent is given. A call ends when the owner ends it,
 * as on a phone: finishing an answer, or delivering the news it rang about, is not the end.
 */
export const STAY_ON_CALL_RULE =
  'Stay on the line until your owner says goodbye or asks you to hang up; only then end that reply with ⟪hangup⟫. Finishing an answer or giving your news does not end the call.';

/** C0/C1 controls, bidi marks and overrides, and line/paragraph separators (by code point). */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

/**
 * Zero-width characters and Unicode tags: invisible, so removed outright (not turned to spaces).
 * The zero-width joiner (U+200D) stays: it holds emoji like family or profession together and
 * cannot reorder text the way bidi controls can.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200c],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const inRanges = (code: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([low, high]) => code >= low && code <= high);

function replaceChar(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  if (inRanges(code, INVISIBLE_RANGES)) return '';
  return inRanges(code, UNSAFE_RANGES) ? ' ' : char;
}

/** Drops control, bidi-override, zero-width, and tag characters and collapses whitespace. Never HTML-rendered. */
export function sanitizeRingText(input: string): string {
  return Array.from(input, replaceChar).join('').replace(/\s+/g, ' ').trim();
}

/**
 * Cuts `text` to at most `max` UTF-16 units (the unit the 140/60 limits count in) without splitting
 * a character: an emoji is never left as half a surrogate pair. `ellipsis` is added when cut.
 */
export function truncateRingText(text: string, max: number, ellipsis = ''): string {
  if (text.length <= max) return text;
  const budget = max - ellipsis.length;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > budget) break;
    out += char;
  }
  return `${out.trimEnd()}${ellipsis}`;
}

/** Opaque, unguessable invite id: `inv_` + 26 random base32 characters (130 bits). */
export const inviteIdSchema = z.string().regex(/^inv_[a-z2-7]{26}$/);

export const inviteStatusSchema = z.enum([
  'pending',
  'answered',
  'declined',
  'missed',
  'cancelled',
]);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/** Why the agent rang: 1–140 characters once sanitized. */
export const ringReasonSchema = z
  .string()
  .max(1000)
  .transform(sanitizeRingText)
  .pipe(z.string().min(1).max(140));

/**
 * A connector's reference to the agent session to resume (Claude session id, Codex thread id).
 * Never starts with a dash: it goes back on a command line (SESSION_REF_PATTERN).
 */
export const sessionRefSchema = z.string().regex(SESSION_REF_PATTERN);

// Devices

export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);

/**
 * `PUT /v1/me/devices/:deviceId`. `fcm_token` is the phone's ring token: the FCM token on Android,
 * the PushKit VoIP token (hex) on iOS. `apns_token` is the iOS alert token, for messages and
 * missed rings.
 */
export const deviceRegistrationSchema = z
  .object({
    fcm_token: z.string().regex(/^[A-Za-z0-9_:.-]{20,4096}$/),
    platform: z.enum(['android', 'ios']),
    app_variant: z.string().regex(/^[A-Za-z0-9._-]{1,40}$/),
    apns_token: z
      .string()
      .regex(/^[0-9a-fA-F]{32,400}$/)
      .optional(),
  })
  .strict();
export type DeviceRegistration = z.infer<typeof deviceRegistrationSchema>;

// Ring settings

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `GET` / `PUT /v1/me/ring-settings`. */
export const ringSettingsSchema = z
  .object({
    dnd: z.boolean(),
    after_call_result: z.enum(['ring', 'message']).optional(),
    quiet_hours: z
      .object({
        enabled: z.boolean(),
        start: hhmm,
        end: hhmm,
        tz: z.string().max(64).refine(isTimeZone, { message: 'Unknown time zone.' }),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RingSettings = z.infer<typeof ringSettingsSchema>;

export const DEFAULT_RING_SETTINGS: RingSettings = {
  dnd: false,
  quiet_hours: null,
  after_call_result: 'ring',
};

// Connector side

/** `POST /v1/connectors/ring` (connector token). */
export const ringRequestSchema = z
  .object({
    local_agent: localAgentIdSchema,
    reason: ringReasonSchema,
    session_ref: sessionRefSchema.optional(),
    /** The person whose session rings (a shared server agent); the owner's has none. */
    session_scope: sessionScopeSchema.optional(),
  })
  .strict();
export type RingRequest = z.infer<typeof ringRequestSchema>;

/**
 * `POST /v1/connectors/words` (connector token): words or short phrases the agent's calls should
 * hear right (the owner's name, a project, a place), added after the owner's own on the Words page.
 */
export const connectorWordsRequestSchema = z
  .object({
    local_agent: localAgentIdSchema,
    words: z.array(agentKeytermSchema).min(1).max(MAX_AGENT_KEYTERMS),
    /** The person whose session teaches these (a shared server agent): their own word list. */
    session_scope: sessionScopeSchema.optional(),
  })
  .strict();
export type ConnectorWordsRequest = z.infer<typeof connectorWordsRequestSchema>;

export const connectorWordsResponseSchema = z.object({
  /** Every word the agent's calls listen for now. */
  words: z.array(z.string()),
  /** Words left out because the list is full. */
  not_added: z.array(z.string()),
});
export type ConnectorWordsResponse = z.infer<typeof connectorWordsResponseSchema>;

export const connectorMessageRequestSchema = z
  .object({
    local_agent: localAgentIdSchema,
    text: z
      .string()
      .transform((value) =>
        Array.from(value, (char) => {
          const code = char.codePointAt(0) ?? 0;
          return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
            ? ''
            : char;
        })
          .join('')
          .trim(),
      )
      .pipe(z.string().max(MAX_STORED_AGENT_MESSAGE_CHARS)),
    origin: z.enum(['call_turn', 'text_turn', 'agent']),
    turn_id: z.string().max(128).optional(),
    session_ref: sessionRefSchema.optional(),
    /** The person whose session produced this (a shared server agent); the owner's has none. */
    session_scope: sessionScopeSchema.optional(),
    /** Files uploaded first with `POST /v1/connectors/files` (direction agent), in display order. */
    file_ids: z.array(fileIdSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .strict()
  .refine((message) => message.text.length > 0 || message.file_ids !== undefined, {
    message: 'text or file_ids required',
    path: ['text'],
  })
  .refine((message) => new Set(message.file_ids ?? []).size === (message.file_ids?.length ?? 0), {
    message: 'file_ids must be distinct',
    path: ['file_ids'],
  });
export type ConnectorMessageRequest = z.infer<typeof connectorMessageRequestSchema>;
export const connectorMessageResponseSchema = z
  .object({
    message_id: threadMessageIdSchema,
    delivery: z.enum(['ring', 'push', 'none']),
  })
  .strict();
export type ConnectorMessageResponse = z.infer<typeof connectorMessageResponseSchema>;

/** `201` from `POST /v1/connectors/ring`. */
export const ringResponseSchema = z.object({
  invite_id: inviteIdSchema,
  expires_at: z.iso.datetime(),
});
export type RingResponse = z.infer<typeof ringResponseSchema>;

/** `GET /v1/connectors/ring/:inviteId?wait=25` and `DELETE` of the same. */
export const ringStatusResponseSchema = z.object({
  status: inviteStatusSchema,
  note: z.string().max(60).optional(),
});
export type RingStatusResponse = z.infer<typeof ringStatusResponseSchema>;

// Phone side

/** `GET /v1/invites/:id`, and each item of `GET /v1/invites?status=pending`. */
export const inviteSchema = z.object({
  invite_id: inviteIdSchema,
  agent_id: agentIdSchema,
  agent_name: z.string(),
  reason: z.string().max(140),
  status: inviteStatusSchema,
  expires_at: z.iso.datetime(),
  server_time: z.iso.datetime(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const inviteListResponseSchema = z.object({ invites: z.array(inviteSchema) });
export type InviteListResponse = z.infer<typeof inviteListResponseSchema>;

/** Quick-decline replies; any other short text is allowed too. */
export const DECLINE_NOTES = ['busy', 'outside', 'text'] as const;

/** `POST /v1/invites/:id/decline`. */
export const declineRequestSchema = z
  .object({
    note: z.string().max(200).transform(sanitizeRingText).pipe(z.string().max(60)).optional(),
  })
  .strict();
export type DeclineRequest = z.infer<typeof declineRequestSchema>;

// Push (FCM data-only messages; every value is a string)

export const ringPushSchema = z.object({
  type: z.literal('cord.ring'),
  user_ref: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  invite_id: inviteIdSchema,
  agent_id: agentIdSchema,
  agent_name: z.string(),
  reason: z.string(),
  expires_at: z.iso.datetime(),
  server_time: z.iso.datetime(),
});
export type RingPush = z.infer<typeof ringPushSchema>;

export const ringCancelPushSchema = z.object({
  type: z.literal('cord.ring_cancel'),
  user_ref: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  invite_id: inviteIdSchema,
  status: inviteStatusSchema,
  /** For an iOS "Missed call from …" notification; Android shows the name it got with the ring. */
  agent_name: z.string().optional(),
});
export type RingCancelPush = z.infer<typeof ringCancelPushSchema>;

export const messagePushSchema = z
  .object({
    type: z.literal('cord.message'),
    user_ref: z.string().regex(/^[0-9a-f]{16}$/),
    agent_id: agentIdSchema,
    agent_name: z.string(),
    message_id: threadMessageIdSchema,
    preview: z.string().max(120),
    silent: z.enum(['0', '1']),
  })
  .strict();
export type MessagePush = z.infer<typeof messagePushSchema>;

/** The user turn the agent gets when the owner answers its ring. */
export function answeredTurnText(reason: string, options?: { spoken: boolean }): string {
  if (options?.spoken === true) {
    return `[The owner answered your call. Your ring message was already said to them in your voice: "${reason.trim()}". Don't repeat it; continue from there, then let them talk. ${STAY_ON_CALL_RULE}]`;
  }
  const because = reason.trim().replace(/[.!?]+$/u, '');
  return `[The owner answered your call. You rang because: ${because}. Tell them, then let them talk. ${STAY_ON_CALL_RULE}]`;
}

/** `POST /v1/invites/:id/answer`: a call for a computer agent, the chat for an AI app (no call). */
export const ringAnswerResponseSchema = z.union([
  createCallResponseSchema.extend({ mode: z.literal('call').default('call') }),
  z.object({ mode: z.literal('chat'), agent_id: agentIdSchema }),
]);
export type RingAnswerResponse = z.infer<typeof ringAnswerResponseSchema>;
