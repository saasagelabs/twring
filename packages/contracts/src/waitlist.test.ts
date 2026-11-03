import { describe, expect, it } from 'vitest';

import { WAITLIST_MAX_ENTRIES, waitlistRequestSchema } from './index';

describe('waitlist contract', () => {
  it('trims a valid email and accepts only the landing source', () => {
    expect(waitlistRequestSchema.parse({ email: '  Me@Example.com  ', source: 'landing' })).toEqual(
      { email: 'Me@Example.com', source: 'landing' },
    );
    expect(
      waitlistRequestSchema.safeParse({ email: 'a@example.com', source: 'other' }).success,
    ).toBe(false);
  });

  it('rejects invalid and overlong emails', () => {
    expect(waitlistRequestSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(
      waitlistRequestSchema.safeParse({ email: `${'a'.repeat(250)}@example.com` }).success,
    ).toBe(false);
    expect(WAITLIST_MAX_ENTRIES).toBe(50_000);
  });
});
