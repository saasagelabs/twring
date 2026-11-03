import type { MeUsageResponse } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';
import { callError } from '../call/controller';

import {
  dailyLimitMessage,
  nextUtcMidnight,
  resetPhrase,
  usageResetLine,
  usageSummary,
} from './copy';

/** Fixed formatter: the test must not depend on the machine's locale or time zone. */
const hhmm = (date: Date) => date.toISOString().slice(11, 16);

const USAGE: MeUsageResponse = {
  day: '2026-09-30',
  resets_at: '2026-10-01T00:00:00.000Z',
  call_seconds_used: 750,
  call_seconds_allowed: 3600,
  calls_used: 3,
  calls_allowed: 50,
};

describe('daily limit copy', () => {
  it('says the time is used up and when it resets', () => {
    const now = new Date(2026, 8, 30, 10, 0);
    const resetsAt = new Date(2026, 8, 30, 17, 30);
    expect(dailyLimitMessage(resetsAt, now, hhmm)).toBe(
      `You've used today's calling time. It resets at ${hhmm(resetsAt)}.`,
    );
    const tomorrow = new Date(2026, 9, 1, 5, 30);
    expect(resetPhrase(tomorrow, now, hhmm)).toBe(`It resets tomorrow at ${hhmm(tomorrow)}.`);
  });

  it('falls back to the next UTC midnight when the server did not say', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(nextUtcMidnight(now).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(dailyLimitMessage(undefined, now, hhmm)).toContain('00:00');
    expect(dailyLimitMessage(new Date('nonsense'), now, hhmm)).toContain('00:00');
  });

  it('maps the API code to plain copy with the reset time', () => {
    const copy = apiErrorCopy(
      new ApiError('http', 'daily_limit_reached', 'req-1', new Date('2026-10-01T00:00:00Z')),
    );
    expect(copy.message).toMatch(/^You've used today's calling time\. It resets (tomorrow )?at /);
    expect(copy.retryable).toBe(false);
  });

  it('has call failure copy for DAILY_LIMIT_REACHED', () => {
    expect(callError('DAILY_LIMIT_REACHED')).toMatchObject({
      code: 'DAILY_LIMIT_REACHED',
      retryable: false,
    });
    expect(callError('DAILY_LIMIT_REACHED', 'call_1', 'custom').message).toBe('custom');
  });
});

describe('usage summary', () => {
  it('shows used against allowed', () => {
    expect(usageSummary(USAGE)).toBe('12 of 60 minutes used today · 3 of 50 calls');
  });

  it('shows plain counts when unlimited, with no reset line', () => {
    const unlimited = { ...USAGE, call_seconds_allowed: null, calls_allowed: null, calls_used: 1 };
    expect(usageSummary(unlimited)).toBe('12 minutes used today · 1 call');
    expect(usageResetLine(unlimited)).toBeUndefined();
  });

  it('says when it resets, and that it is used up once it is', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(usageResetLine(USAGE, now, hhmm)).toMatch(/^It resets /);
    expect(usageResetLine({ ...USAGE, calls_used: 50 }, now, hhmm)).toMatch(
      /^You've used today's calling time\./,
    );
  });
});
