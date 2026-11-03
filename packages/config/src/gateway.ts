import { twringEnvironmentSchema } from '@twring/contracts';
import { z } from 'zod';

import { parseEnv, type EnvSource } from './parse';

export { ConfigError } from './parse';

/** Env booleans are strings; accept only unambiguous spellings. */
const envBoolean = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** Upper bound for credential key versions (current and old keys alike). */
const MAX_KEY_VERSION = 1_000_000;

/** True for base64 that decodes to exactly 32 bytes (an AES-256 key). */
function isKey(value: string): boolean {
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value);
}

const credentialsKey = z
  .string()
  .refine(isKey, 'must be 32 random bytes, base64 (see docs/DEVELOPMENT.md)');

/**
 * Keys that are published (test fixtures, examples) and so protect nothing. Production refuses
 * them, and any key with too few distinct bytes to have come from a random generator.
 */
const PUBLISHED_KEYS = new Set(['BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=']);

/** True for a key production must not use: published, or visibly not random. */
export function isWeakCredentialsKey(value: string): boolean {
  if (PUBLISHED_KEYS.has(value)) return true;
  // 32 random bytes almost always hold 25+ distinct values; 16 leaves a wide margin.
  return new Set(base64Bytes(value)).size < 16;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes standard base64 (already validated) without Node or DOM globals. */
function base64Bytes(value: string): number[] {
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const char of value.replace(/=+$/, '')) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A textual IPv6 address (compressed, full, or with a trailing dotted IPv4 part). */
function isIPv6(address: string): boolean {
  let text = address;
  let wanted = 8;
  const dotted = /^(.*:)([^:]+\.[^:]+)$/.exec(text);
  if (dotted) {
    if (!IPV4.test(dotted[2]!)) return false;
    text = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
    wanted = 6;
  }
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === '' ? [] : half.split(':')));
  if (!groups.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < wanted : groups.length === wanted;
}

/** An IPv4 or IPv6 address, optionally with a CIDR prefix that fits its family. */
function isProxyAddress(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const bits = IPV4.test(address) ? 32 : isIPv6(address) ? 128 : 0;
  if (bits === 0) return false;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits);
}

/** `true`/`false`, or the proxy addresses to trust (comma-separated IPs or CIDRs). */
const trustProxy = z.string().transform((value, ctx): boolean | string[] => {
  const text = value.trim();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0' || text === '') return false;
  const entries = text.split(',').map((entry) => entry.trim());
  // Checked here, not left to Fastify: an entry it cannot parse would otherwise crash the server
  // while the app is built, instead of failing with the other configuration issues.
  if (!entries.every(isProxyAddress)) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be true, false, or proxy addresses like 127.0.0.1,10.0.0.0/8',
    });
    return z.NEVER;
  }
  return entries;
});

/** Per-client requests per minute. */
const ratePerMinute = (fallback: number) =>
  z.coerce.number().int().min(1).max(10_000).default(fallback);

const LIVEKIT_KEYS = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const;

/** Settings a self-hosted server cannot use: they belong to Twring's own hosted service. */
const SELFHOST_FORBIDDEN = [
  'SUPABASE_URL',
  'APPLE_SIGNIN_KEY_FILE',
  'FCM_SERVICE_ACCOUNT_FILE',
  'APNS_KEY_FILE',
  'RESEND_API_KEY',
  'INVITE_FROM',
  'WAITLIST_NOTIFY_TO',
  'WAITLIST_NOTIFY_FROM',
] as const;

const SELFHOST_REQUIRED = [
  'TWRING_SERVER_KEY_FILE',
  'TWRING_ADMIN_TOKEN',
  'TWRING_RELAY_KEY_FILE',
  'TWRING_AUDIO',
] as const;

/** The cross-field rules of `TWRING_MODE=selfhost`; `env` is the parsed object. */
function validateSelfhost(
  env: Partial<
    Record<
      | (typeof SELFHOST_FORBIDDEN)[number]
      | (typeof SELFHOST_REQUIRED)[number]
      | (typeof LIVEKIT_KEYS)[number]
      | 'AUTH_MODE'
      | 'CORD_ENV'
      | 'CORD_PUBLIC_URL'
      | 'DEEPGRAM_API_KEY'
      | 'XAI_API_KEY',
      string
    >
  > & { CALL_MAX_DURATION_S?: number },
  ctx: z.RefinementCtx,
): void {
  const issue = (key: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [key], message });
  if (env.AUTH_MODE !== 'pairing') issue('AUTH_MODE', 'must be pairing when TWRING_MODE=selfhost');
  for (const key of SELFHOST_REQUIRED) {
    if (env[key] === undefined) issue(key, 'is required when TWRING_MODE=selfhost');
  }
  for (const key of SELFHOST_FORBIDDEN) {
    if (env[key] !== undefined)
      issue(key, 'is a hosted setting and is not allowed on a self-hosted server');
  }
  if (env.DEEPGRAM_API_KEY === undefined && env.XAI_API_KEY === undefined) {
    issue('DEEPGRAM_API_KEY', 'or XAI_API_KEY is required when TWRING_MODE=selfhost');
  }
  if (env.CORD_ENV !== 'development' && env.CORD_PUBLIC_URL === undefined) {
    issue('CORD_PUBLIC_URL', 'is required when TWRING_MODE=selfhost outside development');
  }
  if (env.TWRING_AUDIO === 'own') {
    for (const key of LIVEKIT_KEYS) {
      if (env[key] === undefined) issue(key, 'is required when TWRING_AUDIO=own');
    }
  } else if (env.TWRING_AUDIO === 'twring') {
    for (const key of LIVEKIT_KEYS) {
      if (env[key] !== undefined) issue(key, 'is not allowed when TWRING_AUDIO=twring');
    }
    // Twring-run audio sessions last at most 2 hours at the relay.
    if (env.CALL_MAX_DURATION_S !== undefined && env.CALL_MAX_DURATION_S > 7200) {
      issue('CALL_MAX_DURATION_S', 'must be at most 7200 when TWRING_AUDIO=twring');
    }
  }
}

