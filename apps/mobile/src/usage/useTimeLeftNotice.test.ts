import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactModule from 'react';

// A tiny hook runner: state, refs and effects (with deps and cleanup) kept across renders.
const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  effects: [] as { deps?: unknown[]; cleanup?: () => void }[],
  cursor: 0,
  effectCursor: 0,
  pending: [] as (() => void)[],
  usage: vi.fn(),
  haptic: vi.fn(() => Promise.resolve()),
  announce: vi.fn(),
  api: true,
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = initial;
      return [
        h.slots[i],
        (next: unknown) => {
          h.slots[i] = next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = { current: initial };
      return h.slots[i];
    },
    useEffect: (fn: () => (() => void) | void, deps?: unknown[]) => {
      const i = h.effectCursor++;
      const prev = h.effects[i];
      const changed =
        prev === undefined ||
        deps === undefined ||
        deps.some((d, k) => !Object.is(d, prev.deps?.[k]));
      if (!changed) return;
      h.pending.push(() => {
        prev?.cleanup?.();
        const cleanup = fn();
        h.effects[i] = { deps, ...(cleanup && { cleanup }) };
      });
    },
  };
});
vi.mock('react-native', () => ({ AccessibilityInfo: { announceForAccessibility: h.announce } }));
vi.mock('expo-haptics', () => ({
  impactAsync: h.haptic,
  ImpactFeedbackStyle: { Light: 'light' },
}));
vi.mock('@/api', () => ({ twringApi: () => (h.api ? { usage: h.usage } : undefined) }));

import { useTimeLeftNotice } from './useTimeLeftNotice';

function render(connectedAt: number | undefined, now: number): string | undefined {
  h.cursor = 0;
  h.effectCursor = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- a test harness renders the hook directly
  const out = useTimeLeftNotice(connectedAt, now);
  const run = h.pending.splice(0);
  run.forEach((f) => f());
  return out;
}
function unmount(): void {
  h.effects.forEach((e) => e.cleanup?.());
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const usage = (used: number, allowed: number | null) => ({
  day: '2026-11-23',
  resets_at: '2026-11-24T00:00:00.000Z',
  call_seconds_used: used,
  call_seconds_allowed: allowed,
  calls_used: 1,
  calls_allowed: null,
});

beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.pending = [];
  h.api = true;
  h.usage.mockReset();
  h.haptic.mockClear();
  h.announce.mockClear();
});

describe('useTimeLeftNotice', () => {
  it('fetches once per connect, shows each line once with one haptic and one announcement', async () => {
    h.usage.mockResolvedValue(usage(600 - 330, 600)); // 330 s left at connect
    expect(render(undefined, 0)).toBeUndefined();
    expect(h.usage).not.toHaveBeenCalled();
    render(1000, 1000);
    await flush();
    expect(render(1000, 2000)).toBeUndefined();
    const five = 1000 + 30_000;
    for (let t = five; t < five + 5000; t += 1000) {
      expect(render(1000, t)).toBe('About 5 minutes of calling left today.');
    }
    expect(h.haptic).toHaveBeenCalledTimes(1);
    expect(h.announce).toHaveBeenCalledTimes(1);
    const one = 1000 + 270_000;
    for (let t = one; t < one + 5000; t += 1000) {
      expect(render(1000, t)).toBe('About 1 minute of calling left today.');
    }
    expect(h.haptic).toHaveBeenCalledTimes(2);
    expect(h.announce).toHaveBeenLastCalledWith('About 1 minute of calling left today.');
    expect(h.usage).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for unlimited calling, a failed fetch, or no api', async () => {
    h.usage.mockResolvedValue(usage(0, null));
    render(1, 1);
    await flush();
    expect(render(1, 10_000_000)).toBeUndefined();

    h.slots = [];
    h.effects = [];
    h.usage.mockRejectedValue(new Error('offline'));
    render(1, 1);
    await flush();
    expect(render(1, 10_000_000)).toBeUndefined();

    h.slots = [];
    h.effects = [];
    h.api = false;
    expect(render(1, 10_000_000)).toBeUndefined();
    expect(h.haptic).not.toHaveBeenCalled();
  });

  it('ignores a fetch that resolves after unmount', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    h.usage.mockReturnValue(new Promise((r) => (resolve = r)));
    render(1, 1);
    unmount();
    resolve(usage(590, 600));
    await flush();
    expect(h.slots.some((s) => s != null && typeof s === 'object' && 'at' in s)).toBe(false);
  });

  it('a slow fetch shows the right line as soon as it lands', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    h.usage.mockReturnValue(new Promise((r) => (resolve = r)));
    render(0, 0);
    expect(render(0, 120_000)).toBeUndefined();
    resolve(usage(0, 150)); // 150 s left at connect, 120 s gone: 30 s left
    await flush();
    expect(render(0, 121_000)).toBe('About 1 minute of calling left today.');
    expect(h.haptic).toHaveBeenCalledTimes(1);
  });
});
