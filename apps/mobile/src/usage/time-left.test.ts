import type { MeUsageResponse } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { remainingAtConnect, timeLeftNotice, TIME_LEFT_COPY } from './time-left';

const usage = (used: number, allowed: number | null): MeUsageResponse => ({
  day: '2026-11-23',
  resets_at: '2026-11-24T00:00:00.000Z',
  call_seconds_used: used,
  call_seconds_allowed: allowed,
  calls_used: 1,
  calls_allowed: 50,
});

describe('remainingAtConnect', () => {
  it('is allowed minus used', () => {
    expect(remainingAtConnect(usage(600, 3600))).toBe(3000);
  });
  it('clamps at zero', () => {
    expect(remainingAtConnect(usage(4000, 3600))).toBe(0);
  });
  it('is undefined when calling is unlimited', () => {
    expect(remainingAtConnect(usage(600, null))).toBeUndefined();
  });
  it('is undefined when the fetch failed', () => {
    expect(remainingAtConnect(undefined)).toBeUndefined();
  });
});

describe('timeLeftNotice', () => {
  it('shows nothing with plenty of time', () => {
    expect(timeLeftNotice(3000, 0)).toBeUndefined();
    expect(timeLeftNotice(301, 0)).toBeUndefined();
  });
  it('shows the 5 minute line at exactly 5:00', () => {
    expect(timeLeftNotice(300, 0)).toBe('five');
    expect(timeLeftNotice(600, 300_000)).toBe('five');
  });
  it('shows the 5 minute line under 5:00', () => {
    expect(timeLeftNotice(600, 400_000)).toBe('five');
    expect(timeLeftNotice(200, 0)).toBe('five');
  });
  it('shows the 1 minute line at exactly 1:00 and under', () => {
    expect(timeLeftNotice(60, 0)).toBe('one');
    expect(timeLeftNotice(600, 540_000)).toBe('one');
    expect(timeLeftNotice(600, 580_000)).toBe('one');
  });
  it('shows the 1 minute line at zero and past it', () => {
    expect(timeLeftNotice(0, 0)).toBe('one');
    expect(timeLeftNotice(60, 120_000)).toBe('one');
  });
  it('shows nothing when unlimited or usage is unknown', () => {
    expect(timeLeftNotice(undefined, 999_999_000)).toBeUndefined();
  });
  it('copy has no em dash', () => {
    for (const line of Object.values(TIME_LEFT_COPY)) expect(line).not.toContain('—');
  });
});
