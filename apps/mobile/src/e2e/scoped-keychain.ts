import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { SecureKeyValue } from '../auth/storage';

/**
 * Private chat keys per server and account (P3c ruling 1): the device key, its seq counter and the
 * trusted computers live under names that carry a hash of the scope (`currentScope` in
 * `threads/chats.ts`), so another server or account never reuses them and sign-out of one scope
 * leaves the others. The hash keeps the name a valid keychain key and keeps the account id out.
 */
const cache = new WeakMap<SecureKeyValue, Map<string, SecureKeyValue>>();

export function scopedKeychain(store: SecureKeyValue, scope: string): SecureKeyValue {
  let perStore = cache.get(store);
  if (perStore === undefined) {
    perStore = new Map();
    cache.set(store, perStore);
  }
  const found = perStore.get(scope);
  if (found !== undefined) return found;
  const suffix = bytesToHex(sha256(new TextEncoder().encode(scope))).slice(0, 32);
  const name = (key: string) => `${key}.${suffix}`;
  // One object per scope: `nextSeq` locks per keychain object, so two sends share the lock.
  const scoped: SecureKeyValue = {
    getItemAsync: (key) => store.getItemAsync(name(key)),
    setItemAsync: (key, value) => store.setItemAsync(name(key), value),
    deleteItemAsync: (key) => store.deleteItemAsync(name(key)),
  };
  perStore.set(scope, scoped);
  return scoped;
}

/** Signed out: there is no scope, so nothing is read or saved. */
export const noKeychain: SecureKeyValue = {
  getItemAsync: () => Promise.reject(new Error('signed out')),
  setItemAsync: () => Promise.reject(new Error('signed out')),
  deleteItemAsync: () => Promise.resolve(),
};
