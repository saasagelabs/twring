import { describe, expect, it } from 'vitest';

import { CallInterruption } from './call-interruption';

function fakeTarget(muted = false) {
  const target = {
    muted,
    calls: [] as string[],
    failRestore: false,
    isMuted: () => target.muted,
    setMuted: (next: boolean) => {
      target.muted = next;
      target.calls.push(next ? 'mute' : 'unmute');
      return Promise.resolve();
    },
    restoreRoute: () => {
      target.calls.push('route');
      return target.failRestore ? Promise.reject(new Error('no route')) : Promise.resolve();
    },
  };
  return target;
}

describe('CallInterruption', () => {
  it('mutes when a phone call begins, then restores the route and unmutes when it ends', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    expect(interruption.getState().paused).toBe(true);
    expect(target.muted).toBe(true);
    await interruption.handle('ended');
    expect(interruption.getState().paused).toBe(false);
    expect(target.calls).toEqual(['mute', 'route', 'unmute']);
  });

  it('holds the route while the phone call has the audio', async () => {
    const calls: string[] = [];
    const target = { ...fakeTarget(), holdRoute: () => calls.push('hold') };
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    await interruption.handle('began');
    expect(calls).toEqual(['hold']);
  });

  it('keeps the microphone muted afterwards when the caller had muted it', async () => {
    const target = fakeTarget(true);
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    await interruption.handle('ended');
    expect(target.muted).toBe(true);
    expect(target.calls).toEqual(['route']);
  });

  it('ignores repeated or unmatched events', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target);
    await interruption.handle('ended');
    await interruption.handle('began');
    await interruption.handle('began');
    expect(target.calls).toEqual(['mute']);
  });

  it('still unmutes when restoring the route fails, and reports it', async () => {
    const errors: string[] = [];
    const target = fakeTarget();
    target.failRestore = true;
    const interruption = new CallInterruption(target, (detail) => errors.push(detail));
    await interruption.handle('began');
    await interruption.handle('ended');
    expect(target.muted).toBe(false);
    expect(errors).toEqual(['no route']);
  });

  it('reset clears the notice without touching the call', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target);
    let notified = 0;
    interruption.subscribe(() => (notified += 1));
    await interruption.handle('began');
    interruption.reset();
    expect(interruption.getState().paused).toBe(false);
    expect(target.calls).toEqual(['mute']);
    expect(notified).toBe(2);
  });
});

describe('CallInterruption edge cases', () => {
  it('an interruption that never ends keeps the notice and mute until reset', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    expect(interruption.getState().paused).toBe(true);
    interruption.reset();
    await interruption.handle('ended');
    expect(target.calls).toEqual(['mute']);
  });

  it('respects the caller unmuting during the interruption', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    await target.setMuted(false);
    await interruption.handle('ended');
    expect(target.muted).toBe(false);
    expect(target.calls).toEqual(['mute', 'unmute', 'route']);
  });

  it('a new interruption after reset reads the mute afresh', async () => {
    const target = fakeTarget(true);
    const interruption = new CallInterruption(target);
    await interruption.handle('began');
    interruption.reset();
    target.muted = false;
    await interruption.handle('began');
    await interruption.handle('ended');
    expect(target.muted).toBe(false);
  });
});
