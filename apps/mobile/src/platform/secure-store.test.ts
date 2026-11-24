import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  AFTER_FIRST_UNLOCK: 1,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-secure-store', () => native);

import { deviceOnlyStore, secureStore } from './secure-store';

describe('secure stores', () => {
  beforeEach(() => native.setItemAsync.mockClear());

  it('the app store saves readable after first unlock', async () => {
    await secureStore.setItemAsync('k', 'v');
    expect(native.setItemAsync).toHaveBeenCalledWith('k', 'v', { keychainAccessible: 1 });
  });

  it('the device-only store saves after first unlock, this device only (never in a backup)', async () => {
    await deviceOnlyStore.setItemAsync('k', 'v');
    expect(native.setItemAsync).toHaveBeenCalledWith('k', 'v', { keychainAccessible: 2 });
  });
});
