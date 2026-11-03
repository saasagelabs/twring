/** The key-value calls the session store needs (expo-secure-store's shape). */
export interface SecureKeyValue {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Supabase's storage adapter shape. */
export interface SessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Well under the ~2 KB some iOS releases accept per secure-store value. A Supabase session (JWT plus
 * refresh token and user) is often larger, so it is split. Session JSON is ASCII in practice, but a
 * chunk of 1800 UTF-16 units stays under 2 KB of UTF-8 only for ASCII; 600 keeps any text safe.
 */
export const CHUNK_CHARS = 600;
const MAX_CHUNKS = 64;

/** Secure-store keys allow only letters, digits, `.`, `-`, and `_`. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Stores each value as `<key>.count` plus `<key>.0` … `<key>.n-1` in the secure store (Keychain /
 * Android Keystore). A value with a missing chunk reads as absent, so a half-written session is
 * dropped rather than parsed.
 */
export function chunkedSecureStorage(
  store: SecureKeyValue,
): SessionStorage & { resave(key: string): Promise<void> } {
  const countKey = (key: string) => `${safeKey(key)}.count`;
  const chunkKey = (key: string, index: number) => `${safeKey(key)}.${index}`;

  async function storedCount(key: string): Promise<number> {
    const raw = await store.getItemAsync(countKey(key));
    const count = raw === null ? 0 : Number(raw);
    return Number.isInteger(count) && count > 0 && count <= MAX_CHUNKS ? count : 0;
  }

  /**
   * Deletes chunks from `from` on: at least up to `to`, then on while more exist. Chunks are written
   * in order, so the ones a failed write left behind (with no count to find them by) are contiguous.
   */
  async function deleteChunks(key: string, from: number, to: number): Promise<void> {
    for (let index = from; index < MAX_CHUNKS; index += 1) {
      if (index >= to && (await store.getItemAsync(chunkKey(key, index))) === null) return;
      await store.deleteItemAsync(chunkKey(key, index));
    }
  }

  /**
   * One operation at a time: the Supabase client does not serialize its own storage calls, and two
   * interleaved chunked writes would read back as a mix of both sessions.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  }

  const storage: SessionStorage = {
    async getItem(key) {
      const count = await storedCount(key);
      if (count === 0) return null;
      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await store.getItemAsync(chunkKey(key, index));
        if (part === null) return null;
        parts.push(part);
      }
      return parts.join('');
    },
    async setItem(key, value) {
      const chunks: string[] = [];
      for (let at = 0; at < value.length;) {
        let end = Math.min(at + CHUNK_CHARS, value.length);
        // Never split a surrogate pair: a lone half would not survive the native UTF-8 round trip.
        const last = value.charCodeAt(end - 1);
        if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        chunks.push(value.slice(at, end));
        at = end;
      }
      if (chunks.length === 0) chunks.push('');
      if (chunks.length > MAX_CHUNKS) throw new Error('session too large to store');
      const previous = await storedCount(key);
      // Invalidate first, so a crash mid-write leaves "absent", never a mix of old and new chunks.
      await store.deleteItemAsync(countKey(key));
      for (const [index, chunk] of chunks.entries()) {
        await store.setItemAsync(chunkKey(key, index), chunk);
      }
      await store.setItemAsync(countKey(key), String(chunks.length));
      await deleteChunks(key, chunks.length, previous);
    },
    async removeItem(key) {
      const previous = await storedCount(key);
      await store.deleteItemAsync(countKey(key));
      await deleteChunks(key, 0, previous);
    },
  };
  return {
    getItem: (key) => serial(() => storage.getItem(key)),
    setItem: (key, value) => serial(() => storage.setItem(key, value)),
    removeItem: (key) => serial(() => storage.removeItem(key)),
    /**
     * Writes each stored item back unchanged (a new keychain setting), in turn with other calls.
     * Unlike setItem it never removes the count first: the value is the same, so a kill part way
     * leaves a readable session rather than none.
     */
    resave: (key) =>
      serial(async () => {
        const count = await storedCount(key);
        if (count === 0) return;
        for (let index = 0; index < count; index += 1) {
          const part = await store.getItemAsync(chunkKey(key, index));
          if (part === null) return;
          await store.setItemAsync(chunkKey(key, index), part);
        }
        await store.setItemAsync(countKey(key), String(count));
      }),
  };
}
