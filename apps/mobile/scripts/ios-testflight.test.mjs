import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The TestFlight build script's secrets check (the macOS-only steps are proven on GitHub). */

const script = join(import.meta.dirname, 'ios-testflight.sh');
const ALL = {
  ASC_KEY_ID: 'k',
  ASC_ISSUER_ID: 'i',
  ASC_KEY_P8_BASE64: 'cDg=',
  IOS_DIST_CERT_P12_BASE64: 'cDEy',
  IOS_DIST_CERT_PASSWORD: 'pw-value-123',
  IOS_APPSTORE_PROFILE_BASE64: 'cHJv',
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'client',
  EXPO_PUBLIC_SENTRY_DSN: 'https://dsn',
};
const run = (env) =>
  spawnSync('bash', [script, 'check-env'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });

describe('ios-testflight.sh check-env', () => {
  it('passes when every secret is set', () => {
    expect(run(ALL).status).toBe(0);
  });

  it('lists every missing or empty secret and never prints a value', () => {
    const { status, stderr, stdout } = run({ ...ALL, ASC_KEY_ID: '', IOS_DIST_CERT_PASSWORD: '' });
    expect(status).toBe(1);
    expect(stderr).toContain('ASC_KEY_ID');
    expect(stderr).toContain('IOS_DIST_CERT_PASSWORD');
    for (const value of ['cDg=', 'client', 'https://dsn', 'cHJv']) {
      expect(stderr + stdout).not.toContain(value);
    }
  });

  it('rejects an unknown command', () => {
    const result = spawnSync('bash', [script, 'nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
