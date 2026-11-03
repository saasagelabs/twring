import { FAKE_CREDENTIALS_KEY, FAKE_SENTRY_DSN, gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { ConfigError, isWeakCredentialsKey, loadGatewayEnv } from './gateway';

// Milestone 10: a production gateway fails fast on development settings and missing secrets.

const PRODUCTION = {
  CORD_ENV: 'production',
  SENTRY_DSN: FAKE_SENTRY_DSN,
  LIVEKIT_URL: 'wss://cord-test.livekit.invalid',
  LIVEKIT_API_KEY: 'APIfake',
  LIVEKIT_API_SECRET: 'fake-secret-value-for-tests',
  DEEPGRAM_API_KEY: 'fake-deepgram-key-for-tests',
  AUTH_MODE: 'supabase',
  SUPABASE_URL: 'https://cord-test.supabase.invalid',
};

function issuesFor(overrides: Record<string, string | undefined>): readonly string[] {
  try {
    loadGatewayEnv(gatewayEnvFixture({ ...PRODUCTION, ...overrides }));
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
}

describe('production environment', () => {
  it('accepts a complete production configuration', () => {
    expect(issuesFor({})).toEqual([]);
    expect(loadGatewayEnv(gatewayEnvFixture(PRODUCTION)).CORD_ENV).toBe('production');
  });

  it.each([
    'LIVEKIT_URL',
    'DEEPGRAM_API_KEY',
    'SENTRY_DSN',
    'CORD_DATA_DIR',
    'CORD_CREDENTIALS_KEY',
  ])('fails without %s', (key) => {
    expect(issuesFor({ [key]: undefined }).some((issue) => issue.startsWith(`${key}:`))).toBe(true);
  });

  it.each(['production', 'staging'])(
    'requires AUTH_MODE=supabase when CORD_ENV=%s',
    (twringEnv) => {
      expect(issuesFor({ CORD_ENV: twringEnv, AUTH_MODE: undefined })).toContain(
        `AUTH_MODE: must be supabase when CORD_ENV=${twringEnv}`,
      );
      expect(issuesFor({ CORD_ENV: twringEnv, AUTH_MODE: 'dev' })).toContain(
        `AUTH_MODE: must be supabase when CORD_ENV=${twringEnv}`,
      );
    },
  );

  it('requires an https SUPABASE_URL with AUTH_MODE=supabase', () => {
    expect(issuesFor({ SUPABASE_URL: undefined })).toContain(
      'SUPABASE_URL: is required when AUTH_MODE=supabase',
    );
    expect(issuesFor({ SUPABASE_URL: 'http://cord-test.supabase.invalid' })).toContain(
      'SUPABASE_URL: must use https:// when CORD_ENV=production',
    );
  });

  it('requires SUPABASE_URL to be the bare project URL (the issuer is derived from it)', () => {
    for (const url of [
      'https://cord-test.supabase.invalid/auth/v1',
      'https://cord-test.supabase.invalid/rest',
      'https://cord-test.supabase.invalid?x=1',
      'https://cord-test.supabase.invalid#frag',
    ]) {
      expect(issuesFor({ SUPABASE_URL: url }), url).toContain(
        'SUPABASE_URL: must be the project URL alone, like https://<ref>.supabase.co',
      );
    }
    expect(issuesFor({ SUPABASE_URL: 'https://cord-test.supabase.invalid/' })).toEqual([]);
  });

  it('defaults AUTH_MODE to dev only in development', () => {
    expect(loadGatewayEnv(gatewayEnvFixture({})).AUTH_MODE).toBe('dev');
    expect(loadGatewayEnv(gatewayEnvFixture(PRODUCTION)).AUTH_MODE).toBe('supabase');
  });

  it('requires TLS endpoints', () => {
    expect(issuesFor({ LIVEKIT_URL: 'ws://cord-test.livekit.invalid' })).toContain(
      'LIVEKIT_URL: must use wss:// when CORD_ENV=production',
    );
    expect(issuesFor({ SENTRY_DSN: 'http://key@o0.ingest.sentry.invalid/0' })).toContain(
      'SENTRY_DSN: must use https:// when CORD_ENV=production',
    );
  });

  it.each([
    ['GATEWAY_AUDIO_TEST_MODE', 'echo'],
    ['AGENT_NATIVE_URL', 'wss://agent.example.com/cord'],
    ['AGENT_REST_URL', 'https://agent.example.com/cord'],
  ])('refuses the development setting %s', (key, value) => {
    expect(issuesFor({ [key]: value }).some((issue) => issue.startsWith(`${key}:`))).toBe(true);
  });

  it('refuses debug audio capture', () => {
    expect(issuesFor({ DEBUG_AUDIO_CAPTURE_DIR: '/tmp/audio' })[0]).toMatch(
      /^DEBUG_AUDIO_CAPTURE_DIR:/,
    );
  });

  it('refuses TRUST_PROXY=true but accepts listed proxy addresses', () => {
    expect(issuesFor({ TRUST_PROXY: 'true' })[0]).toMatch(/^TRUST_PROXY: must list the proxy/);
    const env = loadGatewayEnv(
      gatewayEnvFixture({ ...PRODUCTION, TRUST_PROXY: '127.0.0.1, 10.0.0.0/8' }),
    );
    expect(env.TRUST_PROXY).toEqual(['127.0.0.1', '10.0.0.0/8']);
    expect(issuesFor({ TRUST_PROXY: 'everyone' })[0]).toMatch(/^TRUST_PROXY:/);
  });

  it('still lets staging trust its proxy with true', () => {
    const env = loadGatewayEnv(
      gatewayEnvFixture({ ...PRODUCTION, CORD_ENV: 'staging', TRUST_PROXY: 'true' }),
    );
    expect(env.TRUST_PROXY).toBe(true);
  });

  it('refuses a published or non-random credentials key', () => {
    expect(issuesFor({ CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY })[0]).toMatch(
      /^CORD_CREDENTIALS_KEY: is a published or non-random key/,
    );
    const zeros = `${'A'.repeat(43)}=`; // 32 zero bytes
    expect(issuesFor({ CORD_CREDENTIALS_KEY: zeros })[0]).toMatch(/^CORD_CREDENTIALS_KEY:/);
    expect(isWeakCredentialsKey(zeros)).toBe(true);
    expect(isWeakCredentialsKey('gTmc8iH5BIEkm28IJR67ghCGXbPFOV9zicKE0Y/mcGw=')).toBe(false);
  });

  it('fails when NODE_ENV=production runs with development CORD_ENV', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ NODE_ENV: 'production' }))).toThrow(
      /CORD_ENV: must be staging or production when NODE_ENV=production/,
    );
    expect(issuesFor({ NODE_ENV: 'production' })).toEqual([]);
  });

  it('never echoes a refused value', () => {
    const issues = issuesFor({ CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY }).join('\n');
    expect(issues).not.toContain(FAKE_CREDENTIALS_KEY);
  });
});

