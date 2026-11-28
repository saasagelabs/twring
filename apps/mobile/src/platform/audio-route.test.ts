import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  present: true,
  os: 'android',
  version: 30,
  /** Read-backs per currentCallDevice call; the last one repeats. */
  readBack: [] as (string | null)[],
  modeActive: [] as boolean[],
  calls: [] as string[],
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  devices: ['bluetooth_a2dp', 'speaker', 'earpiece'] as string[] | null,
  /** CordRing: absent, present without otherCallActive (an old build), or present with it. */
  cordRing: 'none',
}));

function next<T>(values: T[], fallback: T): T {
  return (values.length > 1 ? values.shift() : values[0]) ?? fallback;
}

vi.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) =>
    name === 'CordRing'
      ? state.cordRing === 'none'
        ? null
        : state.cordRing === 'new'
          ? { otherCallActive: () => Promise.resolve(true) }
          : {}
      : state.present
        ? {
            listCallDevices: () => state.devices,
            setCommunicationDevice: (output: string) => {
              state.calls.push(`comm:${output}`);
              return true;
            },
            currentCallDevice: () => next(state.readBack, null),
            callModeActive: () => next(state.modeActive, true),
            clearCommunicationDevice: () => state.calls.push('clear'),
            startWatching: () => state.calls.push('start'),
            stopWatching: () => state.calls.push('stop'),
            addListener: (event: string, listener: (event: unknown) => void) => {
              const set = state.listeners.get(event) ?? new Set();
              set.add(listener);
              state.listeners.set(event, set);
              return { remove: () => set.delete(listener) };
            },
          }
        : null,
}));
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.os;
    },
    get Version() {
      return state.version;
    },
  },
}));
vi.mock('@livekit/react-native', () => ({
  AudioSession: {
    getAudioOutputs: () => {
      state.calls.push('livekit:list');
      return Promise.resolve(['bluetooth', 'speaker', 'earpiece']);
    },
    selectAudioOutput: (output: string) => {
      state.calls.push(`livekit:${output}`);
      return Promise.resolve();
    },
    setAppleAudioConfiguration: () => {
      state.calls.push('apple');
      return Promise.resolve();
    },
  },
}));

vi.mock('@/call/audio-routes', () => import('../call/audio-routes'));
vi.mock('@/call/call-interruption', () => import('../call/call-interruption'));

function emit(event: string, payload: unknown) {
  for (const listener of state.listeners.get(event) ?? []) listener(payload);
}

