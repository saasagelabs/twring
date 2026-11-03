import { sha256 } from '@noble/hashes/sha2.js';
import { z } from 'zod';

// The pairing code is the connector one (same alphabet and shape), imported from './connectors'.
import { normalizePairingCode, pairingCodeSchema } from './connectors';

/**
 * Self-hosted Twring: pairing a phone with a person's own server, and the small API the Twring
 * relay offers that server (ring pushes, Twring-run call audio, reachability checks). The relay
 * only ever sees sealed envelopes, never message contents.
 */

/** `srv_` plus base32 (lowercase, no padding) of the first 20 bytes of SHA-256(server public key). */
export const serverIdSchema = z.string().regex(/^srv_[a-z2-7]{32}$/);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower case, no padding. */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The server id for a raw 32-byte Ed25519 public key. Shared by the server and the relay, which
 * checks that a registering server's id really belongs to its key.
 */
export function serverIdFor(publicKeyRaw: Uint8Array): string {
  return `srv_${base32Lower(sha256(publicKeyRaw).subarray(0, 20))}`;
}

/** Exactly 32 bytes as unpadded base64url (a Curve25519 or Ed25519 public key). */
const key32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const idSchema = z.string().min(1).max(128);
const isoSchema = z.iso.datetime();

export const audioModeSchema = z.enum(['own', 'twring']);
export type AudioMode = z.infer<typeof audioModeSchema>;

export const ringServiceStateSchema = z.enum(['active', 'unverified', 'paused', 'expired']);

export const serverInfoSchema = z.object({
  server_id: serverIdSchema,
  name: z.string().min(1).max(80),
  mode: z.literal('selfhost'),
  audio: audioModeSchema,
  /** With `?nonce=`: the server's raw Ed25519 public key and its proof (see server-proof.ts). */
  public_key: key32Schema.optional(),
  proof: z.string().max(2048).optional(),
  /**
   * `unknown` (no `paid_until`) until the server has heard from the ring service once.
   * `unregistered`: the ring service no longer knows this server (its registration was deleted,
   * for example by `twring uninstall` on a machine it was moved from); `twring register` fixes it.
   */
  ring_service: z.discriminatedUnion('state', [
    z.object({ state: ringServiceStateSchema, paid_until: isoSchema }).strict(),
    z.object({ state: z.literal('unknown') }).strict(),
    z.object({ state: z.literal('unregistered') }).strict(),
  ]),
});
export type ServerInfo = z.infer<typeof serverInfoSchema>;

export const personRoleSchema = z.enum(['admin', 'member']);

export const personSchema = z.object({
  id: idSchema,
  display_name: z.string().min(1).max(40),
  role: personRoleSchema,
});
export type Person = z.infer<typeof personSchema>;

export const pairRequestSchema = z
  .object({
    code: pairingCodeSchema,
    display_name: z.string().min(1).max(40),
    device_name: z.string().min(1).max(60),
    platform: z.enum(['android', 'ios']),
    /** The phone's X25519 public key; rings and messages for this phone are sealed to it. */
    seal_public_key: key32Schema,
  })
  .strict();
export type PairRequest = z.infer<typeof pairRequestSchema>;

export const pairResponseSchema = z.object({
  person: personSchema,
  device: z.object({ id: idSchema, token: z.string().min(1).max(256) }),
  server: serverInfoSchema,
  seal_server_public_key: key32Schema,
});
export type PairResponse = z.infer<typeof pairResponseSchema>;

export const deviceSummarySchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  platform: z.enum(['android', 'ios']),
  created_at: isoSchema,
  last_seen_at: isoSchema.nullable(),
});
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const peopleListResponseSchema = z.object({
  people: z.array(personSchema.extend({ devices: z.array(deviceSummarySchema) })),
});

export const memberCodeResponseSchema = z.object({
  code: pairingCodeSchema,
  expires_at: isoSchema,
});

/** `PUT` sets and `DELETE` clears the calling phone's ring handle on its server. */
export const PAIRED_DEVICE_RELAY_PATH = '/v1/me/paired-devices/current/relay';

