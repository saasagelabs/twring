import { describe, expect, it, vi } from 'vitest';

import {
  applyListenSpeed,
  clampSeek,
  createListenSpeedStore,
  listenStatusHandler,
  nextListenSpeed,
  progressFraction,
  progressText,
} from './listen-progress';

describe('seek', () => {
  it('clamps to the audio and does nothing before the length is known', () => {
    expect(clampSeek(12, 40)).toBe(12);
    expect(clampSeek(55, 40)).toBe(40);
    expect(clampSeek(-3, 40)).toBe(0);
    expect(clampSeek(5, 0)).toBeUndefined();
    expect(clampSeek(5, Number.NaN)).toBeUndefined();
    expect(clampSeek(Number.NaN, 40)).toBeUndefined();
  });
});

describe('progress', () => {
  it('says the length honestly: indeterminate while unknown', () => {
    expect(progressText({ position: 12, duration: 40 })).toBe('0:12 of 0:40');
    expect(progressFraction({ position: 10, duration: 40 })).toBe(0.25);
    expect(progressText({ position: 3, duration: 0 })).toBe('0:03, length not known yet');
    expect(progressFraction({ position: 3, duration: 0 })).toBeUndefined();
  });
});

describe('speed', () => {
  it('cycles 1x, 1.5x, 2x, persists the choice and applies it with pitch kept', async () => {
    expect(nextListenSpeed(1)).toBe(1.5);
    expect(nextListenSpeed(1.5)).toBe(2);
    expect(nextListenSpeed(2)).toBe(1);
    const saved = new Map<string, string>();
    const storage = {
      getItemAsync: vi.fn((key: string) => Promise.resolve(saved.get(key) ?? null)),
      setItemAsync: vi.fn((key: string, value: string) => {
        saved.set(key, value);
        return Promise.resolve();
      }),
    };
    const store = createListenSpeedStore(() => storage);
    expect(await store.load()).toBe(1);
    await store.set(1.5);
    expect(store.current()).toBe(1.5);
    const fresh = createListenSpeedStore(() => storage);
    expect(await fresh.load()).toBe(1.5);
    const player = { setPlaybackRate: vi.fn() };
    applyListenSpeed(player, fresh.current());
    expect(player.setPlaybackRate).toHaveBeenCalledWith(1.5, 'high');
  });

  it('falls back to 1x on a broken or unreadable saved value', async () => {
    const broken = createListenSpeedStore(() => ({
      getItemAsync: () => Promise.resolve('7'),
      setItemAsync: () => Promise.resolve(),
    }));
    expect(await broken.load()).toBe(1);
    const failing = createListenSpeedStore(() => ({
      getItemAsync: () => Promise.reject(new Error('locked')),
      setItemAsync: () => Promise.reject(new Error('locked')),
    }));
    expect(await failing.load()).toBe(1);
    await expect(failing.set(2)).resolves.toBeUndefined();
  });
});

describe('status handler', () => {
  const status = {
    error: null,
    didJustFinish: false,
    isLoaded: true,
    playing: true,
    currentTime: 4,
    duration: 0,
  };

  it('reports progress, finish and errors while current, nothing after unmount', () => {
    let live = true;
    const handlers = {
      isCurrent: () => live,
      onProgress: vi.fn(),
      onPlaying: vi.fn(),
      onFinish: vi.fn(),
      onError: vi.fn(),
    };
    const handle = listenStatusHandler(handlers);
    handle(status);
    expect(handlers.onProgress).toHaveBeenCalledWith({ position: 4, duration: 0 });
    expect(handlers.onPlaying).toHaveBeenCalledTimes(1);
    handle({ ...status, error: 'stream dropped' });
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    live = false;
    handle(status);
    handle({ ...status, didJustFinish: true });
    handle({ ...status, error: 'late' });
    expect(handlers.onProgress).toHaveBeenCalledTimes(1);
    expect(handlers.onFinish).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledTimes(1);
  });
});
