import { describe, expect, it } from 'vitest';

import { showsInAppRing } from './in-app-ring';

const base = { systemRingScreen: false, showing: undefined, inviteId: 'inv_1', inCall: false };

describe('showsInAppRing', () => {
  it('Android: shows the app ring screen for a new ring', () => {
    expect(showsInAppRing(base)).toBe(true);
  });

  it('iPhone: never, the system call screen shows every ring (a second screen got stuck)', () => {
    expect(showsInAppRing({ ...base, systemRingScreen: true })).toBe(false);
  });

  it('not twice for the ring already showing', () => {
    expect(showsInAppRing({ ...base, showing: 'inv_1' })).toBe(false);
  });

  it('not during a call', () => {
    expect(showsInAppRing({ ...base, inCall: true })).toBe(false);
  });
});
