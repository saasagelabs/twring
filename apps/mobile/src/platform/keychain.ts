import type { SecureKeyValue } from '../auth/storage';

/** expo-secure-store's calls, with the option that says when an item can be read. */
export interface NativeSecureStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessible?: number },
  ): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/**
 * iOS: items readable once the phone has been unlocked after it started, not only while unlocked.
 * A ring wakes Twring on a locked phone, and an item saved with the default could not be read
 * there ("User interaction is not allowed"), so the answer could not say who was signed in.
 * Every save deletes first: an update keeps the item's old setting. Android ignores the option.
 */
export function backgroundReadable(
  native: NativeSecureStore,
  option: { keychainAccessible: number },
): SecureKeyValue {
  return {
    getItemAsync: (key) => native.getItemAsync(key),
    async setItemAsync(key, value) {
      await native.deleteItemAsync(key);
      await native.setItemAsync(key, value, option);
    },
    deleteItemAsync: (key) => native.deleteItemAsync(key),
  };
}

const MIGRATED_KEY = 'cord.keychain_after_first_unlock';

/**
 * Re-saves items stored before `backgroundReadable` (and the session) once, so they get the new
 * setting. On a locked phone the reads fail; it is then left for the next launch.
 */
export async function migrateKeychainOnce(options: {
  store: SecureKeyValue;
  keys: readonly string[];
  resaveSession: () => Promise<void>;
}): Promise<void> {
  const { store } = options;
  try {
    if ((await store.getItemAsync(MIGRATED_KEY)) !== null) return;
    for (const key of options.keys) {
      const value = await store.getItemAsync(key);
      if (value !== null) await store.setItemAsync(key, value);
    }
    await options.resaveSession();
    await store.setItemAsync(MIGRATED_KEY, '1');
  } catch {
    // Locked, or the keychain is unavailable: tried again on the next launch.
  }
}
