import { describe, expect, it } from 'vitest';

import { errorResponseSchema, healthReadyResponseSchema } from './index';

describe('health contracts', () => {
  it('accepts a ready response', () => {
    const parsed = healthReadyResponseSchema.parse({
      status: 'ready',
      environment: 'staging',
      release: 'abc123',
      checks: { config: 'ok' },
    });
    expect(parsed.status).toBe('ready');
  });

  it('rejects an unknown environment', () => {
    const result = healthReadyResponseSchema.safeParse({
      status: 'ready',
      environment: 'prod',
      release: 'abc123',
      checks: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('error contract', () => {
  it('rejects codes outside the stable set', () => {
    const result = errorResponseSchema.safeParse({
      error: { code: 'something_new', message: 'x' },
    });
    expect(result.success).toBe(false);
  });
});
