import { describe, expect, it } from 'vitest';

import { backgroundReadable, migrateKeychainOnce } from './keychain';

const OPTION = { keychainAccessible: 7 };

function nativeStore(items = new Map<string, string>()) {
  const log: string[] = [];
  return {
    items,
    log,
    getItemAsync(key: string) {
      log.push(`get ${key}`);
      return Promise.resolve(items.get(key) ?? null);
    },
    setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }) {
      log.push(`set ${key} ${String(options?.keychainAccessible)}`);
      items.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync(key: string) {
      log.push(`delete ${key}`);
      items.delete(key);
      return Promise.resolve();
    },
  };
}

describe('backgroundReadable', () => {
  it('saves fresh with the after-first-unlock option (an update would keep the old one)', async () => {
    const native = nativeStore();
    await backgroundReadable(native, OPTION).setItemAsync('k', 'v');
    expect(native.log).toEqual(['delete k', 'set k 7']);
    expect(native.items.get('k')).toBe('v');
  });
});

describe('migrateKeychainOnce', () => {
  it('re-saves each stored key and the session once, then marks it done', async () => {
    const native = nativeStore(new Map([['a', '1']]));
    const store = backgroundReadable(native, OPTION);
    const resaved: string[] = [];
    const run = () =>
      migrateKeychainOnce({
        store,
        keys: ['a', 'missing'],
        resaveSession: () => {
          resaved.push('session');
          return Promise.resolve();
        },
      });
    await run();
    expect(native.items.get('a')).toBe('1');
    expect(native.log).toContain('set a 7');
    expect(native.log).not.toContain('set missing 7');
    expect(resaved).toEqual(['session']);
    native.log.length = 0;
    await run();
    expect(resaved).toEqual(['session']);
    expect(native.log.filter((line) => line.startsWith('set'))).toEqual([]);
  });

  it('a locked phone (reads fail) leaves it for the next launch', async () => {
    const native = nativeStore(new Map([['a', '1']]));
    native.getItemAsync = () => Promise.reject(new Error('User interaction is not allowed.'));
    const store = backgroundReadable(native, OPTION);
    await migrateKeychainOnce({ store, keys: ['a'], resaveSession: () => Promise.resolve() });
    expect(native.items.has('cord.keychain_after_first_unlock')).toBe(false);
  });
});