/** `twring://pair?server=<https address>&code=<XXXX-XXXX>&id=<srv_...>`: what the pairing QR holds. */
export function buildPairLink(link: { server: string; code: string; serverId: string }): string {
  return `twring://pair?server=${encodeURIComponent(link.server)}&code=${encodeURIComponent(link.code)}&id=${encodeURIComponent(link.serverId)}`;
}

/**
 * The parts of a pairing link, or undefined when it is not exactly one: an `https` address with
 * no path, query or login, a pairing code and a server id. Parameter order is free and unknown
 * parameters are ignored; the code is normalized.
 */
export function parsePairLink(
  text: string,
): { server: string; code: string; serverId: string } | undefined {
  const match = /^twring:\/\/pair\?([^#]*)$/.exec(text.trim());
  if (match === null) return undefined;
  // Plain parsing: this package has no URL globals, and the app runs it on Hermes.
  const params = new Map<string, string>();
  try {
    for (const pair of (match[1] ?? '').split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = decodeURIComponent(pair.slice(0, eq));
      if (!params.has(key)) params.set(key, decodeURIComponent(pair.slice(eq + 1)));
    }
  } catch {
    return undefined;
  }
  const server = params.get('server');
  const rawCode = params.get('code');
  const serverId = params.get('id');
  if (server === undefined || rawCode === undefined || serverId === undefined) return undefined;
  if (!/^https:\/\/[^/?#@\s]+$/.test(server)) return undefined;
  const code = normalizePairingCode(rawCode);
  if (code === undefined || !serverIdSchema.safeParse(serverId).success) return undefined;
  return { server, code, serverId };
}

export const relayHandleRequestSchema = z.object({ handle: z.string().min(1).max(128) });

export const deviceTicketResponseSchema = z.object({
  ticket: z.string().min(1).max(2048),
  relay_url: z.url({ protocol: /^https$/ }),
});

/**
 * A sealed payload: XChaCha20-Poly1305 under an X25519 + HKDF key (see seal.ts). Both fields are
 * unpadded base64url: `n` is exactly 24 bytes (32 chars); `c` is at least the 16-byte Poly1305 tag
 * (22 chars) and at most 3400 chars (about 2550 bytes), which keeps `{"v":1,"n":..,"c":..}` inside
 * the 3600-byte push payload limit with room for the push's other fields.
 */
/** Ciphertext length bound (base64url chars) of a sealed envelope. */
export const SEALED_CIPHERTEXT_MAX_CHARS = 3400;
const base64urlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const sealedEnvelopeSchema = z.object({
  v: z.literal(1),
  n: base64urlSchema.length(32),
  c: base64urlSchema.min(22).max(SEALED_CIPHERTEXT_MAX_CHARS),
});
export type SealedEnvelope = z.infer<typeof sealedEnvelopeSchema>;

// --- Relay API (server to relay) ---

export const relayInstallRequestSchema = z.object({
  email: z.email().max(254),
  news: z.boolean(),
  server_id: serverIdSchema,
  public_key: key32Schema,
  address: z.string().min(1).max(253).refine(isInstallAddress).optional(),
  partner_id: z.string().min(1).max(64).optional(),
  /**
   * A compact JWS (EdDSA) signed with the server's key over `relayInstallProofClaims(...)` of this
   * same request (every field but `partner_id`), proving the caller holds the key behind
   * `public_key`. Single use: the relay records its `jti` until `exp` and refuses a replay.
   */
  proof: z.string().min(1).max(2048),
});

/** The `aud` of an install registration proof. */
export const RELAY_INSTALL_PROOF_AUDIENCE = 'twring-relay/installs';
/** The longest a registration proof may live (`exp - iat`), in seconds. */
export const RELAY_INSTALL_PROOF_MAX_SECONDS = 600;

/**
 * The claims a server signs (EdDSA, its server key) as the `proof` of an install registration.
 * `jti` must be fresh random text (at least 16 characters) for every request.
 */
export function relayInstallProofClaims(
  request: { server_id: string; email: string; news: boolean; address?: string },
  options: { jti: string; nowSeconds: number; lifetimeSeconds?: number },
): {
  aud: string;
  server_id: string;
  email: string;
  news: boolean;
  address?: string;
  jti: string;
  iat: number;
  exp: number;
} {
  const lifetime = Math.min(options.lifetimeSeconds ?? 300, RELAY_INSTALL_PROOF_MAX_SECONDS);
  return {
    aud: RELAY_INSTALL_PROOF_AUDIENCE,
    server_id: request.server_id,
    email: request.email,
    news: request.news,
    ...(request.address !== undefined && { address: request.address }),
    jti: options.jti,
    iat: options.nowSeconds,
    exp: options.nowSeconds + lifetime,
  };
}

export const relayInstallResponseSchema = z.object({
  install_id: idSchema,
  relay_key: z.string().min(1).max(256),
  paid_until: isoSchema,
  verified: z.boolean(),
});

export const relayPlatformSchema = z.enum(['android', 'ios']);

/**
 * A phone's push addresses, as the hosted app sends them: Android rings and messages go through
 * FCM (`fcm_token`); an iPhone rings through PushKit (`voip_token`, required) and shows messages
 * and missed calls through its alert token (`apns_token`, optional, absent when alerts are off).
 */
/** Token formats as the hosted device registration takes them (`deviceRegistrationSchema`). */
const fcmTokenSchema = z.string().regex(/^[A-Za-z0-9_:.-]{20,4096}$/);
const apnsTokenSchema = z.string().regex(/^[0-9a-fA-F]{32,400}$/);

export const relayDeviceRequestSchema = z
  .object({
    ticket: z.string().min(1).max(2048),
    fcm_token: fcmTokenSchema.optional(),
    voip_token: apnsTokenSchema.optional(),
    apns_token: apnsTokenSchema.optional(),
    platform: relayPlatformSchema,
  })
  .strict()
  .refine(
    (body) =>
      body.platform === 'android'
        ? body.fcm_token !== undefined &&
          body.voip_token === undefined &&
          body.apns_token === undefined
        : body.voip_token !== undefined && body.fcm_token === undefined,
    { message: 'Push tokens do not match the platform.' },
  );

/**
 * The `aud` of a device ticket: a compact JWS (EdDSA, server key) with claims
 * `{ iss: <server id>, sub: <device id>, aud: 'twring-relay', exp: now + 600, jti }`, single use.
 */
export const RELAY_TICKET_AUDIENCE = 'twring-relay';

export const relayDeviceResponseSchema = z.object({ handle: z.string().min(1).max(128) });

export const relayPushKindSchema = z.enum(['ring', 'ring_cancel', 'message', 'missed_call']);

export const relayPushRequestSchema = z.object({
  handle: z.string().min(1).max(128),
  kind: relayPushKindSchema,
  sealed: sealedEnvelopeSchema,
  ttl_seconds: z.number().int().min(1).max(3600),
  priority: z.enum(['high', 'normal']),
});
export type RelayPushRequest = z.infer<typeof relayPushRequestSchema>;

export const relayPushResponseSchema = z.object({
  /** `unsupported`: this push can never reach that phone (no token for its kind, or no service). */
  outcome: z.enum(['sent', 'invalid', 'paused', 'expired', 'limited', 'unsupported']),
});
export type RelayPushOutcome = z.infer<typeof relayPushResponseSchema>['outcome'];

/** A call id the relay accepts: it becomes part of a room name, so letters, digits, `_` and `-`. */
export const relayAudioCallIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const relayAudioSessionRequestSchema = z.object({ call_id: relayAudioCallIdSchema });

/** `audio_unavailable`: Twring-run call audio could not be reached (verbatim app copy). */
export const AUDIO_UNAVAILABLE_MESSAGE =
  "Twring's audio service can't be reached right now. Try again in a minute.";
/** `audio_unreachable`: the server's own call audio could not be reached (verbatim app copy). */
export const AUDIO_UNREACHABLE_MESSAGE =
  "Call audio isn't reachable on your server. Run twring audio check on the server.";

/** `audio_paused`: Twring-run call audio waits for the server's email to be confirmed. */
export const AUDIO_PAUSED_MESSAGE =
  "Calls are paused until your server's email address is confirmed. Your admin can find the email from Twring.";
/** `audio_expired`: Twring-run call audio for this server has ended. */
export const AUDIO_EXPIRED_MESSAGE =
  "Twring's audio service for this server has ended. Ask your admin.";
/** `audio_limit_reached`: the server's daily minutes or calls at once are used up. */
export const AUDIO_LIMIT_REACHED_MESSAGE =
  'This server has reached its call limit for now. Try again later.';

/** How long the relay's call audio tokens last; LiveKit refreshes them for joined participants. */
export const RELAY_AUDIO_TOKEN_TTL_SECONDS = 600;
/** The longest a Twring-run audio session is counted (a call is at most 2 hours). */
export const RELAY_AUDIO_MAX_SESSION_SECONDS = 7200;

/** The phone's identity in a Twring-run call audio room; the relay mints it, the server expects it. */
export function relayCallerIdentity(callId: string): string {
  return `caller-${callId}`;
}

/** The room the relay creates for one install's call: `inst_<install id>_<call id>`. */
export function relayAudioRoom(installId: string, callId: string): string {
  return `inst_${installId}_${callId}`;
}

export const relayAudioSessionResponseSchema = z.object({
  url: z.url({ protocol: /^wss?$/ }),
  room: z.string().min(1).max(128),
  caller_token: z.string().min(1).max(4096),
  server_token: z.string().min(1).max(4096),
  expires_at: isoSchema,
});

export const relayProbeCheckSchema = z.enum(['https', 'http', 'tcp7881', 'udp7882']);
export type RelayProbeCheck = z.infer<typeof relayProbeCheckSchema>;

export const relayProbeRequestSchema = z.object({
  address: z.string().min(1).max(253),
  checks: z.array(relayProbeCheckSchema).min(1).max(4),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

/** The one line a probe sends to the echo responder and expects back, byte for byte. */
export function probeEchoLine(nonce: string): string {
  return `twring-probe ${nonce}`;
}

/** A well-formed probe line (without its optional trailing newline). */
export const PROBE_ECHO_PATTERN = /^twring-probe [A-Za-z0-9_-]{1,64}$/;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const ipv4Address = z.ipv4();
const ipv6Address = z.ipv6();

function isHostOrIp(host: string): boolean {
  return (
    HOSTNAME_PATTERN.test(host) ||
    ipv4Address.safeParse(host).success ||
    ipv6Address.safeParse(host).success
  );
}

/**
 * A server's public address: a hostname, an IP, or an https URL (port 443 only) with no path,
 * query or login.
 */
function isInstallAddress(address: string): boolean {
  if (!address.startsWith('https://')) return isHostOrIp(address);
  // `https://host[:port][/]`, host an IPv6 literal in brackets; no login, path, query or fragment.
  const match = /^https:\/\/(?:\[([0-9A-Fa-f:.]+)\]|([^/:?#@[\]]+))(?::(\d{1,5}))?\/?$/.exec(
    address,
  );
  if (match === null) return false;
  // The reachability probe checks HTTPS on 443 only, so no other port is accepted.
  if (match[3] !== undefined && Number(match[3]) !== 443) return false;
  return match[1] !== undefined
    ? ipv6Address.safeParse(match[1]).success
    : isHostOrIp(match[2] ?? '');
}

/** `PUT /v1/installs/address`: where the relay may probe this install (nowhere else). */
export const relayInstallAddressRequestSchema = z
  .object({ address: z.string().min(1).max(253).refine(isInstallAddress) })
  .strict();

export const relayInstallAddressResponseSchema = z.object({ address: z.string() });

/**
 * `DELETE /v1/installs/self` (relay key, no body): deletes this install with its phones, usage,
 * call audio records and email send records; 204. Run by `twring uninstall`.
 */
export const RELAY_DELETE_INSTALL_PATH = '/v1/installs/self';

/** `GET /v1/ip`: the caller's public address as the relay sees it. */
export const relayIpResponseSchema = z.object({ ip: z.union([z.ipv4(), z.ipv6()]) });

export const relayProbeResponseSchema = z.object({
  results: z.partialRecord(
    relayProbeCheckSchema,
    z.object({ ok: z.boolean(), ms: z.number().nonnegative().optional() }),
  ),
});

export const relayStatusResponseSchema = z.object({
  state: ringServiceStateSchema,
  paid_until: isoSchema,
  verified: z.boolean(),
});
