import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadGatewayEnv } from '@twring/config/gateway';
import { FAKE_PRODUCTION_CREDENTIALS_KEY, FAKE_SENTRY_DSN } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

/**
 * Committed `.env*.example` files are templates. Real credentials belong in the git-ignored
 * `.env` / `.env.local`. This fails CI if a secret is ever pasted into a template.
 */
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const TEMPLATES = [
  'apps/gateway/.env.example',
  'apps/gateway/.env.staging.example',
  'apps/gateway/.env.production.example',
  'apps/mobile/.env.example',
];

const SECRET_KEYS = [
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY',
  'CARTESIA_API_KEY',
  'AGENT_NATIVE_TOKEN',
  'AGENT_REST_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'CORD_CREDENTIALS_KEY',
  'CORD_CREDENTIALS_OLD_KEYS',
];

function assignments(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  return values;
}

describe('.env example templates', () => {
  it.each(TEMPLATES)('%s leaves every secret empty', (path) => {
    const values = assignments(readFileSync(repo(path), 'utf8'));
    for (const key of SECRET_KEYS) {
      if (values.has(key)) expect(values.get(key), `${path}: ${key} must be empty`).toBe('');
    }
  });

  it('the production template starts once its secrets are filled in', () => {
    const values = assignments(readFileSync(repo('apps/gateway/.env.production.example'), 'utf8'));
    const source: Record<string, string | undefined> = Object.fromEntries(
      [...values].filter(([, value]) => value !== ''),
    );
    expect(() => loadGatewayEnv(source)).toThrow(ConfigError);
    const env = loadGatewayEnv({
      ...source,
      SENTRY_DSN: FAKE_SENTRY_DSN,
      LIVEKIT_URL: 'wss://cord-test.livekit.invalid',
      LIVEKIT_API_KEY: 'APIfake',
      LIVEKIT_API_SECRET: 'fake-secret-value-for-tests',
      DEEPGRAM_API_KEY: 'fake-deepgram-key-for-tests',
      CORD_CREDENTIALS_KEY: FAKE_PRODUCTION_CREDENTIALS_KEY,
    });
    expect(env.CORD_ENV).toBe('production');
    expect(env.TRUST_PROXY).toEqual(['127.0.0.1']);
  });
});
