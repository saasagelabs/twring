import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Milestone 8 verifier: the Android CallBackgroundService against mocked native seams. */
const rn = vi.hoisted(() => ({
  version: 34,
  granted: false,
  checkThrows: false,
  requestThrows: false,
  log: [] as string[],
}));
const nativeModule = vi.hoisted(() => ({
  present: true,
  startThrows: false,
  log: [] as string[],
  listeners: [] as (() => void)[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get Version() {
      return rn.version;
    },
  },
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
    check: () => {
      rn.log.push('check');
      return rn.checkThrows
        ? Promise.reject(new Error('check failed'))
        : Promise.resolve(rn.granted);
    },
    request: () => {
      rn.log.push('request');
      return rn.requestThrows
        ? Promise.reject(new Error('no activity'))
        : Promise.resolve('denied');
    },
  },
}));

vi.mock('expo', () => ({
  requireOptionalNativeModule: () =>
    nativeModule.present
      ? {
          start: (title: string, text: string) => {
            nativeModule.log.push(`start:${title}:${text}`);
            return nativeModule.startThrows
              ? Promise.reject(new Error('ERR_CALL_SERVICE_START'))
              : Promise.resolve();
          },
          stop: () => {
            nativeModule.log.push('stop');
            return Promise.resolve();
          },
          setCallScreen: (active: boolean) => nativeModule.log.push(`screen:${active}`),
          addListener: (_event: string, listener: () => void) => {
            nativeModule.listeners.push(listener);
            return {
              remove: () => {
                nativeModule.listeners = nativeModule.listeners.filter((l) => l !== listener);
              },
            };
          },
        }
      : null,
}));

async function load() {
  vi.resetModules();
  return import('./call-service.android');
}

beforeEach(() => {
  Object.assign(rn, {
    version: 34,
    granted: false,
    checkThrows: false,
    requestThrows: false,
    log: [],
  });
  Object.assign(nativeModule, { present: true, startThrows: false, log: [], listeners: [] });
});

describe('Android call service: notification permission', () => {
  it('asks once per app run, even after a denial', async () => {
    const { callBackgroundService } = await load();
    await callBackgroundService.prepare();
    await callBackgroundService.prepare();
    await callBackgroundService.prepare();
    expect(rn.log).toEqual(['check', 'request']);
  });

  it('does not prompt when already granted', async () => {
    rn.granted = true;
    const { callBackgroundService } = await load();
    await callBackgroundService.prepare();
    expect(rn.log).toEqual(['check']);
  });

  it('does not ask below Android 13 (API 33)', async () => {
    rn.version = 32;
    const { callBackgroundService } = await load();
    await callBackgroundService.prepare();
    expect(rn.log).toEqual([]);
  });

  it('never rejects when the permission APIs throw', async () => {
    rn.checkThrows = true;
    const first = await load();
    await expect(first.callBackgroundService.prepare()).resolves.toBeUndefined();
    rn.checkThrows = false;
    rn.requestThrows = true;
    const second = await load();
    await expect(second.callBackgroundService.prepare()).resolves.toBeUndefined();
  });

  it('two concurrent prepares (double tap) prompt only once', async () => {
    const { callBackgroundService } = await load();
    await Promise.all([callBackgroundService.prepare(), callBackgroundService.prepare()]);
    expect(rn.log.filter((entry) => entry === 'request')).toHaveLength(1);
  });
});

describe('Android call service: start/stop/End', () => {
  it('forwards call screen state to the native module', async () => {
    const { callBackgroundService } = await load();
    callBackgroundService.setCallScreen(true);
    callBackgroundService.setCallScreen(false);
    expect(nativeModule.log).toEqual(['screen:true', 'screen:false']);
  });
  it('starts with the agent name and stops idempotently', async () => {
    const { callBackgroundService } = await load();
    await callBackgroundService.start({ agentName: 'Ada' });
    await callBackgroundService.stop();
    await callBackgroundService.stop();
    expect(nativeModule.log).toEqual(['start:Twring call in progress:Ada', 'stop', 'stop']);
  });

  it('a refused start rejects (so the controller logs background_start_failed)', async () => {
    nativeModule.startThrows = true;
    const { callBackgroundService } = await load();
    await expect(callBackgroundService.start({ agentName: 'Ada' })).rejects.toThrow();
  });

  it('without the native module: start rejects, stop and End subscription are no-ops', async () => {
    nativeModule.present = false;
    const { callBackgroundService, onBackgroundEndPressed } = await load();
    await expect(callBackgroundService.start({ agentName: 'Ada' })).rejects.toThrow(
      'call service module missing',
    );
    await expect(callBackgroundService.stop()).resolves.toBeUndefined();
    expect(() => onBackgroundEndPressed(() => undefined)()).not.toThrow();
  });

  it('forwards the notification End action and unsubscribes cleanly', async () => {
    const { onBackgroundEndPressed } = await load();
    let presses = 0;
    const unsubscribe = onBackgroundEndPressed(() => (presses += 1));
    nativeModule.listeners.forEach((listener) => listener());
    unsubscribe();
    expect(nativeModule.listeners).toEqual([]);
    expect(presses).toBe(1);
  });
});
