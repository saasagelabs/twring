import { twringEnvironmentSchema } from '@twring/contracts';
import { z } from 'zod';

import { parseEnv, type EnvSource } from './parse';

export { ConfigError } from './parse';

export const DEFAULT_RELAY_URL = 'https://relay.twring.com';

/**
 * Public mobile configuration. Everything here ships inside the app binary and is readable
 * by anyone with the APK/IPA, so it must never contain a secret (CLAUDE.md rule 3).
 */
export const mobilePublicEnvSchema = z
  .object({
    CORD_ENV: twringEnvironmentSchema.default('development'),
    API_BASE_URL: z.url(),
    LIVEKIT_PUBLIC_URL: z.url().optional(),
    /** Twring's relay for self-hosted servers. Unset means DEFAULT_RELAY_URL (see relayUrl). */
    RELAY_URL: z.url().optional(),
    SENTRY_DSN: z.url().optional(),
    // Sign-in (ADR-021). Public values: the publishable key is designed to ship in apps.
    SUPABASE_URL: z.url({ protocol: /^https?$/ }).optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    /** Google OAuth "Web application" client id; Google Sign-In issues ID tokens for it. */
    GOOGLE_WEB_CLIENT_ID: z.string().min(1).optional(),
    /** Google OAuth iOS client id (iOS builds only). */
    GOOGLE_IOS_CLIENT_ID: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if ((env.SUPABASE_URL === undefined) !== (env.SUPABASE_PUBLISHABLE_KEY === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: [env.SUPABASE_URL === undefined ? 'SUPABASE_URL' : 'SUPABASE_PUBLISHABLE_KEY'],
        message: 'is required with the other SUPABASE_* value',
      });
    }
    // Supabase clients append their own paths, so a path here would break sign-in.
    if (env.SUPABASE_URL !== undefined) {
      if (!/^https?:\/\/[^/?#]+\/?$/.test(env.SUPABASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['SUPABASE_URL'],
          message: 'must be the project URL alone, like https://<ref>.supabase.co',
        });
      }
    }
    if (env.CORD_ENV === 'development') return;
    // Outside development sign-in is mandatory: the gateway runs AUTH_MODE=supabase.
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_PUBLISHABLE_KEY',
      'GOOGLE_WEB_CLIENT_ID',
    ] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `is required when CORD_ENV=${env.CORD_ENV}`,
        });
      }
    }
    if (env.SUPABASE_URL !== undefined && !env.SUPABASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: `must use https:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (
      env.CORD_ENV === 'production' &&
      env.RELAY_URL !== undefined &&
      env.RELAY_URL !== DEFAULT_RELAY_URL
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['RELAY_URL'],
        message: `cannot be overridden when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (env.RELAY_URL !== undefined && !env.RELAY_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['RELAY_URL'],
        message: `must use https:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (!env.API_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_BASE_URL'],
        message: `must use https:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
    if (env.LIVEKIT_PUBLIC_URL !== undefined && !env.LIVEKIT_PUBLIC_URL.startsWith('wss://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['LIVEKIT_PUBLIC_URL'],
        message: `must use wss:// when CORD_ENV=${env.CORD_ENV}`,
      });
    }
  });

/** The relay address: the build's override, else the production relay. */
export function relayUrl(env: MobilePublicEnv): string {
  return env.RELAY_URL ?? DEFAULT_RELAY_URL;
}

export type MobilePublicEnv = z.infer<typeof mobilePublicEnvSchema>;

export interface MobileAuthConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  googleWebClientId: string;
  googleIosClientId?: string;
}

/**
 * Sign-in settings when all are present. Undefined only in development without them: the app then
 * runs signed out against an `AUTH_MODE=dev` gateway.
 */
export function mobileAuthConfig(env: MobilePublicEnv): MobileAuthConfig | undefined {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, GOOGLE_WEB_CLIENT_ID } = env;
  if (
    SUPABASE_URL === undefined ||
    SUPABASE_PUBLISHABLE_KEY === undefined ||
    GOOGLE_WEB_CLIENT_ID === undefined
  ) {
    return undefined;
  }
  return {
    supabaseUrl: SUPABASE_URL,
    supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
    googleWebClientId: GOOGLE_WEB_CLIENT_ID,
    ...(env.GOOGLE_IOS_CLIENT_ID !== undefined && { googleIosClientId: env.GOOGLE_IOS_CLIENT_ID }),
  };
}

export function loadMobilePublicEnv(source: EnvSource): MobilePublicEnv {
  return parseEnv(mobilePublicEnvSchema, source);
}
