import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../platform/secure-store', () => {
  const data = new Map<string, string>();
  return {
    secureStore: {
      getItemAsync: (k: string) => Promise.resolve(data.get(k) ?? null),
      setItemAsync: (k: string, v: string) => Promise.resolve(void data.set(k, v)),
      deleteItemAsync: (k: string) => Promise.resolve(void data.delete(k)),
    },
  };
});
vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));
const fakeEnv = vi.hoisted(() => ({
  mobileEnv: { ok: true, env: { CORD_ENV: 'development', API_BASE_URL: 'http://build.example' } },
}));
vi.mock('../config/env', () => fakeEnv);
vi.mock('@/config/env', () => fakeEnv);
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/auth', () => ({ apiAuth: () => undefined }));

import { twringApi } from '../api';
import { activeServerUrl, downloadsServerUrl, onActiveServerChanged } from './active';
import { profileStore, type SelfhostProfile } from './profiles';

const home: SelfhostProfile = {
  kind: 'selfhost',
  serverId: 'srv_1',
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'p1', displayName: 'Ann', role: 'admin' },
  deviceId: 'dev1',
  audio: 'own',
};

describe('active server', () => {
  beforeEach(async () => {
    await profileStore.activate('hosted');
  });

  it('uses the build address for hosted and follows activate', async () => {
    expect(activeServerUrl()).toBe('http://build.example');
    await profileStore.save(home, { deviceToken: 't', sealKey: 's' });
    await profileStore.activate('srv_1');
    expect(activeServerUrl()).toBe('https://home.example.com');
    await profileStore.activate('hosted');
    expect(activeServerUrl()).toBe('http://build.example');
  });

  it('downloads always come from Twring, whichever server is active', async () => {
    expect(downloadsServerUrl()).toBe('http://build.example');
    await profileStore.save(home, { deviceToken: 't', sealKey: 's' });
    await profileStore.activate('srv_1');
    expect(downloadsServerUrl()).toBe('http://build.example');
  });

  it('calls listeners on a switch', async () => {
    const listener = vi.fn();
    const off = onActiveServerChanged(listener);
    await profileStore.save(home, { deviceToken: 't', sealKey: 's' });
    await profileStore.activate('srv_1');
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('rebuilds the API client for the new address', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (input: unknown) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    await profileStore.save(home, { deviceToken: 't', sealKey: 's' });
    const before = twringApi();
    await profileStore.activate('srv_1');
    const after = twringApi();
    expect(after).not.toBe(before);
    await after!.listAgents().catch(() => undefined);
    expect(urls.some((u) => u.startsWith('https://home.example.com'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
