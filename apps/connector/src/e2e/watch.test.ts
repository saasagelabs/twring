import { describe, expect, it, vi } from 'vitest';

import { SEALED_CHAT_FEATURE } from '@twring/contracts';

import { ensureDeviceKey, type E2eConfig } from './keys';
import { baseConfig } from './test-fixtures';
import { helloFeatures } from './turn';
import { watchPairing } from './watch';

const unpaired = ensureDeviceKey(baseConfig).config.e2e!;
const paired: E2eConfig = {
  ...unpaired,
  devices: [
    {
      id: `dev_${'a'.repeat(20)}`,
      kind: 'phone',
      name: 'Pixel',
      public_key: `${'a'.repeat(42)}A`,
      verified_at: '2026-11-26T00:00:00.000Z',
    },
  ],
};

function setup(start: E2eConfig | undefined, saved: () => E2eConfig | undefined) {
  let e2e = start;
  let tick: (() => void) | undefined;
  const hellos: string[][] = [];
  const clearInterval = vi.fn();
  const watch = watchPairing({
    read: () => Promise.resolve(saved()),
    current: () => e2e,
    apply: (fresh) => (e2e = fresh),
    rehello: () => hellos.push(helloFeatures(e2e)),
    setInterval: (fn) => {
      tick = fn;
      return 'timer';
    },
    clearInterval,
  });
  const runTick = async () => {
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { watch, hellos, clearInterval, runTick, hasTimer: () => tick !== undefined };
}

describe('watchPairing', () => {
  it('says hello with sealed_chat within one tick once the config gains a phone, then stops', async () => {
    let saved = unpaired;
    const t = setup(unpaired, () => saved);
    await t.runTick();
    expect(t.hellos).toEqual([]);
    saved = paired;
    await t.runTick();
    expect(t.hellos).toHaveLength(1);
    expect(t.hellos[0]).toContain(SEALED_CHAT_FEATURE);
    expect(t.clearInterval).toHaveBeenCalledWith('timer');
  });

  it('says nothing when the saved settings did not change', async () => {
    const t = setup(unpaired, () => unpaired);
    await t.runTick();
    await t.watch.check();
    expect(t.hellos).toEqual([]);
    expect(t.clearInterval).not.toHaveBeenCalled();
  });

  it('notices a phone paired after a reset (no settings at start)', async () => {
    const saved: { e2e?: E2eConfig } = {};
    const t = setup(undefined, () => saved.e2e);
    await t.runTick();
    saved.e2e = paired;
    await t.watch.check();
    expect(t.hellos[0]).toContain(SEALED_CHAT_FEATURE);
  });

  it('starts no timer when a phone is already paired, and stops on close', async () => {
    expect(setup(paired, () => paired).hasTimer()).toBe(false);
    const t = setup(unpaired, () => paired);
    t.watch.stop();
    expect(t.clearInterval).toHaveBeenCalledWith('timer');
    await t.watch.check();
    expect(t.hellos).toEqual([]);
  });
});
