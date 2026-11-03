import { describe, expect, it } from 'vitest';

import { CHUNK_CHARS, chunkedSecureStorage, type SecureKeyValue } from './storage';

class MemoryStore implements SecureKeyValue {
  readonly items = new Map<string, string>();
  getItemAsync(key: string) {
    return Promise.resolve(this.items.get(key) ?? null);
  }
  setItemAsync(key: string, value: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) return Promise.reject(new Error(`bad key ${key}`));
    if (new TextEncoder().encode(value).length > 2048) {
      return Promise.reject(new Error('value too large'));
    }
    this.items.set(key, value);
    return Promise.resolve();
  }
  deleteItemAsync(key: string) {
    this.items.delete(key);
    return Promise.resolve();
  }
}

describe('chunked secure storage', () => {
  it('round-trips a session larger than one secure-store value', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    const session = JSON.stringify({ access_token: 'a'.repeat(3000), refresh: 'r', name: 'Zoë ✓' });
    await storage.setItem('cord.auth', session);
    expect(await storage.getItem('cord.auth')).toBe(session);
    expect(store.items.get('cord.auth.count')).toBe(
      String(Math.ceil(session.length / CHUNK_CHARS)),
    );
  });

  it('keeps any text under the 2 KB limit per value', async () => {
    const storage = chunkedSecureStorage(new MemoryStore());
    const wide = '𝄞'.repeat(2000); // 4 bytes of UTF-8 per character
    await storage.setItem('k', wide);
    expect(await storage.getItem('k')).toBe(wide);
    // Offset by one so a chunk boundary would fall inside a surrogate pair.
    const store = new MemoryStore();
    const offset = chunkedSecureStorage(store);
    await offset.setItem('k', `x${wide}`);
    expect(await offset.getItem('k')).toBe(`x${wide}`);
    for (const [key, value] of store.items) {
      if (key !== 'k.count') expect(value.isWellFormed(), key).toBe(true);
    }
  });

  it('removes leftover chunks when the value shrinks, and all of them on remove', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('k', 'x'.repeat(CHUNK_CHARS * 3));
    await storage.setItem('k', 'short');
    expect([...store.items.keys()].sort()).toEqual(['k.0', 'k.count']);
    expect(await storage.getItem('k')).toBe('short');
    await storage.removeItem('k');
    expect(store.items.size).toBe(0);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('reads a half-written value as absent', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('k', 'x'.repeat(CHUNK_CHARS * 2));
    store.items.delete('k.1');
    expect(await storage.getItem('k')).toBeNull();
    store.items.set('k.count', 'garbage');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('leaves the old value intact when a new one is too large to store', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('k', 'old');
    await expect(storage.setItem('k', 'x'.repeat(CHUNK_CHARS * 64 + 1))).rejects.toThrow(
      /too large/,
    );
    expect(await storage.getItem('k')).toBe('old');
    // The largest value that fits still round-trips.
    const largest = 'y'.repeat(CHUNK_CHARS * 64);
    await storage.setItem('k', largest);
    expect(await storage.getItem('k')).toBe(largest);
  });

  it('stores and reads an empty value', async () => {
    const storage = chunkedSecureStorage(new MemoryStore());
    await storage.setItem('k', '');
    expect(await storage.getItem('k')).toBe('');
  });

  it('reads a write that failed half-way as absent, and a later remove clears every chunk', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('k', 'a');
    const realSet = store.setItemAsync.bind(store);
    let writes = 0;
    store.setItemAsync = (key, value) => {
      writes += 1;
      return writes === 3 ? Promise.reject(new Error('keystore busy')) : realSet(key, value);
    };
    await expect(storage.setItem('k', 'b'.repeat(CHUNK_CHARS * 3))).rejects.toThrow(/busy/);
    expect(await storage.getItem('k')).toBeNull();
    // Signing out must not leave pieces of the old session (a refresh token) in the Keychain.
    await storage.removeItem('k');
    expect([...store.items.keys()]).toEqual([]);
  });

  it('keeps concurrent writes and removes whole: the last one wins, never a mix', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    const long = 'L'.repeat(CHUNK_CHARS * 3);
    const short = 'S'.repeat(CHUNK_CHARS + 1);
    await Promise.all([storage.setItem('k', long), storage.setItem('k', short)]);
    expect(await storage.getItem('k')).toBe(short);
    await Promise.all([storage.setItem('k', long), storage.removeItem('k')]);
    expect(await storage.getItem('k')).toBeNull();
    expect([...store.items.keys()]).toEqual([]);
    await Promise.all([storage.removeItem('k'), storage.setItem('k', long)]);
    expect(await storage.getItem('k')).toBe(long);
  });

  it('keeps working after a failed operation (the queue does not jam)', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    const realSet = store.setItemAsync.bind(store);
    store.setItemAsync = () => Promise.reject(new Error('locked'));
    await expect(storage.setItem('k', 'v')).rejects.toThrow(/locked/);
    store.setItemAsync = realSet;
    await storage.setItem('k', 'v');
    expect(await storage.getItem('k')).toBe('v');
  });

  it('maps keys to the characters the secure store allows', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('sb-proj-auth-token:code', 'v');
    expect(await storage.getItem('sb-proj-auth-token:code')).toBe('v');
  });
});

describe('resave', () => {
  it('rewrites a stored session in place, in turn with other writes', async () => {
    const store = new MemoryStore();
    const writes: string[] = [];
    const original = store.setItemAsync.bind(store);
    store.setItemAsync = (key: string, value: string) => {
      writes.push(key);
      return original(key, value);
    };
    const storage = chunkedSecureStorage(store);
    await storage.setItem('cord.auth', 'old');
    writes.length = 0;
    // A newer session queued first must be what the resave writes back.
    const newer = storage.setItem('cord.auth', 'new');
    await storage.resave('cord.auth');
    await newer;
    expect(await storage.getItem('cord.auth')).toBe('new');
    expect(writes.filter((key) => key === 'cord.auth.0')).toHaveLength(2);
  });

  it('does nothing when there is no session', async () => {
    const store = new MemoryStore();
    await chunkedSecureStorage(store).resave('cord.auth');
    expect(store.items.size).toBe(0);
  });
});

describe('resave keeps the session readable throughout', () => {
  it('never removes the count while it rewrites (a kill mid-way must not sign anyone out)', async () => {
    const store = new MemoryStore();
    const storage = chunkedSecureStorage(store);
    await storage.setItem('cord.auth', 'x'.repeat(CHUNK_CHARS * 2 + 5));
    const deleted: string[] = [];
    const written: string[] = [];
    const del = store.deleteItemAsync.bind(store);
    const set = store.setItemAsync.bind(store);
    store.deleteItemAsync = (key: string) => {
      deleted.push(key);
      return del(key);
    };
    store.setItemAsync = (key: string, value: string) => {
      written.push(key);
      return set(key, value);
    };
    await storage.resave('cord.auth');
    expect(deleted).not.toContain('cord.auth.count');
    expect(written).toEqual(['cord.auth.0', 'cord.auth.1', 'cord.auth.2', 'cord.auth.count']);
  });
});