beforeEach(() => {
  state.present = true;
  state.os = 'android';
  state.version = 30;
  state.readBack = [];
  state.modeActive = [];
  state.calls = [];
  state.listeners = new Map();
  state.devices = ['bluetooth_a2dp', 'speaker', 'earpiece'];
  state.cordRing = 'none';
  vi.resetModules();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('audio route platform', () => {
  it('checks for another phone call on iOS only, and only when CordRing can', async () => {
    state.os = 'ios';
    state.cordRing = 'new';
    let mod = await import('./audio-route');
    await expect(mod.callInterruptionPlatform.otherCallActive!()).resolves.toBe(true);

    vi.resetModules();
    state.cordRing = 'old';
    mod = await import('./audio-route');
    expect(mod.callInterruptionPlatform.otherCallActive).toBeUndefined();

    vi.resetModules();
    state.cordRing = 'none';
    mod = await import('./audio-route');
    expect(mod.callInterruptionPlatform.otherCallActive).toBeUndefined();

    vi.resetModules();
    state.os = 'android';
    state.cordRing = 'new';
    mod = await import('./audio-route');
    expect(mod.callInterruptionPlatform.otherCallActive).toBeUndefined();
  });

  it('falls back to LiveKit and offers no watchers when the native module is missing', async () => {
    state.present = false;
    const mod = await import('./audio-route');
    expect(mod.audioRoutePlatform.watch).toBeUndefined();
    expect(mod.callInterruptionPlatform.watch).toBeUndefined();
    expect(await mod.audioRoutePlatform.list()).toEqual(['bluetooth', 'speaker', 'earpiece']);
    await expect(mod.audioRoutePlatform.select('speaker')).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual(['livekit:list', 'livekit:speaker']);
  });

  it('lists call devices natively on Android, leaving A2DP-only out', async () => {
    const mod = await import('./audio-route');
    expect(await mod.audioRoutePlatform.list()).toEqual(['speaker', 'earpiece']);
    state.devices = null;
    expect(await mod.audioRoutePlatform.list()).toEqual(['bluetooth', 'speaker', 'earpiece']);
  });

  it('below Android 12 selects through LiveKit, then the native set', async () => {
    const mod = await import('./audio-route');
    await expect(mod.audioRoutePlatform.select('earpiece')).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual(['livekit:earpiece', 'comm:earpiece']);
    await expect(mod.audioRoutePlatform.current!()).resolves.toBeNull();
  });

  it('on iOS keeps the session-mode calls and reports success', async () => {
    state.os = 'ios';
    const mod = await import('./audio-route');
    await expect(mod.audioRoutePlatform.select('speaker')).resolves.toEqual({ ok: true });
    expect(state.calls).toEqual(['apple', 'livekit:default']);
    await expect(mod.audioRoutePlatform.current!()).resolves.toBeNull();
  });

  it('shares one native registration and removes every listener, across consecutive calls', async () => {
    const mod = await import('./audio-route');
    for (let call = 0; call < 2; call += 1) {
      const routes: number[] = [];
      const phases: string[] = [];
      const offRoutes = mod.audioRoutePlatform.watch!(() => routes.push(1));
      const offPhases = mod.callInterruptionPlatform.watch!((phase) => phases.push(phase));
      emit('onRoutesChanged', {});
      emit('onInterruption', { phase: 'began' });
      expect(routes).toEqual([1]);
      expect(phases).toEqual(['began']);
      offRoutes();
      offRoutes();
      offPhases();
      emit('onRoutesChanged', {});
      emit('onInterruption', { phase: 'ended' });
      expect(routes).toEqual([1]);
      expect(phases).toEqual(['began']);
      expect(state.listeners.get('onRoutesChanged')?.size).toBe(0);
      expect(state.listeners.get('onInterruption')?.size).toBe(0);
    }
    expect(state.calls).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('on iOS lists through LiveKit even with the module present (it only emits events)', async () => {
    state.os = 'ios';
    const mod = await import('./audio-route');
    expect(await mod.audioRoutePlatform.list()).toEqual(['bluetooth', 'speaker', 'earpiece']);
    expect(mod.audioRoutePlatform.watch).toBeDefined();
  });

  describe('Android 12+', () => {
    beforeEach(() => {
      state.version = 31;
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function settle<T>(promise: Promise<T>): Promise<T> {
      await vi.advanceTimersByTimeAsync(5000);
      return promise;
    }

    it('lists natively only, and a null list is an error, not a LiveKit fallback', async () => {
      const mod = await import('./audio-route');
      expect(await mod.audioRoutePlatform.list()).toEqual(['speaker', 'earpiece']);
      state.devices = null;
      await expect(mod.audioRoutePlatform.list()).rejects.toThrow();
      expect(state.calls).toEqual([]);
    });

    it('a null read-back is a failure, with no LiveKit call', async () => {
      state.readBack = [null];
      const mod = await import('./audio-route');
      const result = await settle(mod.audioRoutePlatform.select('earpiece'));
      expect(result).toEqual({ ok: false, actual: null });
      expect(state.calls.some((call) => call.startsWith('livekit'))).toBe(false);
    });

    it('speaker stuck on bluetooth fails after one clear and retry', async () => {
      state.readBack = ['bluetooth'];
      const mod = await import('./audio-route');
      const result = await settle(mod.audioRoutePlatform.select('speaker'));
      expect(result).toEqual({ ok: false, actual: 'bluetooth' });
      expect(state.calls).toEqual(['comm:speaker', 'clear', 'comm:speaker']);
    });

    it('speaker confirmed at once needs no retry', async () => {
      state.readBack = ['speaker'];
      const mod = await import('./audio-route');
      await expect(settle(mod.audioRoutePlatform.select('speaker'))).resolves.toEqual({
        ok: true,
      });
      expect(state.calls).toEqual(['comm:speaker']);
    });

    it('bluetooth confirmed at 1.5 s is ok with no clear or second request', async () => {
      state.readBack = [...Array<string>(30).fill('earpiece'), 'bluetooth'];
      const mod = await import('./audio-route');
      const pending = mod.audioRoutePlatform.select('bluetooth');
      await vi.advanceTimersByTimeAsync(1400);
      expect(state.calls).toEqual(['comm:bluetooth']);
      await expect(settle(pending)).resolves.toEqual({ ok: true });
      expect(state.calls).toEqual(['comm:bluetooth']);
    });

    it('waits for communication mode before the set', async () => {
      state.modeActive = [false, false, false, true];
      state.readBack = ['earpiece'];
      const mod = await import('./audio-route');
      const pending = mod.audioRoutePlatform.select('earpiece');
      await vi.advanceTimersByTimeAsync(100);
      expect(state.calls).toEqual([]);
      await expect(settle(pending)).resolves.toEqual({ ok: true });
      expect(state.calls).toEqual(['comm:earpiece']);
    });

    it('does not write the device when communication mode never comes', async () => {
      state.modeActive = Array<boolean>(30).fill(false);
      state.readBack = ['earpiece'];
      const mod = await import('./audio-route');
      const pending = mod.audioRoutePlatform.select('speaker');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(settle(pending)).resolves.toEqual({ ok: false, actual: 'earpiece' });
      expect(state.calls).toEqual([]);
    });

    it('an unknown native type reads back as null', async () => {
      state.readBack = ['something_else'];
      const mod = await import('./audio-route');
      await expect(mod.audioRoutePlatform.current!()).resolves.toBeNull();
      state.readBack = ['headset'];
      await expect(mod.audioRoutePlatform.current!()).resolves.toBe('headset');
    });

    it('release clears the communication device', async () => {
      const mod = await import('./audio-route');
      await mod.audioRoutePlatform.release!();
      expect(state.calls).toEqual(['clear']);
    });
  });
});
