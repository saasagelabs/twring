import { FAKE_CREDENTIALS_KEY, gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { credentialKeys, loadGatewayEnv } from './gateway';

// Verifier edge cases for CORD_CREDENTIALS_KEY / CORD_CREDENTIALS_OLD_KEYS parsing.

/** Fake 32-byte keys (base64): every byte 0x04, and every byte 0x05. */
const KEY_4 = 'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=';
const KEY_5 = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=';

function configError(overrides: Record<string, string>): string {
  try {
    loadGatewayEnv(gatewayEnvFixture(overrides));
  } catch (error) {
    return String(error);
  }
  return '';
}

describe('credential key config edge cases', () => {
  it('rejects base64url and whitespace-padded keys rather than mis-decoding them', () => {
    const url = '-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_v7-_s';
    expect(configError({ CORD_CREDENTIALS_KEY: url })).toMatch(/CORD_CREDENTIALS_KEY/);
    expect(configError({ CORD_CREDENTIALS_KEY: `${FAKE_CREDENTIALS_KEY}\n` })).toMatch(
      /CORD_CREDENTIALS_KEY/,
    );
  });

  it('a malformed old-key pair names the variable but never echoes any key material', () => {
    const good = KEY_4;
    const short = 'BAQEBAQEBAQEBAQEBAQEBA==';
    const message = configError({
      CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
      CORD_CREDENTIALS_KEY_VERSION: '3',
      CORD_CREDENTIALS_OLD_KEYS: `1:${good},2:${short}`,
    });
    expect(message).toMatch(/CORD_CREDENTIALS_OLD_KEYS/);
    for (const secret of [good, short, FAKE_CREDENTIALS_KEY]) expect(message).not.toContain(secret);
  });

  it('rejects version 0 and non-numeric versions in old keys', () => {
    const key = KEY_4;
    for (const pair of [`0:${key}`, `v1:${key}`, `-1:${key}`, key]) {
      expect(
        configError({
          CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
          CORD_CREDENTIALS_OLD_KEYS: pair,
        }),
        pair,
      ).toMatch(/CORD_CREDENTIALS_OLD_KEYS/);
    }
  });

  it('old keys alone are not a credentials key: deployed envs still require the current key', () => {
    const key = KEY_4;
    expect(
      configError({
        CORD_ENV: 'staging',
        CORD_CREDENTIALS_KEY: '',
        CORD_CREDENTIALS_OLD_KEYS: `1:${key}`,
      }),
    ).toMatch(/CORD_CREDENTIALS_KEY: is required/);
    const dev = loadGatewayEnv(gatewayEnvFixture({ CORD_CREDENTIALS_OLD_KEYS: `2:${key}` }));
    expect(credentialKeys(dev)).toBeUndefined();
  });

  it('tolerates spaces and empty entries between old-key pairs', () => {
    const one = KEY_4;
    const two = KEY_5;
    const env = loadGatewayEnv(
      gatewayEnvFixture({
        CORD_CREDENTIALS_KEY: FAKE_CREDENTIALS_KEY,
        CORD_CREDENTIALS_KEY_VERSION: '3',
        CORD_CREDENTIALS_OLD_KEYS: ` 1:${one} ,, 2:${two} ,`,
      }),
    );
    expect([...credentialKeys(env)!.keys.keys()].sort()).toEqual([1, 2, 3]);
  });
});
