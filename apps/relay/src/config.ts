import { isIP } from 'node:net';

import { z } from 'zod';

/** Invalid configuration. Carries variable names and reasons only, never values. */
export class ConfigError extends Error {
  readonly code = 'config_invalid';

  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** An IPv4 or IPv6 address, optionally with a CIDR prefix that fits its family. */
function isProxyAddress(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  const bits = family === 4 ? 32 : 128;
  return prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits);
}

/** `true`/`false`, or the proxy addresses to trust (comma-separated IPs or CIDRs). */
const trustProxy = z.string().transform((value, ctx): boolean | string[] => {
  const text = value.trim();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0' || text === '') return false;
  const entries = text.split(',').map((entry) => entry.trim());
  if (!entries.every(isProxyAddress)) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be true, false, or proxy addresses like 127.0.0.1,10.0.0.0/8',
    });
    return z.NEVER;
  }
  return entries;
});

export const relayEnvSchema = z
  .object({
    RELAY_ENV: z.enum(['development', 'staging', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(8090),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: trustProxy.default(false),
    RELAY_DB_FILE: z.string().min(1).default('./data/relay.db'),
    /** The address email links point at. */
    RELAY_PUBLIC_URL: z.url().default('https://relay.twring.com'),
    /** Every new install's `paid_until` (ISO date or date-time). */
    RELAY_FREE_UNTIL: z.union([z.iso.date(), z.iso.datetime()]),
    RELAY_ADMIN_TOKEN: z.string().min(32),
    RELAY_PARTNER_TOKENS_FILE: z.string().min(1).optional(),
    /** Resend key for verification emails: the relay's own key, never production's. */
    RELAY_RESEND_API_KEY: z.string().min(1).optional(),
    /** New installs per hour across every address. */
    RELAY_INSTALLS_PER_HOUR: z.coerce.number().int().min(1).default(200),
    /** Verification emails per 24 hours across every address (Resend's free plan allows 100). */
    RELAY_EMAILS_PER_DAY: z.coerce.number().int().min(1).default(90),
    RELAY_EMAIL_FROM: z.string().min(3).max(200).default('Twring <invites@saasage.in>'),
    /** Firebase service account file for Android pushes (the file path, never its contents). */
    RELAY_FCM_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),
    /** APNs auth key (.p8) for iPhone pushes; needs RELAY_APNS_KEY_ID and RELAY_APNS_TEAM_ID. */
    RELAY_APNS_KEY_FILE: z.string().min(1).optional(),
    RELAY_APNS_KEY_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    RELAY_APNS_TEAM_ID: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    /** The app's bundle id: the alert topic, and with `.voip` the VoIP topic. */
    RELAY_APNS_BUNDLE_ID: z
      .string()
      .regex(/^[A-Za-z0-9.-]{3,155}$/)
      .default('com.twring.app'),
    RELAY_APNS_ENV: z.enum(['production', 'sandbox']).default('production'),
    /** Twring-run call audio for servers that cannot run their own. Off unless turned on. */
    RELAY_AUDIO_ENABLED: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
    /** Twring's LiveKit project: its signalling address and API key (required with audio on). */
    RELAY_LIVEKIT_URL: z.url({ protocol: /^wss?$/ }).optional(),
    RELAY_LIVEKIT_API_KEY: z.string().min(1).optional(),
    RELAY_LIVEKIT_API_SECRET: z.string().min(1).optional(),
    /** Fair use per install: calls at once, and call minutes per UTC day. */
    RELAY_AUDIO_MAX_CONCURRENT: z.coerce.number().int().min(1).max(100).default(3),
    RELAY_AUDIO_MINUTES_PER_DAY: z.coerce.number().int().min(1).default(600),
    /** Relay-wide: calls at once, and call minutes per UTC day, across every install. */
    RELAY_AUDIO_MAX_CONCURRENT_TOTAL: z.coerce.number().int().min(1).default(50),
    RELAY_AUDIO_DAILY_MINUTES_TOTAL: z.coerce.number().int().min(1).default(3000),
  })
  .superRefine((env, ctx) => {
    if (env.RELAY_AUDIO_ENABLED) {
      for (const key of [
        'RELAY_LIVEKIT_URL',
        'RELAY_LIVEKIT_API_KEY',
        'RELAY_LIVEKIT_API_SECRET',
      ] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'is required with audio on' });
        }
      }
    }
    if (env.RELAY_ENV === 'development') return;
    if (env.RELAY_LIVEKIT_URL !== undefined && !env.RELAY_LIVEKIT_URL.startsWith('wss://')) {
      ctx.addIssue({ code: 'custom', path: ['RELAY_LIVEKIT_URL'], message: 'must be wss' });
    }
    if (!env.RELAY_PUBLIC_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['RELAY_PUBLIC_URL'], message: 'must be https' });
    }
    if (env.RELAY_RESEND_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['RELAY_RESEND_API_KEY'],
        message: 'is required outside development (verification emails)',
      });
    }
    if (env.TRUST_PROXY === true && env.RELAY_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'must list the proxy addresses (like 127.0.0.1) in production, not true',
      });
    }
  });

export type RelayEnv = z.infer<typeof relayEnvSchema>;

/** Parses the environment; unset and empty variables mean the same. */
export function loadRelayEnv(source: Readonly<Record<string, string | undefined>>): RelayEnv {
  const present = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== '',
    ),
  );
  const result = relayEnvSchema.safeParse(present);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** `RELAY_FREE_UNTIL` as an ISO date-time (a bare date means its first instant, UTC). */
export function freeUntil(env: Pick<RelayEnv, 'RELAY_FREE_UNTIL'>): string {
  const text = env.RELAY_FREE_UNTIL;
  return new Date(text.length === 10 ? `${text}T00:00:00.000Z` : text).toISOString();
}
