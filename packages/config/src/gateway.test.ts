import { FAKE_CREDENTIALS_KEY, FAKE_SENTRY_DSN, gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import {
  INTERRUPTION_KEYTERMS,
  identityKeyterms,
  MAX_STT_KEYTERM_TOKENS,
  MAX_STT_KEYTERMS,
  agentSttKeyterms,
  ConfigError,
  estimateKeytermTokens,
  mergeSttKeyterms,
  credentialKeys,
  deepgramConfig,
  liveKitConfig,
  loadGatewayEnv,
  nativeAgentConfig,
  restAgentConfig,
} from './gateway';

const DEEPGRAM = { DEEPGRAM_API_KEY: 'fake-deepgram-key-for-tests' };

const LIVEKIT = {
  LIVEKIT_URL: 'wss://cord-test.livekit.invalid',
  LIVEKIT_API_KEY: 'APIfake',
  LIVEKIT_API_SECRET: 'fake-secret-value-for-tests',
};

describe('loadGatewayEnv', () => {
  it('keeps the MCP connector off by default and requires Supabase plus a public URL', () => {
    expect(loadGatewayEnv(gatewayEnvFixture()).CONNECTOR_MCP_ENABLED).toBe(false);
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CONNECTOR_MCP_ENABLED: 'true' }))).toThrow(
      /CONNECTOR_MCP_ENABLED/,
    );
    expect(
      loadGatewayEnv(
        gatewayEnvFixture({
          CONNECTOR_MCP_ENABLED: 'true',
          AUTH_MODE: 'supabase',
          SUPABASE_URL: 'https://project.supabase.co',
          CORD_PUBLIC_URL: 'https://api.twring.com',
        }),
      ).CONNECTOR_MCP_ENABLED,
    ).toBe(true);
  });
  it('requires threads for files and a secure public URL outside development', () => {
    expect(() => loadGatewayEnv({ FILES_ENABLED: 'true' })).toThrow(
      /FILES_ENABLED: requires THREADS_ENABLED=true/,
    );
    expect(
      loadGatewayEnv({ FILES_ENABLED: 'true', THREADS_ENABLED: 'true', PORT: '9001' })
        .CORD_PUBLIC_URL,
    ).toBe('http://localhost:9001');
    const staging = gatewayEnvFixture({
      CORD_ENV: 'staging',
      ...LIVEKIT,
      ...DEEPGRAM,
      THREADS_ENABLED: 'true',
      FILES_ENABLED: 'true',
    });
    expect(() => loadGatewayEnv(staging)).toThrow(/CORD_PUBLIC_URL: is required/);
    expect(() => loadGatewayEnv({ ...staging, CORD_PUBLIC_URL: 'http://example.com' })).toThrow(
      /CORD_PUBLIC_URL: must use https/,
    );
    expect(
      loadGatewayEnv({ ...staging, CORD_PUBLIC_URL: 'https://example.com/' }).CORD_PUBLIC_URL,
    ).toBe('https://example.com');
  });
  it('accepts owner notification settings and treats blanks as unset', () => {
    const values = {
      RESEND_API_KEY: 'test-key',
      WAITLIST_NOTIFY_TO: 'support@twring.com',
      WAITLIST_NOTIFY_FROM: 'Twring alerts <alerts@saasage.in>',
    };
    expect(loadGatewayEnv(values)).toMatchObject(values);
    const blank = loadGatewayEnv({
      RESEND_API_KEY: ' ',
      WAITLIST_NOTIFY_TO: '',
      WAITLIST_NOTIFY_FROM: '',
    });
    expect(blank.RESEND_API_KEY).toBeUndefined();
    expect(blank.WAITLIST_NOTIFY_TO).toBeUndefined();
    expect(blank.WAITLIST_NOTIFY_FROM).toBeUndefined();
    expect(loadGatewayEnv({ RESEND_API_KEY: 'test-key' }).RESEND_API_KEY).toBe('test-key');
  });
  it('accepts an optional beta members file path and treats an empty value as unset', () => {
    expect(loadGatewayEnv({}).BETA_MEMBERS_FILE).toBeUndefined();
    expect(loadGatewayEnv({ BETA_MEMBERS_FILE: '' }).BETA_MEMBERS_FILE).toBeUndefined();
    expect(
      loadGatewayEnv({ BETA_MEMBERS_FILE: '/var/lib/cord/beta-members.json' }).BETA_MEMBERS_FILE,
    ).toBe('/var/lib/cord/beta-members.json');
  });
  it('takes an optional https link for the operator and refuses anything else', () => {
    expect(loadGatewayEnv({}).CORD_OPERATOR_URL).toBeUndefined();
    expect(loadGatewayEnv({ CORD_OPERATOR_URL: '' }).CORD_OPERATOR_URL).toBeUndefined();
    expect(loadGatewayEnv({ CORD_OPERATOR_URL: 'https://x.com/rishflips' }).CORD_OPERATOR_URL).toBe(
      'https://x.com/rishflips',
    );
    for (const url of ['http://x.com/rishflips', 'javascript:alert(1)', 'x.com/rishflips']) {
      expect(() => loadGatewayEnv({ CORD_OPERATOR_URL: url }), url).toThrow(/CORD_OPERATOR_URL/);
    }
  });
  it('takes a service-wide daily cap and an owner alert address', () => {
    const env = loadGatewayEnv({
      SERVICE_DAILY_CALL_SECONDS: '180000',
      OWNER_ALERT_TO: 'owner@example.com',
      RESEND_API_KEY: 'test-key',
      WAITLIST_NOTIFY_FROM: 'Twring <alerts@example.com>',
    });
    expect(env).toMatchObject({
      SERVICE_DAILY_CALL_SECONDS: 180000,
      OWNER_ALERT_TO: 'owner@example.com',
    });
    expect(() => loadGatewayEnv({ SERVICE_DAILY_CALL_SECONDS: '-1' })).toThrow(
      /SERVICE_DAILY_CALL_SECONDS/,
    );
    expect(() => loadGatewayEnv({ OWNER_ALERT_TO: 'not an email' })).toThrow(/OWNER_ALERT_TO/);
  });

  it('refuses an owner alert address that could never send (no Resend settings)', () => {
    expect(() => loadGatewayEnv({ OWNER_ALERT_TO: 'alerts@example.com' })).toThrow(
      /OWNER_ALERT_TO: needs RESEND_API_KEY and WAITLIST_NOTIFY_FROM/,
    );
    expect(
      loadGatewayEnv({
        OWNER_ALERT_TO: 'alerts@example.com',
        RESEND_API_KEY: 'test-key',
        WAITLIST_NOTIFY_FROM: 'Twring <alerts@example.com>',
      }).OWNER_ALERT_TO,
    ).toBe('alerts@example.com');
  });

  it('needs both ids with a Sign in with Apple key file', () => {
    const file = { APPLE_SIGNIN_KEY_FILE: '/etc/cord/apple-signin-key.p8' };
    expect(() => loadGatewayEnv(file)).toThrow(
      /needs APPLE_SIGNIN_KEY_ID and APPLE_SIGNIN_TEAM_ID/,
    );
    expect(() =>
      loadGatewayEnv({ ...file, APPLE_SIGNIN_KEY_ID: 'abc', APPLE_SIGNIN_TEAM_ID: 'ZMVQWM9XL2' }),
    ).toThrow(/APPLE_SIGNIN_KEY_ID/);
    expect(
      loadGatewayEnv({
        ...file,
        APPLE_SIGNIN_KEY_ID: '3J6W7994X5',
        APPLE_SIGNIN_TEAM_ID: 'ZMVQWM9XL2',
      }),
    ).toMatchObject({
      APPLE_SIGNIN_KEY_ID: '3J6W7994X5',
      APPLE_SIGNIN_CLIENT_ID: 'com.twring.app',
    });
  });
  it('applies defaults for an empty environment', () => {
    const env = loadGatewayEnv({});
    expect(env).toEqual({
      CORD_ENV: 'development',
      CORD_RELEASE: 'dev',
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      TWRING_MODE: 'hosted',
      TWRING_RELAY_URL: 'https://relay.twring.com',
      TWRING_SPACE_ID: 'default',
      WAITLIST_ALLOWED_ORIGINS: ['https://twring.com', 'https://www.twring.com'],
      AUTH_MODE: 'dev',
      CALLS_ENABLED: true,
      CALL_MAX_CONCURRENT: 4,
      CALL_MAX_DURATION_S: 1800,
      CALL_TOKEN_TTL_S: 600,
      CALL_CREATE_RATE_PER_MINUTE: 10,
      AGENT_TURN_MAX_S: 600,
      PRESENCE_CUES: 'on',
      PRESENCE_ACK: 'on',
      SHORT_TURN_HOLD_MS: 800,
      AGENT_TESTS_ENABLED: true,
      VOICE_SAMPLES_ENABLED: true,
      AGENT_WRITE_RATE_PER_MINUTE: 30,
      AGENT_TEST_RATE_PER_MINUTE: 6,
      API_READ_RATE_PER_MINUTE: 120,
      VOICE_SAMPLE_RATE_PER_MINUTE: 20,
      DATA_DELETE_RATE_PER_MINUTE: 3,
      DAILY_CALL_SECONDS_PER_USER: 3600,
      DAILY_CALLS_PER_USER: 50,
      CORD_OPERATOR_NAME: '[OPERATOR NAME]',
      CORD_SUPPORT_EMAIL: 'support@twring.com',
      CONNECTOR_CLAIM_RATE_PER_MINUTE: 10,
      CONNECTOR_MCP_ENABLED: false,
      CONNECTOR_SOCKET_RATE_PER_MINUTE: 30,
      PHONE_SOCKET_RATE_PER_MINUTE: 20,
      THREADS_ENABLED: false,
      FILES_ENABLED: false,
      SPEECH_KEYS_ENABLED: false,
      SPEECH_KEY_WRITE_RATE_PER_MINUTE: 5,
      CORD_PUBLIC_URL: 'http://localhost:8080',
      THREAD_WRITE_RATE_PER_MINUTE: 30,
      THREAD_READ_RATE_PER_MINUTE: 120,
      THREAD_MESSAGES_PER_DAY: 500,
      CORD_RATE_STT_PER_MIN: 0,
      CORD_RATE_TTS_PER_1K_CHARS: 0,
      CORD_RATE_ROOM_PER_MIN: 0,
      GATEWAY_AUDIO_TEST_MODE: 'echo',
      DEEPGRAM_STT_MODEL: 'flux-general-en',
      DEEPGRAM_TTS_MODEL: 'flux-haley-en',
      CARTESIA_TTS_MODEL: 'sonic-3.6',
      CARTESIA_TTS_SPEED: 1,
      XAI_STT_ENDPOINTING_MS: 400,
      APNS_BUNDLE_ID: 'com.twring.app',
      APNS_ENV: 'production',
      APPLE_SIGNIN_CLIENT_ID: 'com.twring.app',
      SERVICE_DAILY_CALL_SECONDS: 0,
      AUTO_ADMIT_PER_DAY: 0,
      CORD_DATA_DIR: './data',
      CORD_CREDENTIALS_KEY_VERSION: 1,
    });
  });

  it('leaves the xAI voice latency setting to xAI unless set, and bounds it', () => {
    expect(loadGatewayEnv({}).XAI_TTS_OPTIMIZE_LATENCY).toBeUndefined();
    expect(loadGatewayEnv({ XAI_TTS_OPTIMIZE_LATENCY: '0' }).XAI_TTS_OPTIMIZE_LATENCY).toBe(0);
    expect(loadGatewayEnv({ XAI_TTS_OPTIMIZE_LATENCY: '2' }).XAI_TTS_OPTIMIZE_LATENCY).toBe(2);
    expect(() => loadGatewayEnv({ XAI_TTS_OPTIMIZE_LATENCY: '3' })).toThrow();
    expect(() => loadGatewayEnv({ XAI_TTS_OPTIMIZE_LATENCY: '1.5' })).toThrow();
  });

  it('defaults xAI listening settings and bounds them', () => {
    const env = loadGatewayEnv({});
    expect(env.XAI_STT_ENDPOINTING_MS).toBe(400);
    expect(env.XAI_STT_SMART_TURN).toBeUndefined();
    expect(env.XAI_STT_SMART_TURN_TIMEOUT_MS).toBeUndefined();
    expect(loadGatewayEnv({ XAI_STT_ENDPOINTING_MS: '0' }).XAI_STT_ENDPOINTING_MS).toBe(0);
    expect(() => loadGatewayEnv({ XAI_STT_ENDPOINTING_MS: '5001' })).toThrow();
    expect(loadGatewayEnv({ XAI_STT_SMART_TURN: '0.5' }).XAI_STT_SMART_TURN).toBe(0.5);
    expect(() => loadGatewayEnv({ XAI_STT_SMART_TURN: '1.5' })).toThrow();
    expect(
      loadGatewayEnv({ XAI_STT_SMART_TURN_TIMEOUT_MS: '1' }).XAI_STT_SMART_TURN_TIMEOUT_MS,
    ).toBe(1);
    expect(() => loadGatewayEnv({ XAI_STT_SMART_TURN_TIMEOUT_MS: '0' })).toThrow();
    expect(() => loadGatewayEnv({ XAI_STT_SMART_TURN_TIMEOUT_MS: '5001' })).toThrow();
  });

  it('turns speech keys on from the environment', () => {
    expect(loadGatewayEnv({ SPEECH_KEYS_ENABLED: 'true' }).SPEECH_KEYS_ENABLED).toBe(true);
  });

  it('requires Supabase auth and a public URL for the MCP connector', () => {
    expect(() => loadGatewayEnv({ CONNECTOR_MCP_ENABLED: 'true' })).toThrow();
    expect(() =>
      loadGatewayEnv({
        CONNECTOR_MCP_ENABLED: 'true',
        AUTH_MODE: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
      }),
    ).toThrow();
    expect(
      loadGatewayEnv({
        CONNECTOR_MCP_ENABLED: 'true',
        AUTH_MODE: 'supabase',
        SUPABASE_URL: 'https://example.supabase.co',
        CORD_PUBLIC_URL: 'https://api.twring.com',
      }).CONNECTOR_MCP_ENABLED,
    ).toBe(true);
  });

  it('parses thread settings and optional database path', () => {
    const env = loadGatewayEnv({
      THREADS_ENABLED: '1',
      CORD_THREADS_DB: '/tmp/chat.db',
      THREAD_WRITE_RATE_PER_MINUTE: '4',
      THREAD_READ_RATE_PER_MINUTE: '9',
      THREAD_MESSAGES_PER_DAY: '12',
      PHONE_SOCKET_RATE_PER_MINUTE: '7',
    });
    expect([
      env.PHONE_SOCKET_RATE_PER_MINUTE,
      env.THREADS_ENABLED,
      env.CORD_THREADS_DB,
      env.THREAD_WRITE_RATE_PER_MINUTE,
      env.THREAD_READ_RATE_PER_MINUTE,
      env.THREAD_MESSAGES_PER_DAY,
    ]).toEqual([7, true, '/tmp/chat.db', 4, 9, 12]);
    expect(() => loadGatewayEnv({ THREAD_MESSAGES_PER_DAY: '0' })).toThrow(ConfigError);
  });

  it('coerces PORT and treats empty strings as unset', () => {
    const env = loadGatewayEnv(gatewayEnvFixture({ PORT: '9000', SENTRY_DSN: '' }));
    expect(env.PORT).toBe(9000);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('accepts exact HTTPS origins and development localhost with a port', () => {
    const env = loadGatewayEnv(
      gatewayEnvFixture({ WAITLIST_ALLOWED_ORIGINS: 'https://beta.example,http://localhost:3000' }),
    );
    expect(env.WAITLIST_ALLOWED_ORIGINS).toEqual(['https://beta.example', 'http://localhost:3000']);
  });

  it('rejects HTTP outside development and origins with paths', () => {
    expect(() =>
      loadGatewayEnv(
        gatewayEnvFixture({
          CORD_ENV: 'production',
          SENTRY_DSN: FAKE_SENTRY_DSN,
          ...LIVEKIT,
          ...DEEPGRAM,
          WAITLIST_ALLOWED_ORIGINS: 'http://twring.com',
        }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ WAITLIST_ALLOWED_ORIGINS: 'https://twring.com/path' })),
    ).toThrow(ConfigError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ PORT: '70000' }))).toThrow(ConfigError);
  });

  it('requires SENTRY_DSN in production', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'production', ...LIVEKIT }))).toThrow(
      /SENTRY_DSN: is required when CORD_ENV=production/,
    );
    expect(
      loadGatewayEnv(
        gatewayEnvFixture({
          CORD_ENV: 'production',
          SENTRY_DSN: FAKE_SENTRY_DSN,
          ...LIVEKIT,
          ...DEEPGRAM,
        }),
      ).CORD_ENV,
    ).toBe('production');
  });

  it('never echoes variable values in the error', () => {
    const secretLooking = 'not-a-url-fake-secret-value';
    try {
      loadGatewayEnv(gatewayEnvFixture({ SENTRY_DSN: secretLooking }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain(secretLooking);
      expect((error as ConfigError).issues[0]).toMatch(/^SENTRY_DSN:/);
    }
  });

  it('requires LiveKit outside development', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'staging' }))).toThrow(
      /LIVEKIT_URL: is required when CORD_ENV=staging/,
    );
    const env = loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'staging', ...LIVEKIT, ...DEEPGRAM }));
    expect(liveKitConfig(env)).toEqual({
      url: LIVEKIT.LIVEKIT_URL,
      apiKey: LIVEKIT.LIVEKIT_API_KEY,
      apiSecret: LIVEKIT.LIVEKIT_API_SECRET,
    });
  });

  it('allows development without LiveKit', () => {
    expect(liveKitConfig(loadGatewayEnv(gatewayEnvFixture()))).toBeUndefined();
  });

  it('rejects a partial LiveKit configuration without echoing the secret', () => {
    try {
      loadGatewayEnv(gatewayEnvFixture({ LIVEKIT_API_SECRET: LIVEKIT.LIVEKIT_API_SECRET }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { message, issues } = error as ConfigError;
      expect(issues).toEqual([
        'LIVEKIT_URL: is required with the other LIVEKIT_* values',
        'LIVEKIT_API_KEY: is required with the other LIVEKIT_* values',
      ]);
      expect(message).not.toContain(LIVEKIT.LIVEKIT_API_SECRET);
    }
  });

  it('requires wss:// LiveKit outside development but allows ws:// locally', () => {
    const insecure = { ...LIVEKIT, LIVEKIT_URL: 'ws://localhost:7880' };
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'staging', ...insecure }))).toThrow(
      /LIVEKIT_URL: must use wss:\/\/ when CORD_ENV=staging/,
    );
    expect(loadGatewayEnv(gatewayEnvFixture(insecure)).LIVEKIT_URL).toBe('ws://localhost:7880');
  });

  it('parses the kill switch and rejects ambiguous booleans', () => {
    expect(loadGatewayEnv(gatewayEnvFixture({ CALLS_ENABLED: 'false' })).CALLS_ENABLED).toBe(false);
    expect(loadGatewayEnv(gatewayEnvFixture({ CALLS_ENABLED: '1' })).CALLS_ENABLED).toBe(true);
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CALLS_ENABLED: 'yes' }))).toThrow(ConfigError);
  });

  it('turns presence cues on by default and off only on request (ADR-028)', () => {
    expect(loadGatewayEnv(gatewayEnvFixture({})).PRESENCE_CUES).toBe('on');
    expect(loadGatewayEnv(gatewayEnvFixture({ PRESENCE_CUES: 'off' })).PRESENCE_CUES).toBe('off');
    expect(loadGatewayEnv(gatewayEnvFixture({ PRESENCE_CUES: '' })).PRESENCE_CUES).toBe('on');
    expect(() => loadGatewayEnv(gatewayEnvFixture({ PRESENCE_CUES: 'false' }))).toThrow(
      ConfigError,
    );
  });

  it('holds short normal turns for 800 ms by default, allows 0, and rejects over 3000 ms', () => {
    expect(loadGatewayEnv(gatewayEnvFixture({})).SHORT_TURN_HOLD_MS).toBe(800);
    expect(loadGatewayEnv(gatewayEnvFixture({ SHORT_TURN_HOLD_MS: '0' })).SHORT_TURN_HOLD_MS).toBe(
      0,
    );
    expect(() => loadGatewayEnv(gatewayEnvFixture({ SHORT_TURN_HOLD_MS: '3001' }))).toThrow(
      ConfigError,
    );
  });

  it('requires Deepgram outside development and keeps it out of error text', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'staging', ...LIVEKIT }))).toThrow(
      /DEEPGRAM_API_KEY: is required when CORD_ENV=staging/,
    );
    const env = loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM }));
    expect(deepgramConfig(env)).toEqual({
      apiKey: DEEPGRAM.DEEPGRAM_API_KEY,
      sttModel: 'flux-general-en',
      sttLanguageHints: [],
      sttKeyterms: [...INTERRUPTION_KEYTERMS, 'Twring'],
      sttEnvKeyterms: [],
      ttsModel: 'flux-haley-en',
    });
  });

  it('parses Flux end-of-turn settings within their ranges', () => {
    const env = loadGatewayEnv(
      gatewayEnvFixture({
        ...DEEPGRAM,
        DEEPGRAM_STT_EOT_THRESHOLD: '0.85',
        DEEPGRAM_STT_EOT_TIMEOUT_MS: '3000',
      }),
    );
    expect(deepgramConfig(env)).toMatchObject({ sttEotThreshold: 0.85, sttEotTimeoutMs: 3000 });
    for (const bad of ['0.4', '1.1', 'high']) {
      expect(() =>
        loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_EOT_THRESHOLD: bad })),
      ).toThrow(/DEEPGRAM_STT_EOT_THRESHOLD/);
    }
    for (const bad of ['499', '60001', '1000.5']) {
      expect(() =>
        loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_EOT_TIMEOUT_MS: bad })),
      ).toThrow(/DEEPGRAM_STT_EOT_TIMEOUT_MS/);
    }
  });

  it('parses keyterms and bounds their size', () => {
    const env = loadGatewayEnv(
      gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: ' Chennai, Mysore ,,' }),
    );
    expect(deepgramConfig(env)?.sttKeyterms).toEqual([
      'Chennai',
      'Mysore',
      ...INTERRUPTION_KEYTERMS,
      'Twring',
    ]);
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'x'.repeat(51) })),
    ).toThrow(/DEEPGRAM_STT_KEYTERMS/);
  });

  it('appends the interruption keyterms deduped and within the 50-term cap', () => {
    const dup = loadGatewayEnv(
      gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'Stop,Chennai,hold on' }),
    );
    expect(deepgramConfig(dup)?.sttKeyterms).toEqual([
      'Stop',
      'Chennai',
      'hold on',
      'wait',
      'hang on',
      'one second',
      'Twring',
    ]);
    const many = Array.from({ length: 48 }, (_, i) => `term${i}`);
    const full = loadGatewayEnv(
      gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: many.join(',') }),
    );
    expect(deepgramConfig(full)?.sttKeyterms).toEqual([...many, 'wait', 'stop']);
  });

  it('puts a saved agent’s keyterms first, then interruption words, then the env list', () => {
    const config = deepgramConfig(
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'Mysore,chennai' })),
    )!;
    expect(agentSttKeyterms(config, ['Chennai', 'Priya', ' STOP '])).toEqual([
      'Chennai',
      'Priya',
      'STOP',
      'wait',
      'hold on',
      'hang on',
      'one second',
      'Twring',
      'Mysore',
    ]);
  });

  it('caps merged keyterms by count and token budget, keeping earlier lists', () => {
    const many = Array.from({ length: 60 }, (_, i) => `t${i}`);
    const merged = mergeSttKeyterms(many, ['late']);
    expect(merged).toHaveLength(MAX_STT_KEYTERMS);
    expect(merged).not.toContain('late');
    const long = Array.from({ length: 40 }, (_, i) => `${'x'.repeat(48)}${i}`);
    const budgeted = mergeSttKeyterms(long, ['wait']);
    const tokens = budgeted.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
    expect(tokens).toBeLessThanOrEqual(MAX_STT_KEYTERM_TOKENS);
    expect(budgeted[0]).toBe(long[0]);
    expect(budgeted.length).toBeLessThan(40);
  });

  it('lets long agent terms fill the budget but always keeps room for the interruption words', () => {
    const config = deepgramConfig(
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'Mysore' })),
    )!;
    // 40 agent terms at the 50-character limit cost 18 estimated tokens each. The interruption
    // words reserve 19 of the 450 tokens, so 23 agent terms fit.
    const agent = Array.from(
      { length: 40 },
      (_, i) => `${String(i).padStart(2, '0')}${'y'.repeat(48)}`,
    );
    const merged = agentSttKeyterms(config, agent);
    expect(merged).toEqual([...agent.slice(0, 23), ...INTERRUPTION_KEYTERMS, 'Twring', 'Mysore']);
    // A short agent term after an over-budget one still beats the env list for the leftover room.
    const mixed = agentSttKeyterms(config, [...agent.slice(0, 23), 'z'.repeat(54), 'Ooty']);
    expect(mixed).toEqual([
      ...agent.slice(0, 23),
      'Ooty',
      ...INTERRUPTION_KEYTERMS,
      'Twring',
      'Mysore',
    ]);
  });

  it('estimates non-Latin keyterms at about a token per character', () => {
    expect(estimateKeytermTokens('Chennai')).toBe(4);
    expect(estimateKeytermTokens('சென்னை')).toBe(7);
    const tamil = Array.from({ length: 40 }, (_, i) => `${'த'.repeat(48)}${i}`);
    const merged = mergeSttKeyterms(tamil);
    const tokens = merged.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
    expect(tokens).toBeLessThanOrEqual(MAX_STT_KEYTERM_TOKENS);
    expect(merged.length).toBeLessThan(10);
  });

  it('keeps the agent’s spelling when it duplicates an interruption or env term, and drops blanks (m9 verifier)', () => {
    const config = deepgramConfig(
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'Wait,Chennai' })),
    )!;
    expect(agentSttKeyterms(config, ['WAIT', '   ', 'chennai'])).toEqual([
      'WAIT',
      'chennai',
      'stop',
      'hold on',
      'hang on',
      'one second',
      'Twring',
    ]);
    expect(agentSttKeyterms(config, [])).toEqual([
      'wait',
      'stop',
      'hold on',
      'hang on',
      'one second',
      'Twring',
      'Chennai',
    ]);
  });

  it('always listens for Twring and the agent’s name, after the owner’s terms', () => {
    const config = deepgramConfig(loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM })))!;
    expect(identityKeyterms()).toEqual(['Twring']);
    expect(identityKeyterms('  Hermes ')).toEqual(['Twring', 'Hermes']);
    expect(identityKeyterms('Hermes Agent of AI')).toEqual([
      'Twring',
      'Hermes Agent of AI',
      'Hermes',
      'Agent',
    ]);
    expect(agentSttKeyterms(config, ['Priya', 'twring'], 'Hermes')).toEqual([
      'Priya',
      'twring',
      ...INTERRUPTION_KEYTERMS,
      'Hermes',
    ]);
    // Duplicates collapse case-insensitively: a one-word name is not added twice.
    expect(agentSttKeyterms(config, [], 'Gemini CLI Bot')).toEqual([
      ...INTERRUPTION_KEYTERMS,
      'Twring',
      'Gemini CLI Bot',
      'Gemini',
      'CLI',
      'Bot',
    ]);
    // The owner's terms win the budget: identity terms are dropped first.
    const full = Array.from({ length: 45 }, (_, i) => `term${i}`);
    const merged = agentSttKeyterms(config, full, 'Hermes');
    expect(merged.slice(0, 45)).toEqual(full);
    expect(merged).toHaveLength(MAX_STT_KEYTERMS);
    expect(merged).not.toContain('Hermes');
    // Non-ASCII names count as tokens and still respect the budget.
    const tamilName = 'த'.repeat(40);
    const long = Array.from(
      { length: 23 },
      (_, i) => `${String(i).padStart(2, '0')}${'y'.repeat(48)}`,
    );
    const budgeted = agentSttKeyterms(config, long, tamilName);
    const tokens = budgeted.reduce((sum, term) => sum + estimateKeytermTokens(term), 0);
    expect(tokens).toBeLessThanOrEqual(MAX_STT_KEYTERM_TOKENS);
    expect(budgeted).not.toContain(tamilName);
    expect(budgeted).toContain('Twring');
    expect(identityKeyterms('Al Bo')).toEqual(['Twring', 'Al Bo']);
    expect(identityKeyterms('த்து AB')).toEqual(['Twring', 'த்து AB', 'த்து']);
  });

  it('identity keyterms: duplicates, long non-ASCII names, and the owner’s terms first (verifier)', () => {
    const config = deepgramConfig(
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_KEYTERMS: 'Chennai' })),
    )!;
    // "Cord"/"Twring"/"cord" collapse to one, keeping the earliest spelling.
    expect(agentSttKeyterms(config, [], 'Twring')).toEqual([
      ...INTERRUPTION_KEYTERMS,
      'Twring',
      'Chennai',
    ]);
    expect(agentSttKeyterms(config, ['twring'], 'Twring Bot')).toEqual([
      'twring',
      ...INTERRUPTION_KEYTERMS,
      'Twring Bot',
      'Bot',
      'Chennai',
    ]);
    // A name made only of stop words adds nothing new.
    expect(agentSttKeyterms(config, [], 'Stop')).toEqual([
      ...INTERRUPTION_KEYTERMS,
      'Twring',
      'Chennai',
    ]);
    // Long Tamil and Hindi names (up to the 60-character name cap) against a full owner list:
    // every owner term that fits is kept, the budget holds, and identity terms give way first.
    const owner = Array.from({ length: 40 }, (_, i) => `ஊர்${i}${'அ'.repeat(8)}`);
    for (const name of [
      'முத்துக்கிருஷ்ணன் '.repeat(3).trim(),
      'राजेश्वरी देवी '.repeat(4).trim(),
    ]) {
      const terms = agentSttKeyterms(config, owner, name);
      const ownerKept = owner.filter((t) => terms.includes(t));
      expect(terms.slice(0, ownerKept.length)).toEqual(ownerKept);
      expect(ownerKept).toEqual(owner.slice(0, ownerKept.length));
      expect(terms).toEqual(expect.arrayContaining([...INTERRUPTION_KEYTERMS]));
      const tokens = terms.reduce((sum, t) => sum + estimateKeytermTokens(t), 0);
      expect(tokens).toBeLessThanOrEqual(MAX_STT_KEYTERM_TOKENS);
      expect(terms.length).toBeLessThanOrEqual(MAX_STT_KEYTERMS);
      // Nothing after the owner's list outranks an owner term that was dropped.
      if (ownerKept.length < owner.length) expect(terms).not.toContain(name);
    }
    // Without owner terms a long Hindi name fits, word by word too.
    const hindi = 'राजेश्वरी देवी';
    expect(agentSttKeyterms(config, [], hindi)).toEqual([
      ...INTERRUPTION_KEYTERMS,
      'Twring',
      hindi,
      'राजेश्वरी',
      'देवी',
      'Chennai',
    ]);
  });

  it('BUG: an agent name over the 50-character keyterm cap is not sent as one keyterm', () => {
    // Agent names may be 60 characters; every other keyterm path caps a term at 50.
    const name = `${'Bartholomew '.repeat(4)}Archibald Al`;
    expect(name.length).toBeGreaterThan(50);
    expect(name.length).toBeLessThanOrEqual(60);
    const terms = identityKeyterms(name);
    expect(terms.every((t) => t.length <= 50)).toBe(true);
    expect(new Set(terms)).toEqual(new Set(['Twring', 'Bartholomew', 'Archibald']));
  });

  it('accepts language hints only for the multilingual Flux model', () => {
    const multi = { ...DEEPGRAM, DEEPGRAM_STT_MODEL: 'flux-general-multi' };
    expect(
      deepgramConfig(
        loadGatewayEnv(gatewayEnvFixture({ ...multi, DEEPGRAM_STT_LANGUAGE_HINTS: 'en,hi' })),
      )?.sttLanguageHints,
    ).toEqual(['en', 'hi']);
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_STT_LANGUAGE_HINTS: 'en' })),
    ).toThrow(/DEEPGRAM_STT_LANGUAGE_HINTS: needs DEEPGRAM_STT_MODEL=flux-general-multi/);
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...multi, DEEPGRAM_STT_LANGUAGE_HINTS: 'english' })),
    ).toThrow(/DEEPGRAM_STT_LANGUAGE_HINTS/);
  });

  it('refuses audio capture outside development', () => {
    expect(
      loadGatewayEnv(gatewayEnvFixture({ DEBUG_AUDIO_CAPTURE_DIR: 'C:/tmp/cap' }))
        .DEBUG_AUDIO_CAPTURE_DIR,
    ).toBe('C:/tmp/cap');
    expect(() =>
      loadGatewayEnv(
        gatewayEnvFixture({
          CORD_ENV: 'staging',
          ...LIVEKIT,
          ...DEEPGRAM,
          DEBUG_AUDIO_CAPTURE_DIR: 'x',
        }),
      ),
    ).toThrow(/DEBUG_AUDIO_CAPTURE_DIR: is only allowed when CORD_ENV=development/);
  });

  it('defaults to the built-in agent with Deepgram and echo without it', () => {
    expect(loadGatewayEnv(gatewayEnvFixture()).GATEWAY_AUDIO_TEST_MODE).toBe('echo');
    expect(loadGatewayEnv(gatewayEnvFixture(DEEPGRAM)).GATEWAY_AUDIO_TEST_MODE).toBe('agent');
    expect(() => loadGatewayEnv(gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'agent' }))).toThrow(
      /GATEWAY_AUDIO_TEST_MODE: agent needs DEEPGRAM_API_KEY/,
    );
    expect(
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, GATEWAY_AUDIO_TEST_MODE: 'tone' }))
        .GATEWAY_AUDIO_TEST_MODE,
    ).toBe('tone');
    expect(() => loadGatewayEnv(gatewayEnvFixture({ GATEWAY_AUDIO_TEST_MODE: 'repeat' }))).toThrow(
      /GATEWAY_AUDIO_TEST_MODE: repeat needs DEEPGRAM_API_KEY/,
    );
  });

  it('requires the native agent URL, token, and Deepgram in native mode', () => {
    const native = {
      GATEWAY_AUDIO_TEST_MODE: 'native',
      AGENT_NATIVE_URL: 'ws://127.0.0.1:8787',
      AGENT_NATIVE_TOKEN: 'dev-token',
    };
    const env = loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, ...native }));
    expect(env.GATEWAY_AUDIO_TEST_MODE).toBe('native');
    expect(nativeAgentConfig(env)).toEqual({ url: 'ws://127.0.0.1:8787', token: 'dev-token' });
    expect(nativeAgentConfig(loadGatewayEnv(gatewayEnvFixture()))).toBeUndefined();

    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, GATEWAY_AUDIO_TEST_MODE: 'native' })),
    ).toThrow(
      /AGENT_NATIVE_URL: is required when mode is native[\s\S]*AGENT_NATIVE_TOKEN: is required/,
    );
    expect(() => loadGatewayEnv(gatewayEnvFixture(native))).toThrow(
      /GATEWAY_AUDIO_TEST_MODE: native needs DEEPGRAM_API_KEY/,
    );
    expect(() =>
      loadGatewayEnv(
        gatewayEnvFixture({ ...DEEPGRAM, ...native, AGENT_NATIVE_URL: 'https://x.test' }),
      ),
    ).toThrow(/AGENT_NATIVE_URL/);
  });

  it('requires the REST agent URL, token, and Deepgram in rest mode', () => {
    const rest = {
      GATEWAY_AUDIO_TEST_MODE: 'rest',
      AGENT_REST_URL: 'http://127.0.0.1:8789/cord/turns',
      AGENT_REST_TOKEN: 'dev-token',
    };
    const env = loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, ...rest }));
    expect(restAgentConfig(env)).toEqual({
      url: 'http://127.0.0.1:8789/cord/turns',
      token: 'dev-token',
    });
    expect(restAgentConfig(loadGatewayEnv(gatewayEnvFixture()))).toBeUndefined();
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, GATEWAY_AUDIO_TEST_MODE: 'rest' })),
    ).toThrow(/AGENT_REST_URL: is required when mode is rest[\s\S]*AGENT_REST_TOKEN: is required/);
    expect(() => loadGatewayEnv(gatewayEnvFixture(rest))).toThrow(
      /GATEWAY_AUDIO_TEST_MODE: rest needs DEEPGRAM_API_KEY/,
    );
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, ...rest, AGENT_REST_URL: 'wss://x.test' })),
    ).toThrow(/AGENT_REST_URL/);
  });

  it('requires https and a long REST token outside development without echoing it', () => {
    const staging = {
      ...DEEPGRAM,
      ...LIVEKIT,
      CORD_ENV: 'staging',
      GATEWAY_AUDIO_TEST_MODE: 'rest',
      AGENT_REST_URL: 'https://agent.example.com/cord/turns',
    };
    let error: unknown;
    try {
      loadGatewayEnv(gatewayEnvFixture({ ...staging, AGENT_REST_TOKEN: 'short-secret' }));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/AGENT_REST_TOKEN: must be at least 16 characters/);
    expect(String(error)).not.toContain('short-secret');
    expect(() =>
      loadGatewayEnv(
        gatewayEnvFixture({
          ...staging,
          AGENT_REST_URL: 'http://agent.example.com/cord/turns',
          AGENT_REST_TOKEN: 'x'.repeat(16),
        }),
      ),
    ).toThrow(/AGENT_REST_URL: must use https:\/\//);
  });

  it('requires a long native agent token outside development without echoing it', () => {
    const staging = {
      ...DEEPGRAM,
      ...LIVEKIT,
      CORD_ENV: 'staging',
      GATEWAY_AUDIO_TEST_MODE: 'native',
      AGENT_NATIVE_URL: 'wss://agent.example.com',
    };
    let error: unknown;
    try {
      loadGatewayEnv(gatewayEnvFixture({ ...staging, AGENT_NATIVE_TOKEN: 'short-secret' }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).toMatch(/AGENT_NATIVE_TOKEN: must be at least 16 characters/);
    expect(String(error)).not.toContain('short-secret');
    expect(
      loadGatewayEnv(gatewayEnvFixture({ ...staging, AGENT_NATIVE_TOKEN: 'x'.repeat(16) }))
        .AGENT_NATIVE_TOKEN,
    ).toHaveLength(16);
  });

  it('requires a wss:// native agent URL outside development', () => {
    const staging = {
      ...DEEPGRAM,
      ...LIVEKIT,
      CORD_ENV: 'staging',
      GATEWAY_AUDIO_TEST_MODE: 'native',
      AGENT_NATIVE_TOKEN: 'x'.repeat(16),
    };
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...staging, AGENT_NATIVE_URL: 'ws://agent.example.com' })),
    ).toThrow(/AGENT_NATIVE_URL: must use wss:\/\/ when CORD_ENV=staging/);
    expect(
      loadGatewayEnv(gatewayEnvFixture({ ...staging, AGENT_NATIVE_URL: 'wss://agent.example.com' }))
        .AGENT_NATIVE_URL,
    ).toBe('wss://agent.example.com');
  });

  it('rejects non-Flux models', () => {
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ ...DEEPGRAM, DEEPGRAM_TTS_MODEL: 'aura-2-thalia-en' })),
    ).toThrow(/DEEPGRAM_TTS_MODEL: must be a Flux TTS voice/);
  });

  it('requires a data folder and credentials key outside development', () => {
    const base = { ...DEEPGRAM, ...LIVEKIT, CORD_ENV: 'staging' };
    expect(() =>
      loadGatewayEnv({ ...base, CORD_DATA_DIR: '/var/lib/cord', CORD_RELEASE: 'x' }),
    ).toThrow(/CORD_CREDENTIALS_KEY: is required when CORD_ENV=staging/);
    expect(() => loadGatewayEnv({ ...base, CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY })).toThrow(
      /CORD_DATA_DIR: is required when CORD_ENV=staging/,
    );
  });

  it('accepts only 32-byte base64 credential keys and never echoes them', () => {
    const short = 'AQEBAQEBAQEBAQEBAQEBAQ==';
    let error: unknown;
    try {
      loadGatewayEnv(gatewayEnvFixture({ CORD_CREDENTIALS_KEY: short }));
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/CORD_CREDENTIALS_KEY: must be 32 random bytes/);
    expect(String(error)).not.toContain(short);
    expect(loadGatewayEnv(gatewayEnvFixture()).CORD_CREDENTIALS_KEY).toBeUndefined();
  });

  it('collects the current and old credential keys by version', () => {
    const old = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
    const env = loadGatewayEnv(
      gatewayEnvFixture({
        CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
        CORD_CREDENTIALS_KEY_VERSION: '2',
        CORD_CREDENTIALS_OLD_KEYS: `1:${old}`,
      }),
    );
    expect(credentialKeys(env)).toEqual({
      currentVersion: 2,
      keys: new Map([
        [1, old],
        [2, FAKE_CREDENTIALS_KEY],
      ]),
    });
    expect(() =>
      loadGatewayEnv(
        gatewayEnvFixture({
          CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
          CORD_CREDENTIALS_OLD_KEYS: `1:${old}`,
        }),
      ),
    ).toThrow(/must not reuse CORD_CREDENTIALS_KEY_VERSION/);
    expect(() =>
      loadGatewayEnv(gatewayEnvFixture({ CORD_CREDENTIALS_OLD_KEYS: 'nonsense' })),
    ).toThrow(/CORD_CREDENTIALS_OLD_KEYS/);
  });
});

