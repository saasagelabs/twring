import { afterEach, describe, expect, it } from 'vitest';

import {
  STOP_RETRY_DELAYS_MS,
  cancelPendingStop,
  stopAudioSessionWithRetry,
} from './audio-session';

/** A wait the test releases by hand, recording each delay asked for. */
function manualWait() {
  const waits: { ms: number; release: () => void }[] = [];
  const wait = (ms: number) => new Promise<void>((release) => waits.push({ ms, release }));
  return { waits, wait };
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

afterEach(() => cancelPendingStop());

describe('stopAudioSessionWithRetry', () => {
  it('stops once and reports nothing when iOS lets the session go', async () => {
    let calls = 0;
    const reported: unknown[] = [];
    const { waits, wait } = manualWait();
    await stopAudioSessionWithRetry(
      () => {
        calls += 1;
        return Promise.resolve();
      },
      (error) => reported.push(error),
      wait,
    );
    await flush();
    expect(calls).toBe(1);
    expect(waits).toHaveLength(0);
    expect(reported).toEqual([]);
  });

  it('retries in the background after a refusal and reports nothing once a retry succeeds', async () => {
    const refusal = new Error('Session deactivation failed');
    let calls = 0;
    const reported: unknown[] = [];
    const { waits, wait } = manualWait();
    await stopAudioSessionWithRetry(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(refusal) : Promise.resolve();
      },
      (error) => reported.push(error),
      wait,
    );
    // The hang-up has already finished; the retry waits for the first delay.
    expect(calls).toBe(1);
    await flush();
    expect(waits.map((w) => w.ms)).toEqual([STOP_RETRY_DELAYS_MS[0]]);
    waits[0].release();
    await flush();
    expect(calls).toBe(2);
    expect(reported).toEqual([]);
  });

  it('reports the last refusal once when every retry is refused', async () => {
    let calls = 0;
    const reported: unknown[] = [];
    const { waits, wait } = manualWait();
    await stopAudioSessionWithRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error(`refused ${calls}`));
      },
      (error) => reported.push(error),
      wait,
    );
    for (let i = 0; i < STOP_RETRY_DELAYS_MS.length; i += 1) {
      await flush();
      waits[i].release();
    }
    await flush();
    expect(waits.map((w) => w.ms)).toEqual([...STOP_RETRY_DELAYS_MS]);
    expect(calls).toBe(1 + STOP_RETRY_DELAYS_MS.length);
    expect(reported).toEqual([new Error(`refused ${calls}`)]);
  });

  it('a new call cancels a pending retry, so it never ends the new call audio', async () => {
    let calls = 0;
    const reported: unknown[] = [];
    const { waits, wait } = manualWait();
    await stopAudioSessionWithRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error('Session deactivation failed'));
      },
      (error) => reported.push(error),
      wait,
    );
    await flush();
    cancelPendingStop(); // the next call starts its audio session
    waits[0].release();
    await flush();
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  });
});
