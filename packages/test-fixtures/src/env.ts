/**
 * Deterministic environment inputs for tests. Values are obviously fake and point at
 * reserved `.invalid` / `.example` hosts so a misconfigured test can never reach a real service.
 */
export type EnvFixture = Record<string, string | undefined>;

/** A fake 32-byte credentials key (base64). Never a real key. */
export const FAKE_CREDENTIALS_KEY = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

/**
 * A fake key that passes production's weak-key check (random-looking bytes). Test-only: it is
 * published here, so it protects nothing.
 */
export const FAKE_PRODUCTION_CREDENTIALS_KEY = 'gTmc8iH5BIEkm28IJR67ghCGXbPFOV9zicKE0Y/mcGw=';

let makeDataDir: (() => string) | undefined;

/**
 * Gives every later `gatewayEnvFixture` a data folder of its own unless the test names one. The
 * gateway's vitest setup calls this, so no test writes the real `./data`: test files run in
 * parallel, and Windows refuses to rename a temp file over one another process has open.
 */
export function useGatewayDataDirs(make: () => string): void {
  makeDataDir = make;
}

export function gatewayEnvFixture(overrides: EnvFixture = {}): EnvFixture {
  const deployed = overrides.CORD_ENV !== undefined && overrides.CORD_ENV !== 'development';
  return {
    // Required outside development; tests of other settings should not have to repeat them.
    ...(deployed && {
      CORD_DATA_DIR: '/var/lib/cord-test',
      CORD_CREDENTIALS_KEY:
        overrides.CORD_ENV === 'production'
          ? FAKE_PRODUCTION_CREDENTIALS_KEY
          : FAKE_CREDENTIALS_KEY,
      AUTH_MODE: 'supabase',
      SUPABASE_URL: 'https://cord-test.supabase.invalid',
    }),
    ...(makeDataDir && { CORD_DATA_DIR: makeDataDir() }),
    CORD_ENV: 'development',
    CORD_RELEASE: 'test-release',
    HOST: '127.0.0.1',
    PORT: '0',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export function mobileEnvFixture(overrides: EnvFixture = {}): EnvFixture {
  return {
    CORD_ENV: 'development',
    API_BASE_URL: 'http://10.0.2.2:8080',
    ...overrides,
  };
}

export const FAKE_SENTRY_DSN = 'https://publickey@o0.ingest.sentry.invalid/0';
