import { describe, expect, it } from 'vitest';

import { DEVICE_ID_KEY, loadDeviceId } from './device-id';

function store(items = new Map<string, string>(), readFails = false) {
  return {
    items,
    getItemAsync: (key: string) =>
      readFails
        ? Promise.reject(new Error('User interaction is not allowed.'))
        : Promise.resolve(items.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      items.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      items.delete(key);
      return Promise.resolve();
    },
  };
}

describe('loadDeviceId', () => {
  it('keeps the stored id', async () => {
    const s = store(new Map([[DEVICE_ID_KEY, 'ios-abc']]));
    expect(await loadDeviceId(s, 'ios')).toBe('ios-abc');
  });

  it('makes and saves one when there is none', async () => {
    const s = store();
    const id = await loadDeviceId(s, 'android');
    expect(id).toMatch(/^android-[0-9a-f]{32}$/);
    expect(s.items.get(DEVICE_ID_KEY)).toBe(id);
  });

  it('an unreadable keychain (locked phone) fails instead of making up a second id', async () => {
    const s = store(new Map([[DEVICE_ID_KEY, 'ios-abc']]), true);
    await expect(loadDeviceId(s, 'ios')).rejects.toThrow();
    expect(s.items.get(DEVICE_ID_KEY)).toBe('ios-abc');
  });
});
