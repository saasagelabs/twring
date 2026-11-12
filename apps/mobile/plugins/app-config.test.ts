import type { ConfigContext, ExpoConfig } from 'expo/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** app.config.ts wires the upload-key signing plugin into production builds only. */
async function configFor(variant: string): Promise<ExpoConfig> {
  vi.resetModules();
  vi.stubEnv('APP_VARIANT', variant);
  const module = await import('../app.config.ts');
  return module.default({ config: {} } as ConfigContext);
}

const signsBuildGradle = (config: ExpoConfig) =>
  typeof (config as { mods?: { android?: { appBuildGradle?: unknown } } }).mods?.android
    ?.appBuildGradle === 'function';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app config signing', () => {
  it('production release builds get the fail-closed upload-key signing', async () => {
    expect(signsBuildGradle(await configFor('production'))).toBe(true);
  });

  it('development and staging keep debug signing (no upload key needed)', async () => {
    expect(signsBuildGradle(await configFor('development'))).toBe(false);
    expect(signsBuildGradle(await configFor('staging'))).toBe(false);
  });

  it('refuses a versionCode Play would reject', async () => {
    vi.stubEnv('CORD_VERSION_CODE', '0');
    await expect(configFor('production')).rejects.toThrow(/CORD_VERSION_CODE/);
    vi.stubEnv('CORD_VERSION_CODE', '12.5');
    await expect(configFor('production')).rejects.toThrow(/CORD_VERSION_CODE/);
    vi.stubEnv('CORD_VERSION_CODE', '42');
    expect((await configFor('production')).android?.versionCode).toBe(42);
  });
});

describe('app config microphone', () => {
  // A plugin option such as expo-image-picker's microphonePermission: false adds RECORD_AUDIO to
  // the blocked list (tools:node="remove"), which silences every call.
  it.each(['development', 'staging', 'production'])(
    '%s never blocks RECORD_AUDIO',
    async (variant) => {
      const config = await configFor(variant);
      expect(config.android?.blockedPermissions ?? []).not.toContain(
        'android.permission.RECORD_AUDIO',
      );
      const options = (config.plugins ?? []).flatMap((plugin) =>
        Array.isArray(plugin) ? [plugin[1] as Record<string, unknown> | undefined] : [],
      );
      for (const option of options) expect(option?.microphonePermission).not.toBe(false);
    },
  );
});

describe('app config permissions Play would ask about', () => {
  // Every sensitive permission is a Play Console question. Storage comes from the photo and
  // file pickers (Android 12 and older, which use the system picker and need none), biometrics
  // from secure storage's androidx dependency (Twring never asks for a fingerprint).
  it.each(['development', 'staging', 'production'])(
    '%s blocks storage, biometric and overlay permissions',
    async (variant) => {
      const blocked = (await configFor(variant)).android?.blockedPermissions ?? [];
      expect(blocked).toEqual(
        expect.arrayContaining([
          'android.permission.SYSTEM_ALERT_WINDOW',
          'android.permission.READ_EXTERNAL_STORAGE',
          'android.permission.WRITE_EXTERNAL_STORAGE',
          'android.permission.USE_BIOMETRIC',
          'android.permission.USE_FINGERPRINT',
        ]),
      );
      expect(blocked).not.toContain('android.permission.CAMERA');
    },
  );
});

describe('app config schemes', () => {
  it('production also opens twring:// links; development and staging keep one scheme', async () => {
    expect((await configFor('production')).scheme).toEqual(['cord', 'twring']);
    expect((await configFor('staging')).scheme).toBe('cord-staging');
    expect((await configFor('development')).scheme).toBe('cord-dev');
  });
});