describe('production environment edges (verifier)', () => {
  it.each(['AGENT_NATIVE_TOKEN', 'AGENT_REST_TOKEN'])('refuses the development %s', (key) => {
    expect(issuesFor({ [key]: 'fake-dev-token' }).some((i) => i.startsWith(`${key}:`))).toBe(true);
  });

  it.each([
    '999.1.1.1', // not an address: the server would only crash when it builds the app
    '10.0.0.0/33',
    '::1/129',
    '...',
    ':',
    '127.0.0.1,',
    '10.0.0.1/',
  ])('refuses the TRUST_PROXY entry %s at config time', (value) => {
    expect(issuesFor({ TRUST_PROXY: value })[0]).toMatch(/^TRUST_PROXY:/);
  });

  it.each([
    ['127.0.0.1', ['127.0.0.1']],
    [' 10.0.0.0/8 , 172.16.0.0/12 ', ['10.0.0.0/8', '172.16.0.0/12']],
    ['::1,fd00::/8', ['::1', 'fd00::/8']],
    ['0.0.0.0/0', ['0.0.0.0/0']],
  ])('accepts the TRUST_PROXY list %s', (value, expected) => {
    expect(
      loadGatewayEnv(gatewayEnvFixture({ ...PRODUCTION, TRUST_PROXY: value })).TRUST_PROXY,
    ).toEqual(expected);
  });

  it('TRUST_PROXY false, 0, or unset trusts nobody', () => {
    for (const value of ['false', '0', undefined]) {
      expect(
        loadGatewayEnv(gatewayEnvFixture({ ...PRODUCTION, TRUST_PROXY: value })).TRUST_PROXY,
      ).toBe(false);
    }
  });

  it('does not require CARTESIA_API_KEY, accepts it when present, and ignores it when blank', () => {
    expect(issuesFor({ CARTESIA_API_KEY: undefined })).toEqual([]);
    expect(issuesFor({ CARTESIA_API_KEY: 'fake-cartesia-key' })).toEqual([]);
    expect(issuesFor({ CARTESIA_API_KEY: '' })).toEqual([]);
    expect(issuesFor({ CARTESIA_API_KEY: '   ' })).toEqual([]);
    expect(issuesFor({ CARTESIA_TTS_MODEL: 'sonic-3.6' })).toEqual([]);
    expect(issuesFor({ CARTESIA_TTS_MODEL: 'sonic 3' })[0]).toMatch(/^CARTESIA_TTS_MODEL:/);
    expect(issuesFor({ CARTESIA_TTS_SPEED: '0.85' })).toEqual([]);
    expect(issuesFor({ CARTESIA_TTS_SPEED: '0.5' })[0]).toMatch(/^CARTESIA_TTS_SPEED:/);
    expect(issuesFor({ CARTESIA_TTS_SPEED: '1.6' })[0]).toMatch(/^CARTESIA_TTS_SPEED:/);
  });

  it('collects every production problem in one report', () => {
    const issues = issuesFor({
      SENTRY_DSN: undefined,
      TRUST_PROXY: 'true',
      GATEWAY_AUDIO_TEST_MODE: 'echo',
      CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
    });
    expect(issues.map((i) => i.split(':')[0]).sort()).toEqual([
      'CORD_CREDENTIALS_KEY',
      'GATEWAY_AUDIO_TEST_MODE',
      'SENTRY_DSN',
      'TRUST_PROXY',
    ]);
  });
});
