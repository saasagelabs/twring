import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  IOS_APPSTORE_NSE_PROFILE_BASE64: 'bnNl',
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

  it('stops before signing when the project has an app extension it has no profile for', () => {
    const text = readFileSync(script, 'utf8');
    const guard = text.indexOf('app-extension');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(text.indexOf('CODE_SIGN_STYLE'));
    expect(text).toMatch(/abort\(".*profile/);
    // Only the notification extension, matched by bundle id, is exempt.
    expect(text).toContain('NSE_BUNDLE_ID=com.twring.app.NotificationService');
    expect(text).toMatch(/partition \{ \|t\| ids\.\(t\) == \[ENV\.fetch\("NSE_BUNDLE_ID"\)\] \}/);
    expect(text).toMatch(/unless others\.empty\?\s*\n\s*abort/);
  });

  it('requires the extension profile and never prints it', () => {
    const { status, stderr, stdout } = run({ ...ALL, IOS_APPSTORE_NSE_PROFILE_BASE64: '' });
    expect(status).toBe(1);
    expect(stderr).toContain('IOS_APPSTORE_NSE_PROFILE_BASE64');
    expect(stderr + stdout).not.toContain('bnNl');
  });

  it('signs the app and the extension each with its own profile', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('base64 --decode >"$WORK/nse.mobileprovision"');
    expect(text).toContain('echo "IOS_NSE_PROFILE_NAME=$nse_name"');
    expect(text).toContain('echo "IOS_NSE_PROFILE_UUID=$nse_uuid"');
    expect(text).toContain('sign.(t, ENV.fetch("IOS_PROFILE_NAME"))');
    expect(text).toContain('nse.each { |t| sign.(t, ENV.fetch("IOS_NSE_PROFILE_NAME")) }');
  });

  it('maps both bundle ids in ExportOptions and removes both profiles', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).toContain('<key>${BUNDLE_ID}</key><string>${IOS_PROFILE_NAME}</string>');
    expect(text).toContain('<key>${NSE_BUNDLE_ID}</key><string>${IOS_NSE_PROFILE_NAME}</string>');
    const cleanup = text.slice(text.indexOf('cleanup() {'));
    expect(cleanup.match(/IOS_PROFILE_UUID:-none/g)).toHaveLength(2);
    expect(cleanup.match(/IOS_NSE_PROFILE_UUID:-none/g)).toHaveLength(2);
  });

  it('rejects an unknown command', () => {
    const result = spawnSync('bash', [script, 'nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});
