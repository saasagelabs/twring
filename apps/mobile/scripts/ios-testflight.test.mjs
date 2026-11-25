import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** The TestFlight build script's secrets check (the macOS-only steps are proven on GitHub). */

/**
 * Git Bash on Windows, or null. A bare `bash` there is often WSL's launcher (System32 or
 * WindowsApps), which never runs this script, so look next to Git for Windows instead.
 */
function findGitBash() {
  const roots = [];
  try {
    // <git root>/mingw64/libexec/git-core
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    roots.push(join(execPath, '..', '..', '..'));
  } catch {
    // git is not on PATH: try the default install below.
  }
  if (process.env.ProgramFiles) roots.push(join(process.env.ProgramFiles, 'Git'));
  const candidates = roots.flatMap((root) => [
    join(root, 'bin', 'bash.exe'),
    join(root, 'usr', 'bin', 'bash.exe'),
  ]);
  return candidates.find((path) => existsSync(path)) ?? null;
}

const bash = process.platform === 'win32' ? findGitBash() : 'bash';
// Windows without Git for Windows has no bash that can run the script: skip, never fake a pass.
const itRunsScript = it.skipIf(bash === null);

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
  spawnSync(bash, [script, 'check-env'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf8',
  });

describe('ios-testflight.sh check-env', () => {
  itRunsScript('passes when every secret is set', () => {
    expect(run(ALL).status).toBe(0);
  });

  itRunsScript('lists every missing or empty secret and never prints a value', () => {
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
    expect(text).toContain('NSE_BUNDLE_ID="$BUNDLE_ID.NotificationService"');
    expect(text).toMatch(/partition \{ \|t\| ids\.\(t\) == \[ENV\.fetch\("NSE_BUNDLE_ID"\)\] \}/);
    expect(text).toMatch(/unless others\.empty\?\s*\n\s*abort/);
  });

  itRunsScript('requires the extension profile and never prints it', () => {
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

  itRunsScript('names the production app it builds by default', () => {
    const { status, stdout } = run(ALL);
    expect(status).toBe(0);
    expect(stdout).toContain('production app (com.twring.app,');
  });

  itRunsScript('refuses an unknown app variant', () => {
    const { status, stderr } = run({ ...ALL, APP_VARIANT: 'beta' });
    expect(status).toBe(2);
    expect(stderr).toContain('APP_VARIANT');
  });

  itRunsScript('rejects an unknown command', () => {
    const result = spawnSync(bash, [script, 'nope'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
  });
});

describe('ios-testflight.sh check-env for the staging app', () => {
  // Twring Staging: its own App Store Connect app and profiles, talking to the staging server.
  const STAGING = {
    ...ALL,
    IOS_APPSTORE_PROFILE_BASE64: '',
    IOS_APPSTORE_NSE_PROFILE_BASE64: '',
    APP_VARIANT: 'staging',
    IOS_STAGING_APPSTORE_PROFILE_BASE64: 'c3Rn',
    IOS_STAGING_APPSTORE_NSE_PROFILE_BASE64: 'c25z',
    STAGING_ASC_APP_ID: '6999999999',
    EXPO_PUBLIC_API_BASE_URL: 'https://staging.example.test',
  };

  itRunsScript('passes with the staging profiles alone and names the staging app', () => {
    const { status, stdout } = run(STAGING);
    expect(status).toBe(0);
    expect(stdout).toContain(
      'staging app (com.twring.app.staging, App Store Connect app 6999999999)',
    );
  });

  itRunsScript('lists the missing staging profiles and app id, never printing a value', () => {
    const { status, stderr, stdout } = run({
      ...STAGING,
      IOS_STAGING_APPSTORE_NSE_PROFILE_BASE64: '',
      STAGING_ASC_APP_ID: '',
    });
    expect(status).toBe(1);
    expect(stderr).toContain('IOS_STAGING_APPSTORE_NSE_PROFILE_BASE64');
    expect(stderr).toContain('STAGING_ASC_APP_ID');
    expect(stderr).not.toContain('IOS_APPSTORE_PROFILE_BASE64');
    expect(stderr + stdout).not.toContain('c3Rn');
  });

  itRunsScript('refuses an App Store Connect app id that is not a number', () => {
    const { status, stderr } = run({ ...STAGING, STAGING_ASC_APP_ID: 'com.twring.app.staging' });
    expect(status).toBe(1);
    expect(stderr).toContain('STAGING_ASC_APP_ID');
  });

  // The workflow falls back to the production address when the staging one is not set.
  itRunsScript.each(['', 'https://api.twring.com', 'http://staging.example.test'])(
    'refuses to build the staging app for the server "%s"',
    (address) => {
      const { status, stderr } = run({ ...STAGING, EXPO_PUBLIC_API_BASE_URL: address });
      expect(status).toBe(1);
      expect(stderr).toContain('STAGING_API_BASE_URL');
    },
  );
});
