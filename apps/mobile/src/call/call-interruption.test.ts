import { describe, expect, it } from 'vitest';

import { CallInterruption, RESUME_DELAY_MS, type InterruptionRecovery } from './call-interruption';

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

function manualWait() {
  const pending: Array<() => void> = [];
  const waits: number[] = [];
  return {
    waits,
    wait: (ms: number) =>
      new Promise<void>((resolve) => {
        waits.push(ms);
        pending.push(resolve);
      }),
    release: () => {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
}

function setup(muted = false) {
  const target = fakeTarget(muted);
  const timer = manualWait();
  const recovered: InterruptionRecovery[] = [];
  let unrecovered = 0;
  const interruption = new CallInterruption(target, undefined, {
    wait: timer.wait,
    onRecovered: (via) => recovered.push(via),
    onUnrecovered: () => {
      unrecovered += 1;
    },
  });
  return { target, timer, recovered, interruption, unrecovered: () => unrecovered };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('CallInterruption.resumeWithoutEnd', () => {
  it('resumes on foreground when no phone call is on', async () => {
    const { target, timer, recovered, interruption } = setup();
    await interruption.handle('began');
    const resumed = interruption.resumeWithoutEnd(() => Promise.resolve(false));
    expect(timer.waits).toEqual([RESUME_DELAY_MS]);
    timer.release();
    await resumed;
    expect(interruption.getState().paused).toBe(false);
    expect(target.calls).toEqual(['mute', 'route', 'unmute']);
    expect(recovered).toEqual(['foreground']);
  });

  it('stays paused while a phone call is on', async () => {
    const { target, timer, recovered, interruption } = setup();
    await interruption.handle('began');
    const resumed = interruption.resumeWithoutEnd(() => Promise.resolve(true));
    timer.release();
    await resumed;
    expect(interruption.getState().paused).toBe(true);
    expect(target.calls).toEqual(['mute']);
    expect(recovered).toEqual([]);
  });

  it('stays paused when the phone call check fails', async () => {
    const { target, timer, interruption } = setup();
    await interruption.handle('began');
    const resumed = interruption.resumeWithoutEnd(() => Promise.reject(new Error('no module')));
    timer.release();
    await resumed;
    expect(interruption.getState().paused).toBe(true);
    expect(target.calls).toEqual(['mute']);
  });

  it('unmutes once when "ended" arrives during the wait', async () => {
    const { target, timer, recovered, interruption } = setup();
    await interruption.handle('began');
    let checked = false;
    const resumed = interruption.resumeWithoutEnd(() => {
      checked = true;
      return Promise.resolve(false);
    });
    await interruption.handle('ended');
    timer.release();
    await resumed;
    expect(checked).toBe(false);
    expect(target.calls).toEqual(['mute', 'route', 'unmute']);
    expect(recovered).toEqual(['ended']);
  });

  it('does nothing when not paused', async () => {
    const { target, timer, interruption } = setup();
    let checked = false;
    await interruption.resumeWithoutEnd(() => {
      checked = true;
      return Promise.resolve(false);
    });
    expect(checked).toBe(false);
    expect(timer.waits).toEqual([]);
    expect(target.calls).toEqual([]);
  });

  it('keeps the microphone muted when the caller had muted it', async () => {
    const { target, timer, interruption } = setup(true);
    await interruption.handle('began');
    const resumed = interruption.resumeWithoutEnd(() => Promise.resolve(false));
    timer.release();
    await resumed;
    expect(interruption.getState().paused).toBe(false);
    expect(target.muted).toBe(true);
    expect(target.calls).toEqual(['route']);
  });

  it('unmutes once for two resumes at the same time', async () => {
    const { target, timer, recovered, interruption } = setup();
    await interruption.handle('began');
    const first = interruption.resumeWithoutEnd(() => Promise.resolve(false));
    const second = interruption.resumeWithoutEnd(() => Promise.resolve(false));
    timer.release();
    await Promise.all([first, second]);
    await flush();
    expect(target.calls).toEqual(['mute', 'route', 'unmute']);
    expect(recovered).toEqual(['foreground']);
  });

  it('reports a call that ended while still paused, once', async () => {
    const { interruption, unrecovered } = setup();
    interruption.reset();
    expect(unrecovered()).toBe(0);
    await interruption.handle('began');
    interruption.reset();
    interruption.reset();
    expect(unrecovered()).toBe(1);
    expect(interruption.getState().paused).toBe(false);
  });

  it('never lets a failing hook break the call', async () => {
    const target = fakeTarget();
    const interruption = new CallInterruption(target, undefined, {
      onRecovered: () => {
        throw new Error('telemetry down');
      },
    });
    await interruption.handle('began');
    await interruption.handle('ended');
    expect(target.calls).toEqual(['mute', 'route', 'unmute']);
  });
});