/**
 * Server-side gateway configuration. Provider secrets (LiveKit, Deepgram) are added here
 * by the milestone that first uses them, never in the mobile schema.
 */
export const gatewayEnvSchema = z
  .object({
    CORD_ENV: twringEnvironmentSchema.default('development'),
    CORD_RELEASE: z.string().default('dev'),
    /** Optional JSON membership file; unset leaves the invite gate off. */
    BETA_MEMBERS_FILE: z.string().min(1).optional(),
    TWRING_DOWNLOAD_URL: z.url().optional(),
    /** The public TestFlight link sent in iPhone invites (wave 1). */
    TWRING_TESTFLIGHT_URL: z.url().optional(),
    /** Sender of invite emails to people (default WAITLIST_NOTIFY_FROM). */
    INVITE_FROM: z.string().min(3).max(200).optional(),
    /**
     * People let in each UTC day without the owner approving: app sign-ins get in at once, and
     * website requests get their code by email (each up to this many a day). 0 turns it off.
     */
    AUTO_ADMIT_PER_DAY: z.coerce.number().int().min(0).max(1000).default(0),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SENTRY_DSN: z.url().optional(),
    /**
     * Only `production` changes behaviour here: with NODE_ENV=production, CORD_ENV must be set to a
     * deployed environment so a production build never runs with development defaults.
     */
    NODE_ENV: z.string().optional(),
    /**
     * Honour X-Forwarded-For. Enable only behind a proxy you control, or rate limits are spoofable.
     * `true` trusts any hop (staging); production must list the proxy addresses instead.
     */
    TRUST_PROXY: trustProxy.default(false),
    /** Exact browser origins allowed to submit the beta waitlist form. */
    WAITLIST_ALLOWED_ORIGINS: z
      .string()
      .default('https://twring.com,https://www.twring.com')
      .transform((value) => value.split(',').map((entry) => entry.trim())),
    /** Optional owner notification for new beta requests. All three values enable it. */
    RESEND_API_KEY: z.string().min(1).optional(),
    WAITLIST_NOTIFY_TO: z.email().optional(),
    WAITLIST_NOTIFY_FROM: z.string().min(3).max(200).optional(),

    /**
     * How /v1 requests are authenticated (ADR-021). `supabase` verifies Supabase Auth access tokens
     * (Google sign-in) and needs SUPABASE_URL; `dev` treats every request as the single local
     * `dev-user`. Defaults to `dev` in development; staging and production must set `supabase`.
     */
    AUTH_MODE: z.enum(['dev', 'supabase', 'pairing']).optional(),
    /**
     * `selfhost` runs one person's own server: phones pair with a code (AUTH_MODE=pairing) and
     * rings go through the Twring relay. `hosted` is Twring's own service and the default.
     */
    TWRING_MODE: z.enum(['hosted', 'selfhost']).default('hosted'),
    /** Self-hosted: Ed25519 PKCS8 PEM that is this server's identity. */
    TWRING_SERVER_KEY_FILE: z.string().min(1).optional(),
    /** Self-hosted: authenticates the admin command line on the local admin listener. */
    TWRING_ADMIN_TOKEN: z.string().min(32).optional(),
    /** Self-hosted: where the Twring relay is reached (staging and tests override it). */
    TWRING_RELAY_URL: z.url({ protocol: /^https$/ }).default('https://relay.twring.com'),
    /** Self-hosted: file holding the relay key this install registered with. */
    TWRING_RELAY_KEY_FILE: z.string().min(1).optional(),
    /** Self-hosted: call audio on the server's own LiveKit, or on Twring's. */
    TWRING_AUDIO: z.enum(['own', 'twring']).optional(),
    /** Self-hosted: the one space every person on this server belongs to. */
    TWRING_SPACE_ID: z.string().min(1).max(64).default('default'),
    CONNECTOR_MCP_ENABLED: envBoolean.default(false),
    /** Supabase project URL, e.g. https://<ref>.supabase.co. Public; its JWKS verifies tokens. */
    SUPABASE_URL: z.url({ protocol: /^https?$/ }).optional(),

    // LiveKit (Milestone 1). All three or none; required outside development.
    LIVEKIT_URL: z.url({ protocol: /^wss?$/ }).optional(),
    LIVEKIT_API_KEY: z.string().min(1).optional(),
    LIVEKIT_API_SECRET: z.string().min(1).optional(),

    /** Kill switch: false makes POST /v1/calls refuse new calls. Active calls are unaffected. */
    CALLS_ENABLED: envBoolean.default(true),
    CALL_MAX_CONCURRENT: z.coerce.number().int().min(1).max(1000).default(4),
    CALL_MAX_DURATION_S: z.coerce
      .number()
      .int()
      .min(60)
      .max(4 * 3600)
      .default(1800),
    /** Lifetime of the caller's join token. LiveKit refreshes it for connected participants. */
    CALL_TOKEN_TTL_S: z.coerce.number().int().min(60).max(3600).default(600),
    CALL_CREATE_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
    /**
     * Hard cap on one agent turn, in seconds. An agent that keeps working quietly (a long tool
     * run, kept alive by its connector's activity) still ends here, so a hung agent cannot hold
     * the turn forever.
     */
    AGENT_TURN_MAX_S: z.coerce.number().int().min(30).max(3600).default(600),
    /**
     * Kill switch for presence cues while an agent works (ADR-028): the "heard you" tone and the
     * spoken "Still working…" lines. `off` disables both.
     */
    PRESENCE_CUES: z.enum(['on', 'off']).default('on'),
    /**
     * Kill switch for the short spoken acknowledgement ("Okay, one moment.") when the agent is
     * still silent 1.5 s after the owner's turn (ADR-032). Also off when PRESENCE_CUES is off.
     */
    PRESENCE_ACK: z.enum(['on', 'off']).default('on'),
    /** Grace for a one- or two-word normal turn; 0 sends it immediately. */
    SHORT_TURN_HOLD_MS: z.coerce.number().int().min(0).max(3000).default(800),

    /** Kill switch: false makes agent connection tests (outbound requests) answer 503. */
    AGENT_TESTS_ENABLED: envBoolean.default(true),
    /** Kill switch: false makes voice previews (TTS synthesis) answer 503. */
    VOICE_SAMPLES_ENABLED: envBoolean.default(true),

    // Per-client rate limits (requests per minute; clients are told 429 `rate_limited`).
    /** Agent creates, edits, and deletes. */
    AGENT_WRITE_RATE_PER_MINUTE: ratePerMinute(30),
    /** Connection tests: each one makes outbound requests, so this stays tight. */
    AGENT_TEST_RATE_PER_MINUTE: ratePerMinute(6),
    /** Reads: agent list and details, voices, call history, call status. */
    API_READ_RATE_PER_MINUTE: ratePerMinute(120),
    /** Voice previews (cached answers are cheap; a first synthesis is not). */
    VOICE_SAMPLE_RATE_PER_MINUTE: ratePerMinute(20),
    /** `DELETE /v1/me/data`. */
    DATA_DELETE_RATE_PER_MINUTE: ratePerMinute(3),
    /** `POST /v1/connectors/claim` per IP: the brute-force bound on pairing codes (ADR-023). */
    CONNECTOR_CLAIM_RATE_PER_MINUTE: ratePerMinute(10),
    /** Connector relay socket upgrades per IP: the bound on connector token guessing. */
    CONNECTOR_SOCKET_RATE_PER_MINUTE: ratePerMinute(30),
    PHONE_SOCKET_RATE_PER_MINUTE: ratePerMinute(20),
    THREADS_ENABLED: envBoolean.default(false),
    FILES_ENABLED: envBoolean.default(false),
    /** People can save their own voice account keys (BYOK phase 1). */
    SPEECH_KEYS_ENABLED: envBoolean.optional(),
    SPEECH_KEY_WRITE_RATE_PER_MINUTE: ratePerMinute(5),
    CORD_PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
    THREAD_WRITE_RATE_PER_MINUTE: ratePerMinute(30),
    THREAD_READ_RATE_PER_MINUTE: ratePerMinute(120),
    THREAD_MESSAGES_PER_DAY: z.coerce.number().int().min(1).max(100_000).default(500),

    /**
     * Per-user allowance for each UTC day (0 = unlimited). Seconds of calling: a call that would
     * run past it is ended with a notice. Calls: new calls are refused once it is reached.
     */
    DAILY_CALL_SECONDS_PER_USER: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 3600)
      .default(3600),
    DAILY_CALLS_PER_USER: z.coerce.number().int().min(0).max(100_000).default(50),
    /**
     * Service-wide calling seconds each UTC day (0 = no cap; wave 1 cost guard). Past it new calls
     * are refused with `service_busy`; calls in progress finish. 80% sends the owner an alert.
     */
    SERVICE_DAILY_CALL_SECONDS: z.coerce.number().int().min(0).max(10_000_000).default(0),
    /** Where service alerts go (needs RESEND_API_KEY and WAITLIST_NOTIFY_FROM). */
    OWNER_ALERT_TO: z.email().optional(),

    /** Who runs this Twring, as printed on the public /privacy and /account-deletion pages. */
    CORD_OPERATOR_NAME: z.string().min(1).default('[OPERATOR NAME]'),
    /** Where the operator's name links on those pages (e.g. their X profile); https only. */
    CORD_OPERATOR_URL: z.url({ protocol: /^https$/ }).optional(),
    /** Where users write for privacy and account deletion requests. */
    CORD_SUPPORT_EMAIL: z.email().default('support@twring.com'),

    /**
     * Cost rates for the per-call usage estimate, in USD. 0 (the default) means unknown: that part
     * is left out of the estimate. Set them from your own vendor contracts; Twring ships no prices.
     */
    CORD_RATE_STT_PER_MIN: z.coerce.number().nonnegative().default(0),
    CORD_RATE_TTS_PER_1K_CHARS: z.coerce.number().nonnegative().default(0),
    CORD_RATE_ROOM_PER_MIN: z.coerce.number().nonnegative().default(0),
    /**
     * What a call does until users connect their own agents (Milestone 5): `agent` talks with the
     * built-in fake streaming agent; `repeat` speaks back exactly what STT heard (accuracy checks);
     * both need Deepgram. `native` talks with the Twring Native (`cord-agent/1`) agent at
     * AGENT_NATIVE_URL, `rest` with the REST + SSE (`cord-rest/1`) agent at AGENT_REST_URL (both
     * need Deepgram too). `echo` plays the caller back; `tone` plays a chime;
     * `off` is silent. Defaults to `agent` when Deepgram is configured, else `echo`.
     */
    GATEWAY_AUDIO_TEST_MODE: z
      .enum(['agent', 'repeat', 'native', 'rest', 'echo', 'tone', 'off'])
      .optional(),

    // Twring Native agent (Milestone 5). Required when GATEWAY_AUDIO_TEST_MODE=native.
    /** The agent's cord-agent/1 WebSocket endpoint; wss:// and a public host outside development. */
    AGENT_NATIVE_URL: z.url({ protocol: /^wss?$/ }).optional(),
    /** Server-side secret sent as a bearer token to the agent: never in the mobile app or logs. */
    AGENT_NATIVE_TOKEN: z.string().min(1).optional(),

    // REST + SSE agent (Milestone 6). Required when GATEWAY_AUDIO_TEST_MODE=rest.
    /** The agent's cord-rest/1 turn endpoint; https:// and a public host outside development. */
    AGENT_REST_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Server-side secret sent as a bearer token to the agent: never in the mobile app or logs. */
    AGENT_REST_TOKEN: z.string().min(1).optional(),

    // Deepgram (Milestone 2). Server-side secret: never in the mobile app.
    DEEPGRAM_API_KEY: z.string().min(1).optional(),
    /** Self-hosted: the server's own xAI key for listening and voice (hosted people bring theirs). */
    XAI_API_KEY: z.string().min(1).optional(),
    DEEPGRAM_STT_MODEL: z
      .string()
      .regex(/^flux-[a-z0-9-]+$/, 'must be a Flux STT model')
      .default('flux-general-en'),
    /**
     * Comma-separated language hints (e.g. `en,hi` or `en-IN`). Only `flux-general-multi` accepts
     * them; Deepgram rejects hints on `flux-general-en`.
     */
    DEEPGRAM_STT_LANGUAGE_HINTS: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?(,[a-z]{2}(-[A-Z]{2})?)*$/, 'must be codes like en,hi or en-IN')
      .optional(),
    /**
     * Comma-separated words or short phrases STT should favour (names, places), e.g.
     * `Chennai,Mysore`. Up to 50 terms of at most 50 characters each. The interruption words
     * (INTERRUPTION_KEYTERMS) are always appended, deduped, within the 50-term cap.
     */
    DEEPGRAM_STT_KEYTERMS: z
      .string()
      .transform((value) =>
        value
          .split(',')
          .map((term) => term.trim())
          .filter((term) => term !== ''),
      )
      .pipe(z.array(z.string().max(50)).max(50))
      .optional(),
    /**
     * Flux end-of-turn confidence (`eot_threshold`, 0.5–1.0; Flux default 0.7). Higher means fewer
     * cut-offs mid-thought, at the cost of slightly later replies. Unset: Flux's default.
     */
    DEEPGRAM_STT_EOT_THRESHOLD: z.coerce.number().min(0.5).max(1).optional(),
    /** Flux silence before a forced end of turn (`eot_timeout_ms`, 500–60000; default 5000). */
    DEEPGRAM_STT_EOT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).optional(),
    /**
     * Development only: save each call's STT input audio (16 kHz PCM) and committed captions to
     * this folder so recognition problems can be replayed. Off unless set; refused elsewhere.
     */
    DEBUG_AUDIO_CAPTURE_DIR: z.string().min(1).optional(),
    DEEPGRAM_TTS_MODEL: z
      .string()
      .regex(/^flux-[a-z0-9-]+$/, 'must be a Flux TTS voice')
      .default('flux-haley-en'),

    // Cartesia Sonic TTS (ADR-020): an optional second voice provider. Server-side secret.
    /** Unset hides the Cartesia voices; Deepgram stays the default voice either way. */
    CARTESIA_API_KEY: z.string().min(1).optional(),
    /** Sonic model id; `sonic-3.6` or newer (Twring sends `locale`, which needs 3.6). */
    CARTESIA_TTS_MODEL: z
      .string()
      .regex(/^sonic(-[a-z0-9.]+)*$/, 'must be a Sonic TTS model')
      .default('sonic-3.6'),
    /**
     * Cartesia speaking pace (`generation_config.speed`, 0.6–1.5; 1 is the voice's own pace). The
     * provider treats it as guidance, so pacing stays natural. Owners found long agent replies
     * too fast at 1.
     */
    CARTESIA_TTS_SPEED: z.coerce.number().min(0.6).max(1.5).default(1),

    // xAI Grok listening (BYOK): tuning for a person's own xAI key. No server-side xAI key exists.
    /** Silence (ms) before xAI ends an utterance. */
    XAI_STT_ENDPOINTING_MS: z.coerce.number().int().min(0).max(5000).default(400),
    /** Smart-turn threshold (0..1). Unset leaves smart turn off. */
    XAI_STT_SMART_TURN: z.coerce.number().min(0).max(1).optional(),
    /** Smart-turn timeout (ms). */
    XAI_STT_SMART_TURN_TIMEOUT_MS: z.coerce.number().int().min(1).max(5000).optional(),

    // Agent rings the owner (ADR-024): FCM HTTP v1 push.
    /**
     * Path to the Firebase service-account JSON (server secret; the file, never its contents, is
     * configured). Unset: rings still create invites, but no push is sent.
     */
    FCM_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),
    // iPhone rings and notifications: APNs straight from the gateway.
    /**
     * Path to the APNs auth key (.p8, server secret; the file, never its contents, is configured).
     * Unset: iPhones get no rings or notifications. Needs APNS_KEY_ID and APNS_TEAM_ID.
     */
    APNS_KEY_FILE: z.string().min(1).optional(),
    APNS_KEY_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    APNS_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    /** The app's bundle id: the alert topic, and with `.voip` the VoIP topic. */
    APNS_BUNDLE_ID: z
      .string()
      .regex(/^[A-Za-z0-9.-]{3,155}$/)
      .default('com.twring.app'),
    /** `production` for TestFlight and App Store builds; `sandbox` for Xcode development builds. */
    APNS_ENV: z.enum(['production', 'sandbox']).default('production'),
    // Sign in with Apple: ends an account's Apple sign-in
    // when the account is deleted.
    /**
     * Path to the Sign in with Apple key (.p8, server secret; the file, never its contents).
     * Unset: deleting an Apple account cannot end its Apple sign-in (503 for that step).
     * Needs APPLE_SIGNIN_KEY_ID and APPLE_SIGNIN_TEAM_ID.
     */
    APPLE_SIGNIN_KEY_FILE: z.string().min(1).optional(),
    APPLE_SIGNIN_KEY_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    APPLE_SIGNIN_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    /** The app's bundle id, which is the Sign in with Apple client id for the native app. */
    APPLE_SIGNIN_CLIENT_ID: z
      .string()
      .regex(/^[A-Za-z0-9.-]{3,155}$/)
      .default('com.twring.app'),

    // Saved agents (Milestone 7). File-backed until the Supabase move (ADR-018).
    /** Folder for agents, encrypted credentials, and call history. Defaults to ./data in development. */
    CORD_DATA_DIR: z.string().min(1).optional(),
    CORD_THREADS_DB: z.string().min(1).optional(),
    /**
     * 32-byte AES-256-GCM key (base64) that encrypts saved agent credentials. Server secret.
     * Without it the agents API answers 503 (development only; required elsewhere).
     */
    CORD_CREDENTIALS_KEY: credentialsKey.optional(),
    /** Version stored with each secret this key encrypts. Bump it when rotating the key. */
    CORD_CREDENTIALS_KEY_VERSION: z.coerce.number().int().min(1).max(MAX_KEY_VERSION).default(1),
    /** Older keys still able to decrypt, as `version:base64key` pairs separated by commas. */
    CORD_CREDENTIALS_OLD_KEYS: z
      .string()
      .transform((value, ctx) => {
        const keys = new Map<number, string>();
        for (const pair of value
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p !== '')) {
          const match = /^(\d+):(.+)$/.exec(pair);
          const version = match ? Number(match[1]) : NaN;
          if (!match || !isKey(match[2]!) || version < 1 || version > MAX_KEY_VERSION) {
            ctx.addIssue({
              code: 'custom',
              message: `must be version:base64key pairs (32-byte keys, versions 1-${MAX_KEY_VERSION})`,
            });
            return z.NEVER;
          }
          if (keys.has(version)) {
            ctx.addIssue({ code: 'custom', message: 'must not repeat a key version' });
            return z.NEVER;
          }
          keys.set(version, match[2]!);
        }
        return keys;
      })
      .optional(),
  })
  .superRefine((env, ctx) => {
    if (env.FILES_ENABLED && !env.THREADS_ENABLED)
      ctx.addIssue({
        code: 'custom',
        path: ['FILES_ENABLED'],
        message: 'requires THREADS_ENABLED=true',
      });
    if (env.FILES_ENABLED && env.CORD_ENV !== 'development' && !env.CORD_PUBLIC_URL)
      ctx.addIssue({
        code: 'custom',
        path: ['CORD_PUBLIC_URL'],
        message: 'is required when FILES_ENABLED=true outside development',
      });
    if (env.CORD_ENV !== 'development' && env.CORD_PUBLIC_URL?.startsWith('http://'))
      ctx.addIssue({
        code: 'custom',
        path: ['CORD_PUBLIC_URL'],
        message: 'must use https:// outside development',
      });
    for (const origin of env.WAITLIST_ALLOWED_ORIGINS) {
      const localhost =
        env.CORD_ENV === 'development' && /^http:\/\/localhost:[1-9]\d{0,4}$/.test(origin);
      const secureOrigin =
        /^https:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[1-9]\d{0,4})?$/.test(origin);
      if (!z.url().safeParse(origin).success || !(secureOrigin || localhost)) {
        ctx.addIssue({
          code: 'custom',
          path: ['WAITLIST_ALLOWED_ORIGINS'],
          message: 'must contain HTTPS origins (or development localhost with a port)',
        });
      }
    }
    const selfhost = env.TWRING_MODE === 'selfhost';
    const present = LIVEKIT_KEYS.filter((key) => env[key] !== undefined);
    if (present.length > 0 && present.length < LIVEKIT_KEYS.length) {
      for (const key of LIVEKIT_KEYS.filter((k) => env[k] === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required with the other LIVEKIT_* values',
        });
      }
    }
    if (env.CORD_ENV !== 'development' && (!selfhost || env.TWRING_AUDIO === 'own')) {
      if (present.length === 0) {
        for (const key of LIVEKIT_KEYS) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `is required when CORD_ENV=${env.CORD_ENV}`,
          });
        }
      }
      if (env.LIVEKIT_URL !== undefined && !env.LIVEKIT_URL.startsWith('wss://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['LIVEKIT_URL'],
          message: `must use wss:// when CORD_ENV=${env.CORD_ENV}`,
        });
      }
    }
    if (selfhost) validateSelfhost(env, ctx);
    else if (env.AUTH_MODE === 'pairing') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: 'pairing needs TWRING_MODE=selfhost',
      });
    }
    if (!selfhost && env.CORD_ENV !== 'development' && env.DEEPGRAM_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEEPGRAM_API_KEY'],
        message: `is required when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.DEEPGRAM_STT_LANGUAGE_HINTS !== undefined &&
      env.DEEPGRAM_STT_MODEL !== 'flux-general-multi'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEEPGRAM_STT_LANGUAGE_HINTS'],
        message: 'needs DEEPGRAM_STT_MODEL=flux-general-multi',
      });
    }
    if (env.DEBUG_AUDIO_CAPTURE_DIR !== undefined && env.CORD_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEBUG_AUDIO_CAPTURE_DIR'],
        message: 'is only allowed when CORD_ENV=development (Twring does not keep call audio)',
      });
    }
    const mode = env.GATEWAY_AUDIO_TEST_MODE;
    if (mode === 'native') {
      for (const key of ['AGENT_NATIVE_URL', 'AGENT_NATIVE_TOKEN'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required when mode is native' });
        }
      }
    }
    if (mode === 'rest') {
      for (const key of ['AGENT_REST_URL', 'AGENT_REST_TOKEN'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required when mode is rest' });
        }
      }
    }
    if (
      env.AGENT_REST_URL !== undefined &&
      env.CORD_ENV !== 'development' &&
      !env.AGENT_REST_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_REST_URL'],
        message: `must use https:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.AGENT_REST_TOKEN !== undefined &&
      env.CORD_ENV !== 'development' &&
      env.AGENT_REST_TOKEN.length < 16
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_REST_TOKEN'],
        message: `must be at least 16 characters when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.AGENT_NATIVE_URL !== undefined &&
      env.CORD_ENV !== 'development' &&
      !env.AGENT_NATIVE_URL.startsWith('wss://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_NATIVE_URL'],
        message: `must use wss:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.AGENT_NATIVE_TOKEN !== undefined &&
      env.CORD_ENV !== 'development' &&
      env.AGENT_NATIVE_TOKEN.length < 16
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_NATIVE_TOKEN'],
        message: `must be at least 16 characters when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      (mode === 'agent' || mode === 'repeat' || mode === 'native' || mode === 'rest') &&
      env.DEEPGRAM_API_KEY === undefined &&
      !(selfhost && env.XAI_API_KEY !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['GATEWAY_AUDIO_TEST_MODE'],
        message: `${mode} needs DEEPGRAM_API_KEY`,
      });
    }
    if (env.CORD_ENV !== 'development') {
      for (const key of ['CORD_DATA_DIR', 'CORD_CREDENTIALS_KEY'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `is required when CORD_ENV=${env.CORD_ENV}`,
          });
        }
      }
    }
    if (!selfhost && env.CORD_ENV !== 'development' && env.AUTH_MODE !== 'supabase') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: `must be supabase when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.APNS_KEY_FILE !== undefined &&
      (env.APNS_KEY_ID === undefined || env.APNS_TEAM_ID === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APNS_KEY_FILE'],
        message: 'needs APNS_KEY_ID and APNS_TEAM_ID',
      });
    }
    if (
      env.OWNER_ALERT_TO !== undefined &&
      (env.RESEND_API_KEY === undefined || env.WAITLIST_NOTIFY_FROM === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['OWNER_ALERT_TO'],
        message: 'needs RESEND_API_KEY and WAITLIST_NOTIFY_FROM, or the alerts can never send',
      });
    }
    if (
      env.APPLE_SIGNIN_KEY_FILE !== undefined &&
      (env.APPLE_SIGNIN_KEY_ID === undefined || env.APPLE_SIGNIN_TEAM_ID === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APPLE_SIGNIN_KEY_FILE'],
        message: 'needs APPLE_SIGNIN_KEY_ID and APPLE_SIGNIN_TEAM_ID',
      });
    }
    if (env.AUTH_MODE === 'supabase' && env.SUPABASE_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: 'is required when AUTH_MODE=supabase',
      });
    }
    if (
      env.CONNECTOR_MCP_ENABLED &&
      (env.AUTH_MODE !== 'supabase' || env.CORD_PUBLIC_URL === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONNECTOR_MCP_ENABLED'],
        message: 'requires AUTH_MODE=supabase and CORD_PUBLIC_URL',
      });
    }
    // The token issuer and the JWKS URL are derived from it, so a path would reject every token.
    if (env.SUPABASE_URL !== undefined) {
      if (!/^https?:\/\/[^/?#]+\/?$/.test(env.SUPABASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SUPABASE_URL'],
          message: 'must be the project URL alone, like https://<ref>.supabase.co',
        });
      }
    }
    if (
      env.SUPABASE_URL !== undefined &&
      env.CORD_ENV !== 'development' &&
      !env.SUPABASE_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: `must use https:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (env.CORD_CREDENTIALS_OLD_KEYS?.has(env.CORD_CREDENTIALS_KEY_VERSION)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORD_CREDENTIALS_OLD_KEYS'],
        message: 'must not reuse CORD_CREDENTIALS_KEY_VERSION',
      });
    }
    if (env.NODE_ENV === 'production' && env.CORD_ENV === 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORD_ENV'],
        message: 'must be staging or production when NODE_ENV=production',
      });
    }
    if (env.CORD_ENV === 'production') {
      // Hosted Twring reports errors to its own Sentry; a self-hosted server only if its owner
      // sets one (the installer never does: their errors are not ours to collect).
      if (env.SENTRY_DSN === undefined && !selfhost) {
        ctx.addIssue({
          code: 'custom',
          path: ['SENTRY_DSN'],
          message: 'is required when CORD_ENV=production',
        });
      } else if (env.SENTRY_DSN !== undefined && !env.SENTRY_DSN.startsWith('https://')) {
        ctx.addIssue({
          code: 'custom',
          path: ['SENTRY_DSN'],
          message: 'must use https:// when CORD_ENV=production',
        });
      }
      // Development test lines and fixtures: a production call always goes to a saved agent.
      for (const key of [
        'GATEWAY_AUDIO_TEST_MODE',
        'AGENT_NATIVE_URL',
        'AGENT_NATIVE_TOKEN',
        'AGENT_REST_URL',
        'AGENT_REST_TOKEN',
      ] as const) {
        if (env[key] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'is a development setting and is not allowed when CORD_ENV=production',
          });
        }
      }
      if (env.TRUST_PROXY === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['TRUST_PROXY'],
          message:
            'must list the proxy addresses (like 127.0.0.1) when CORD_ENV=production, not true',
        });
      }
      if (
        env.CORD_CREDENTIALS_KEY !== undefined &&
        isWeakCredentialsKey(env.CORD_CREDENTIALS_KEY)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORD_CREDENTIALS_KEY'],
          message: 'is a published or non-random key; generate a new one (docs/DEVELOPMENT.md)',
        });
      }
    }
  })
  .transform((env) => ({
    ...env,
    CORD_PUBLIC_URL: (env.CORD_PUBLIC_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, ''),
    CORD_DATA_DIR: env.CORD_DATA_DIR ?? './data',
    SPEECH_KEYS_ENABLED: env.SPEECH_KEYS_ENABLED ?? env.TWRING_MODE === 'selfhost',
    // Only development can reach this default: elsewhere the refinement above requires supabase.
    AUTH_MODE: env.AUTH_MODE ?? ('dev' as const),
    GATEWAY_AUDIO_TEST_MODE:
      env.GATEWAY_AUDIO_TEST_MODE ??
      (env.DEEPGRAM_API_KEY === undefined &&
      !(env.TWRING_MODE === 'selfhost' && env.XAI_API_KEY !== undefined)
        ? ('echo' as const)
        : ('agent' as const)),
  }));

export type GatewayEnv = z.infer<typeof gatewayEnvSchema>;

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** The LiveKit settings when configured. Undefined only in development without LiveKit. */
export function liveKitConfig(env: GatewayEnv): LiveKitConfig | undefined {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: apiSecret } = env;
  if (url === undefined || apiKey === undefined || apiSecret === undefined) return undefined;
  return { url, apiKey, apiSecret };
}

/**
 * Words a caller uses to interrupt the agent, always favoured by STT (ADR-017): the first word of an
 * interruption is spoken over the agent's voice and echo cancellation clips it ("stop" → "stuff").
 */
export const INTERRUPTION_KEYTERMS: readonly string[] = [
  'wait',
  'stop',
  'hold on',
  'hang on',
  'one second',
];

/**
 * Keyterm limits. Deepgram documents a 500-token budget across all keyterms; we also keep the
 * 50-term count cap. Tokens are estimated conservatively (proper nouns split into many tokens) and
 * held to 450, leaving headroom under the documented budget.
 */
export const MAX_STT_KEYTERMS = 50;
export const MAX_STT_KEYTERM_TOKENS = 450;

/**
 * A conservative token estimate for one keyterm: about one token per three ASCII characters, one
 * per non-ASCII code point (Tamil, Devanagari and similar scripts tokenize close to a token per
 * character), plus one.
 */
export function estimateKeytermTokens(term: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of term) {
    if (char.codePointAt(0)! < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other + 1;
}

/**
 * Merges keyterm lists in priority order: trimmed, deduped case-insensitively, and cut off at the
 * count cap or token budget, so earlier lists win when there is no room for all of them.
 */
export function mergeSttKeyterms(...lists: readonly (readonly string[])[]): string[] {
  return mergeWithin(MAX_STT_KEYTERMS, MAX_STT_KEYTERM_TOKENS, lists);
}

function mergeWithin(
  maxTerms: number,
  maxTokens: number,
  lists: readonly (readonly string[])[],
): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  let tokens = 0;
  for (const raw of lists.flat()) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (term === '' || seen.has(key)) continue;
    const cost = estimateKeytermTokens(term);
    if (terms.length >= maxTerms || tokens + cost > maxTokens) continue;
    seen.add(key);
    terms.push(term);
    tokens += cost;
  }
  return terms;
}

/** The product's own name, which STT otherwise hears as "cord" or "chord". */
export const PRODUCT_KEYTERM = 'Twring';

/** Longest single keyterm, as DEEPGRAM_STT_KEYTERMS and saved agents' terms are capped. */
const MAX_KEYTERM_CHARS = 50;

/**
 * Words every call listens for besides the owner's: `Twring`, the agent's display name, and each word
 * of a multi-word name longer than 2 characters ("Hermes Agent" → "Hermes", "Agent").
 */
export function identityKeyterms(agentName?: string): string[] {
  const terms = [PRODUCT_KEYTERM];
  const name = agentName?.trim() ?? '';
  if (name === '') return terms;
  // Names may run to 60 characters; a keyterm is at most 50 everywhere else (the words still go).
  if (name.length <= MAX_KEYTERM_CHARS) terms.push(name);
  const words = name.split(/\s+/);
  if (words.length > 1) {
    terms.push(...words.filter((word) => [...word].length > 2 && word.length <= MAX_KEYTERM_CHARS));
  }
  return terms;
}

/** The owner's keyterms first, then the interruption defaults and Twring, deduped and within the cap. */
function withInterruptionKeyterms(owner: readonly string[]): string[] {
  return mergeSttKeyterms(owner, INTERRUPTION_KEYTERMS, identityKeyterms());
}

/**
 * Keyterms for a call to a saved agent: the agent's own terms first (what its owner asked for),
 * then the interruption defaults, then Twring and the agent's name (identityKeyterms), then the
 * deployment-wide DEEPGRAM_STT_KEYTERMS. Room for the
 * interruption words is reserved, so a long agent list can never crowd out barge-in (ADR-017).
 */
export function agentSttKeyterms(
  config: DeepgramConfig,
  agentTerms: readonly string[],
  agentName?: string,
): string[] {
  const reservedTokens = INTERRUPTION_KEYTERMS.reduce(
    (sum, t) => sum + estimateKeytermTokens(t),
    0,
  );
  const agent = mergeWithin(
    MAX_STT_KEYTERMS - INTERRUPTION_KEYTERMS.length,
    MAX_STT_KEYTERM_TOKENS - reservedTokens,
    [agentTerms],
  );
  return mergeSttKeyterms(
    agent,
    INTERRUPTION_KEYTERMS,
    identityKeyterms(agentName),
    config.sttEnvKeyterms,
  );
}

export interface DeepgramConfig {
  apiKey: string;
  sttModel: string;
  sttLanguageHints: readonly string[];
  sttKeyterms: readonly string[];
  /** DEEPGRAM_STT_KEYTERMS alone, for merging after a saved agent's own terms. */
  sttEnvKeyterms: readonly string[];
  /** Flux `eot_threshold`; undefined keeps Flux's default. */
  sttEotThreshold?: number;
  /** Flux `eot_timeout_ms`; undefined keeps Flux's default. */
  sttEotTimeoutMs?: number;
  ttsModel: string;
}

/** The Deepgram settings when configured. Undefined only in development without a key. */
export function deepgramConfig(env: GatewayEnv): DeepgramConfig | undefined {
  if (env.DEEPGRAM_API_KEY === undefined) return undefined;
  return {
    apiKey: env.DEEPGRAM_API_KEY,
    sttModel: env.DEEPGRAM_STT_MODEL,
    sttLanguageHints: env.DEEPGRAM_STT_LANGUAGE_HINTS?.split(',') ?? [],
    sttKeyterms: withInterruptionKeyterms(env.DEEPGRAM_STT_KEYTERMS ?? []),
    sttEnvKeyterms: env.DEEPGRAM_STT_KEYTERMS ?? [],
    ...(env.DEEPGRAM_STT_EOT_THRESHOLD !== undefined && {
      sttEotThreshold: env.DEEPGRAM_STT_EOT_THRESHOLD,
    }),
    ...(env.DEEPGRAM_STT_EOT_TIMEOUT_MS !== undefined && {
      sttEotTimeoutMs: env.DEEPGRAM_STT_EOT_TIMEOUT_MS,
    }),
    ttsModel: env.DEEPGRAM_TTS_MODEL,
  };
}

export interface CartesiaConfig {
  apiKey: string;
  ttsModel: string;
  ttsSpeed: number;
}

/** The Cartesia settings when configured; undefined means Cartesia voices are not offered. */
export function cartesiaConfig(env: GatewayEnv): CartesiaConfig | undefined {
  if (env.CARTESIA_API_KEY === undefined) return undefined;
  return {
    apiKey: env.CARTESIA_API_KEY,
    ttsModel: env.CARTESIA_TTS_MODEL,
    ttsSpeed: env.CARTESIA_TTS_SPEED,
  };
}

export interface NativeAgentConfig {
  url: string;
  token: string;
}

/** The Twring Native agent endpoint when configured (always, in `native` mode). */
export function nativeAgentConfig(
  env: Pick<GatewayEnv, 'AGENT_NATIVE_URL' | 'AGENT_NATIVE_TOKEN'>,
): NativeAgentConfig | undefined {
  if (env.AGENT_NATIVE_URL === undefined || env.AGENT_NATIVE_TOKEN === undefined) return undefined;
  return { url: env.AGENT_NATIVE_URL, token: env.AGENT_NATIVE_TOKEN };
}

export interface RestAgentConfig {
  url: string;
  token: string;
}

/** The REST + SSE agent endpoint when configured (always, in `rest` mode). */
export function restAgentConfig(
  env: Pick<GatewayEnv, 'AGENT_REST_URL' | 'AGENT_REST_TOKEN'>,
): RestAgentConfig | undefined {
  if (env.AGENT_REST_URL === undefined || env.AGENT_REST_TOKEN === undefined) return undefined;
  return { url: env.AGENT_REST_URL, token: env.AGENT_REST_TOKEN };
}

export interface CredentialKeys {
  /** Version new secrets are sealed with. */
  currentVersion: number;
  /** Every usable key by version (the current one included), base64 of 32 bytes each. */
  keys: ReadonlyMap<number, string>;
}

/** The credential encryption keys when configured. Undefined only in development without a key. */
export function credentialKeys(env: GatewayEnv): CredentialKeys | undefined {
  if (env.CORD_CREDENTIALS_KEY === undefined) return undefined;
  const keys = new Map<number, string>(env.CORD_CREDENTIALS_OLD_KEYS ?? []);
  keys.set(env.CORD_CREDENTIALS_KEY_VERSION, env.CORD_CREDENTIALS_KEY);
  return { currentVersion: env.CORD_CREDENTIALS_KEY_VERSION, keys };
}

export function loadGatewayEnv(source: EnvSource): GatewayEnv {
  return parseEnv(gatewayEnvSchema, source);
}
