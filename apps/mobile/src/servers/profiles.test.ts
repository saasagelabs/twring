import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform/secure-store', () => ({ secureStore: {} }));

import type { SecureKeyValue } from '../auth/storage';
import { createProfileStore, type SelfhostProfile } from './profiles';

function fakeStorage(): SecureKeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItemAsync: (k) => Promise.resolve(data.get(k) ?? null),
    setItemAsync: (k, v) => Promise.resolve(void data.set(k, v)),
    deleteItemAsync: (k) => Promise.resolve(void data.delete(k)),
  };
}

const profile = (serverId = 'srv_1'): SelfhostProfile => ({
  kind: 'selfhost',
  serverId,
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'p1', displayName: 'Ann', role: 'admin' },
  deviceId: 'dev1',
  audio: 'own',
});
const secrets = { deviceToken: 'tok', sealKey: 'seal' };

describe('profile store', () => {
  it('starts hosted', async () => {
    const store = createProfileStore(fakeStorage());
    await store.load();
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(store.list()).toEqual([]);
  });

  it('restores a saved, activated profile in a new store', async () => {
    const storage = fakeStorage();
    const a = createProfileStore(storage);
    await a.load();
    await a.save(profile(), secrets);
    await a.activate('srv_1');
    const b = createProfileStore(storage);
    await b.load();
    expect(b.active()).toEqual(profile());
    expect(await b.secrets('srv_1')).toEqual(secrets);
  });

  it('removing the active profile falls back to hosted and deletes both secrets', async () => {
    const storage = fakeStorage();
    const store = createProfileStore(storage);
    await store.load();
    await store.save(profile(), secrets);
    await store.activate('srv_1');
    await store.remove('srv_1');
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(await store.secrets('srv_1')).toBeUndefined();
    expect(storage.data.has('twring.server.srv_1.token')).toBe(false);
    expect(storage.data.has('twring.server.srv_1.seal')).toBe(false);
    const again = createProfileStore(storage);
    await again.load();
    expect(again.active()).toEqual({ kind: 'hosted' });
  });

  it('loads corrupt data as hosted without throwing or logging', async () => {
    const storage = fakeStorage();
    storage.data.set('twring.servers.count', '1');
    storage.data.set('twring.servers.0', '{not json SECRETTEXT');
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const store = createProfileStore(storage);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(store.list()).toEqual([]);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('loads hosted when the active id is not in the list', async () => {
    const storage = fakeStorage();
    storage.data.set('twring.servers.active', 'srv_ghost');
    const store = createProfileStore(storage);
    await store.load();
    expect(store.active()).toEqual({ kind: 'hosted' });
  });

  it('notifies once per change and stops after unsubscribe', async () => {
    const store = createProfileStore(fakeStorage());
    await store.load();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    await store.save(profile(), secrets);
    expect(listener).toHaveBeenCalledTimes(1);
    await store.activate('srv_1');
    expect(listener).toHaveBeenCalledTimes(2);
    await store.activate('srv_1');
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    await store.activate('hosted');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('load emits nothing when nothing changed, and once for a saved active server', async () => {
    const storage = fakeStorage();
    const fresh = createProfileStore(storage);
    const quiet = vi.fn();
    fresh.subscribe(quiet);
    await fresh.load();
    expect(quiet).not.toHaveBeenCalled();
    await fresh.save(profile(), secrets);
    await fresh.activate('srv_1');
    const reloaded = createProfileStore(storage);
    const once = vi.fn();
    reloaded.subscribe(once);
    await reloaded.load();
    expect(once).toHaveBeenCalledTimes(1);
  });
});
