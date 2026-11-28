import { describe, expect, it } from 'vitest';

import { CallInterruption } from './call-interruption';

describe('CallInterruption verifier', () => {
  it('a began landing while a foreground resume restores the route does not leave the mic muted for good', async () => {
    let muted = false;
    let releaseRoute: () => void = () => undefined;
    let slowRoute = false;
    const target = {
      isMuted: () => muted,
      setMuted: (next: boolean) => {
        muted = next;
        return Promise.resolve();
      },
      restoreRoute: () =>
        slowRoute ? new Promise<void>((r) => (releaseRoute = r)) : Promise.resolve(),
    };
    const interruption = new CallInterruption(target, undefined, { wait: () => Promise.resolve() });
    await interruption.handle('began');
    slowRoute = true;
    const resume = interruption.resumeWithoutEnd(() => Promise.resolve(false));
    await new Promise((r) => setTimeout(r, 0));
    await interruption.handle('began'); // second interruption while route restore is in flight
    releaseRoute();
    await resume;
    slowRoute = false;
    await interruption.handle('ended');
    expect(interruption.getState().paused).toBe(false);
    expect(muted).toBe(false); // caller never muted
  });
});
