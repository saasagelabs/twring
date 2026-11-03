import { mobileEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadMobilePublicEnv, mobileAuthConfig, relayUrl } from './mobile';

const SIGN_IN = {
  SUPABASE_URL: 'https://cord-test.supabase.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  GOOGLE_WEB_CLIENT_ID: 'web-client.apps.googleusercontent.com',
};

describe('loadMobilePublicEnv', () => {
  it('accepts a plain-http API in development (emulator host loopback)', () => {
    expect(loadMobilePublicEnv(mobileEnvFixture()).API_BASE_URL).toBe('http://10.0.2.2:8080');
  });

  it('requires API_BASE_URL', () => {
    expect(() => loadMobilePublicEnv(mobileEnvFixture({ API_BASE_URL: undefined }))).toThrow(
      ConfigError,
    );
  });

  it.each(['staging', 'production'])('requires https/wss in %s', (twringEnv) => {
    expect(() =>
      loadMobilePublicEnv(
        mobileEnvFixture({ CORD_ENV: twringEnv, API_BASE_URL: 'http://api.example' }),
      ),
    ).toThrow(/API_BASE_URL: must use https/);
    expect(() =>
      loadMobilePublicEnv(
        mobileEnvFixture({
          CORD_ENV: twringEnv,
          API_BASE_URL: 'https://api.example',
          LIVEKIT_PUBLIC_URL: 'ws://livekit.example',
        }),
      ),
    ).toThrow(/LIVEKIT_PUBLIC_URL: must use wss/);
  });

  it('accepts a secure staging config', () => {
    const env = loadMobilePublicEnv(
      mobileEnvFixture({
        CORD_ENV: 'staging',
        API_BASE_URL: 'https://api.example',
        LIVEKIT_PUBLIC_URL: 'wss://livekit.example',
        ...SIGN_IN,
      }),
    );
    expect(env.CORD_ENV).toBe('staging');
    expect(mobileAuthConfig(env)).toEqual({
      supabaseUrl: SIGN_IN.SUPABASE_URL,
      supabasePublishableKey: SIGN_IN.SUPABASE_PUBLISHABLE_KEY,
      googleWebClientId: SIGN_IN.GOOGLE_WEB_CLIENT_ID,
    });
  });

  it.each(['staging', 'production'])('requires sign-in settings in %s', (twringEnv) => {
    for (const key of Object.keys(SIGN_IN)) {
      expect(() =>
        loadMobilePublicEnv(
          mobileEnvFixture({
            CORD_ENV: twringEnv,
            API_BASE_URL: 'https://api.example',
            ...SIGN_IN,
            [key]: undefined,
          }),
        ),
      ).toThrow(new RegExp(`${key}: is required`));
    }
  });

  it('requires SUPABASE_URL to be the bare project URL', () => {
    expect(() =>
      loadMobilePublicEnv(
        mobileEnvFixture({ ...SIGN_IN, SUPABASE_URL: `${SIGN_IN.SUPABASE_URL}/auth/v1` }),
      ),
    ).toThrow(/SUPABASE_URL: must be the project URL alone/);
    expect(() =>
      loadMobilePublicEnv(
        mobileEnvFixture({ ...SIGN_IN, SUPABASE_URL: `${SIGN_IN.SUPABASE_URL}/` }),
      ),
    ).not.toThrow();
  });

  it('runs without sign-in in development, but not with half of Supabase', () => {
    const env = loadMobilePublicEnv(mobileEnvFixture());
    expect(mobileAuthConfig(env)).toBeUndefined();
    // Supabase set but no Google client yet: still signed out (dev gateway).
    const partial = loadMobilePublicEnv(
      mobileEnvFixture({ ...SIGN_IN, GOOGLE_WEB_CLIENT_ID: undefined }),
    );
    expect(mobileAuthConfig(partial)).toBeUndefined();
    expect(() =>
      loadMobilePublicEnv(mobileEnvFixture({ SUPABASE_URL: SIGN_IN.SUPABASE_URL })),
    ).toThrow(/SUPABASE_PUBLISHABLE_KEY: is required with the other/);
  });
});

describe('RELAY_URL', () => {
  it('defaults to the production relay', () => {
    const env = loadMobilePublicEnv(mobileEnvFixture());
    expect(env.RELAY_URL).toBeUndefined();
    expect(relayUrl(env)).toBe('https://relay.twring.com');
  });

  it('accepts a staging override', () => {
    const env = loadMobilePublicEnv(
      mobileEnvFixture({ RELAY_URL: 'https://relay.staging.example' }),
    );
    expect(relayUrl(env)).toBe('https://relay.staging.example');
  });

  it('refuses http outside development but allows it in development', () => {
    expect(() =>
      loadMobilePublicEnv(
        mobileEnvFixture({
          CORD_ENV: 'staging',
          API_BASE_URL: 'https://api.example',
          RELAY_URL: 'http://relay.example',
          ...SIGN_IN,
        }),
      ),
    ).toThrow(/RELAY_URL: must use https/);
    expect(
      relayUrl(loadMobilePublicEnv(mobileEnvFixture({ RELAY_URL: 'http://10.0.2.2:9000' }))),
    ).toBe('http://10.0.2.2:9000');
  });

  it('is not overridable in production', () => {
    const prod = { CORD_ENV: 'production', API_BASE_URL: 'https://api.example', ...SIGN_IN };
    expect(() =>
      loadMobilePublicEnv(mobileEnvFixture({ ...prod, RELAY_URL: 'https://relay.other.example' })),
    ).toThrow(/RELAY_URL: cannot be overridden/);
    expect(
      relayUrl(
        loadMobilePublicEnv(mobileEnvFixture({ ...prod, RELAY_URL: 'https://relay.twring.com' })),
      ),
    ).toBe('https://relay.twring.com');
  });
});