describe('loadGatewayEnv self-hosted mode', () => {
  const SELFHOST = {
    TWRING_MODE: 'selfhost',
    AUTH_MODE: 'pairing',
    TWRING_SERVER_KEY_FILE: '/data/server.pem',
    TWRING_ADMIN_TOKEN: 'a'.repeat(32),
    TWRING_RELAY_KEY_FILE: '/data/relay.key',
    TWRING_AUDIO: 'own',
    ...DEEPGRAM,
    ...LIVEKIT,
  };
  const NO_LIVEKIT = {
    LIVEKIT_URL: undefined,
    LIVEKIT_API_KEY: undefined,
    LIVEKIT_API_SECRET: undefined,
  };
  const selfhost = (overrides: Record<string, string | undefined> = {}) =>
    loadGatewayEnv(gatewayEnvFixture({ ...SELFHOST, ...overrides }));

  it('defaults to hosted with the self-host settings at their defaults', () => {
    const env = loadGatewayEnv(gatewayEnvFixture());
    expect(env.TWRING_MODE).toBe('hosted');
    expect(env.TWRING_RELAY_URL).toBe('https://relay.twring.com');
    expect(env.TWRING_SPACE_ID).toBe('default');
    expect(env.SPEECH_KEYS_ENABLED).toBe(false);
  });
  it('accepts a complete self-hosted setup and turns speech keys on', () => {
    const env = selfhost();
    expect(env.TWRING_MODE).toBe('selfhost');
    expect(env.AUTH_MODE).toBe('pairing');
    expect(env.SPEECH_KEYS_ENABLED).toBe(true);
    expect(selfhost({ SPEECH_KEYS_ENABLED: 'false' }).SPEECH_KEYS_ENABLED).toBe(false);
  });
  it.each([
    'TWRING_SERVER_KEY_FILE',
    'TWRING_ADMIN_TOKEN',
    'TWRING_RELAY_KEY_FILE',
    'TWRING_AUDIO',
  ])('requires %s', (key) => {
    expect(() => selfhost({ [key]: undefined })).toThrow(new RegExp(key));
  });
  it('requires AUTH_MODE=pairing', () => {
    expect(() => selfhost({ AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE/);
  });
  it('rejects a short admin token', () => {
    expect(() => selfhost({ TWRING_ADMIN_TOKEN: 'short' })).toThrow(/TWRING_ADMIN_TOKEN/);
  });
  it.each([
    ['SUPABASE_URL', 'https://p.supabase.invalid'],
    ['APPLE_SIGNIN_KEY_FILE', '/k.p8'],
    ['FCM_SERVICE_ACCOUNT_FILE', '/f.json'],
    ['APNS_KEY_FILE', '/a.p8'],
    ['RESEND_API_KEY', 're_fake'],
    ['INVITE_FROM', 'Twring <i@example.com>'],
    ['WAITLIST_NOTIFY_TO', 'o@example.com'],
    ['WAITLIST_NOTIFY_FROM', 'Twring <w@example.com>'],
  ])('forbids %s and names it', (key, value) => {
    expect(() => selfhost({ [key]: value })).toThrow(new RegExp(`${key}: .*self-hosted`));
  });
  it('needs a speech key, from Deepgram or xAI', () => {
    expect(() => selfhost({ DEEPGRAM_API_KEY: undefined })).toThrow(/DEEPGRAM_API_KEY/);
    const env = selfhost({ DEEPGRAM_API_KEY: undefined, XAI_API_KEY: 'xai-fake-key' });
    expect(env.XAI_API_KEY).toBe('xai-fake-key');
  });
  it('own audio needs LiveKit, twring audio forbids it', () => {
    expect(() => selfhost(NO_LIVEKIT)).toThrow(/LIVEKIT_URL/);
    expect(() => selfhost({ TWRING_AUDIO: 'twring' })).toThrow(/LIVEKIT_URL/);
    expect(selfhost({ TWRING_AUDIO: 'twring', ...NO_LIVEKIT }).TWRING_AUDIO).toBe('twring');
  });
  it('twring audio caps a call at 2 hours', () => {
    const twring = { TWRING_AUDIO: 'twring', ...NO_LIVEKIT };
    expect(() => selfhost({ ...twring, CALL_MAX_DURATION_S: '7201' })).toThrow(
      /CALL_MAX_DURATION_S/,
    );
    expect(selfhost({ ...twring, CALL_MAX_DURATION_S: '7200' }).CALL_MAX_DURATION_S).toBe(7200);
  });
  it('validates in production for both audio modes', () => {
    const prod = {
      CORD_ENV: 'production',
      SENTRY_DSN: FAKE_SENTRY_DSN,
      SUPABASE_URL: undefined,
      CORD_PUBLIC_URL: 'https://home.example.com',
    };
    expect(selfhost(prod).TWRING_AUDIO).toBe('own');
    expect(selfhost({ ...prod, LIVEKIT_URL: 'wss://lk.example.com' }).TWRING_AUDIO).toBe('own');
    expect(selfhost({ ...prod, TWRING_AUDIO: 'twring', ...NO_LIVEKIT }).TWRING_AUDIO).toBe(
      'twring',
    );
    expect(() => selfhost({ ...prod, ...NO_LIVEKIT })).toThrow(/LIVEKIT_URL/);
  });
  it('runs in production without SENTRY_DSN (the installer never sets one)', () => {
    const prod = {
      CORD_ENV: 'production',
      SENTRY_DSN: undefined,
      SUPABASE_URL: undefined,
      CORD_PUBLIC_URL: 'https://home.example.com',
    };
    expect(selfhost(prod).SENTRY_DSN).toBeUndefined();
    expect(() =>
      selfhost({ ...prod, SENTRY_DSN: 'http://key@o0.ingest.sentry.invalid/0' }),
    ).toThrow(/SENTRY_DSN: must use https/);
  });
  it('needs an explicit https CORD_PUBLIC_URL in production', () => {
    const prod = { CORD_ENV: 'production', SENTRY_DSN: FAKE_SENTRY_DSN, SUPABASE_URL: undefined };
    expect(() => selfhost(prod)).toThrow(/CORD_PUBLIC_URL/);
    expect(() => selfhost({ ...prod, CORD_PUBLIC_URL: 'http://home.example.com' })).toThrow(
      /CORD_PUBLIC_URL/,
    );
  });
  it('an xAI-only server runs the agent, not the echo line', () => {
    const env = selfhost({ DEEPGRAM_API_KEY: undefined, XAI_API_KEY: 'xai-fake-key' });
    expect(env.GATEWAY_AUDIO_TEST_MODE).toBe('agent');
  });
  it('rejects pairing outside self-hosted mode', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ AUTH_MODE: 'pairing' }))).toThrow(
      /AUTH_MODE: .*TWRING_MODE=selfhost/,
    );
  });
  it('still demands Deepgram outside development when hosted', () => {
    expect(() => loadGatewayEnv(gatewayEnvFixture({ CORD_ENV: 'staging' }))).toThrow(
      /DEEPGRAM_API_KEY/,
    );
  });
});
