import { mobileEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it } from 'vitest';

import { resolveMobileEnv } from './env';

describe('resolveMobileEnv', () => {
  it('returns the parsed env when valid', () => {
    const result = resolveMobileEnv(mobileEnvFixture());
    expect(result).toEqual({
      ok: true,
      env: { CORD_ENV: 'development', API_BASE_URL: 'http://10.0.2.2:8080' },
    });
  });

  it('returns issues instead of throwing when invalid, so the app can render an error state', () => {
    const result = resolveMobileEnv(mobileEnvFixture({ API_BASE_URL: undefined }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/^API_BASE_URL:/);
  });
});
