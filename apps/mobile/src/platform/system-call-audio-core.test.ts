import { describe, expect, it } from 'vitest';

import { createSystemCallAudio } from './system-call-audio-core';

function setup(state: { owned: boolean; active: boolean }, failSet = false) {
  const calls: boolean[] = [];
  const listeners: { activated?: () => void; released?: () => void } = {};
  const audio = createSystemCallAudio({
    state: () => Promise.resolve(state),
    setEngineAllowed: (allowed) => {
      calls.push(allowed);
      return failSet ? Promise.reject(new Error('refused')) : Promise.resolve();
    },
    onActivated: (listener) => {
      listeners.activated = listener;
    },
    onReleased: (listener) => {
      listeners.released = listener;
    },
  });
  return { audio, calls, listeners };
}

describe('system call audio', () => {
  it('leaves an in-app call alone', async () => {
    const { audio, calls } = setup({ owned: false, active: false });
    expect(await audio.prepare()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('holds the engine until CallKit activates the session, then allows it once', async () => {
    const { audio, calls, listeners } = setup({ owned: true, active: false });
    expect(await audio.prepare()).toBe(true);
    expect(calls).toEqual([false]);
    listeners.activated?.();
    listeners.activated?.();
    expect(calls).toEqual([false, true]);
  });

  it('does not hold when the session is already active', async () => {
    const { audio, calls } = setup({ owned: true, active: true });
    expect(await audio.prepare()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('allows the engine again when the system call ends before activation', async () => {
    const { audio, calls, listeners } = setup({ owned: true, active: false });
    await audio.prepare();
    listeners.released?.();
    expect(calls).toEqual([false, true]);
    listeners.released?.();
    expect(calls).toEqual([false, true]);
  });

  it('still reports ownership when the hold is refused, and restores nothing it did not hold', async () => {
    const { audio, calls, listeners } = setup({ owned: true, active: false }, true);
    expect(await audio.prepare()).toBe(true);
    listeners.activated?.();
    expect(calls).toEqual([false]);
  });

  it('treats a failing state read as no system call', async () => {
    const audio = createSystemCallAudio({
      state: () => Promise.reject(new Error('old module')),
      setEngineAllowed: () => Promise.resolve(),
      onActivated: () => undefined,
      onReleased: () => undefined,
    });
    expect(await audio.prepare()).toBe(false);
  });
});
