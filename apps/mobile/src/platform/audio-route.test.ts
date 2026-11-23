import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  present: true,
  os: 'android',
  calls: [] as string[],
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  devices: ['bluetooth_a2dp', 'speaker', 'earpiece'] as string[] | null,
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () =>
    state.present
      ? {
          listCallDevices: () => state.devices,
          setCommunicationDevice: (output: string) => {
            state.calls.push(`comm:${output}`);
            return true;
          },
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
  },
}));
vi.mock('@livekit/react-native', () => ({
  AudioSession: {
    getAudioOutputs: () => Promise.resolve(['bluetooth', 'speaker', 'earpiece']),
    selectAudioOutput: (output: string) => {
      state.calls.push(`livekit:${output}`);
      return Promise.resolve();
    },
    setAppleAudioConfiguration: () => Promise.resolve(),
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
  state.calls = [];
  state.listeners = new Map();
  state.devices = ['bluetooth_a2dp', 'speaker', 'earpiece'];
  vi.resetModules();
});

describe('audio route platform', () => {
  it('falls back to LiveKit and offers no watchers when the native module is missing', async () => {
    state.present = false;
    const mod = await import('./audio-route');
    expect(mod.audioRoutePlatform.watch).toBeUndefined();
    expect(mod.callInterruptionPlatform.watch).toBeUndefined();
    expect(await mod.audioRoutePlatform.list()).toEqual(['bluetooth', 'speaker', 'earpiece']);
    await expect(mod.audioRoutePlatform.select('speaker')).resolves.toBeUndefined();
    expect(state.calls).toEqual(['livekit:speaker']);
  });

  it('lists call devices natively on Android, leaving A2DP-only out', async () => {
    const mod = await import('./audio-route');
    expect(await mod.audioRoutePlatform.list()).toEqual(['speaker', 'earpiece']);
    state.devices = null;
    expect(await mod.audioRoutePlatform.list()).toEqual(['bluetooth', 'speaker', 'earpiece']);
  });

  it('pins the communication device after LiveKit selects on Android', async () => {
    const mod = await import('./audio-route');
    await mod.audioRoutePlatform.select('earpiece');
    expect(state.calls).toEqual(['livekit:earpiece', 'comm:earpiece']);
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
});
