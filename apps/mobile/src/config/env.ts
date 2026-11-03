import { ConfigError, loadMobilePublicEnv, type MobilePublicEnv } from '@twring/config/mobile';

export type MobileEnvResult =
  { ok: true; env: MobilePublicEnv } | { ok: false; issues: readonly string[] };

/** Pure so it can be unit-tested without the Expo runtime. */
export function resolveMobileEnv(source: Record<string, string | undefined>): MobileEnvResult {
  try {
    return { ok: true, env: loadMobilePublicEnv(source) };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, issues: error.issues };
    throw error;
  }
}

/**
 * Metro inlines EXPO_PUBLIC_* only for static `process.env.EXPO_PUBLIC_X` member access,
 * so each variable is read explicitly here.
 */
export const mobileEnv: MobileEnvResult = resolveMobileEnv({
  CORD_ENV: process.env.EXPO_PUBLIC_CORD_ENV,
  API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
  LIVEKIT_PUBLIC_URL: process.env.EXPO_PUBLIC_LIVEKIT_PUBLIC_URL,
  RELAY_URL: process.env.EXPO_PUBLIC_RELAY_URL,
  SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
  SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
});
