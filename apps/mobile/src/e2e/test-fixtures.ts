/** An in-memory keychain for tests. */
export function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItemAsync: (k: string) => Promise.resolve(m.get(k) ?? null),
    setItemAsync: (k: string, v: string) => Promise.resolve(void m.set(k, v)),
    deleteItemAsync: (k: string) => Promise.resolve(void m.delete(k)),
    m,
  };
}
