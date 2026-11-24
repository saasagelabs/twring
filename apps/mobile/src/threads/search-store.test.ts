import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlite = vi.hoisted(() => {
  const calls: string[] = [];
  const db = {
    execAsync: vi.fn((sql: string): Promise<void> => {
      calls.push(`exec:${sql.includes('DROP TABLE') ? 'empty' : 'schema'}`);
      return Promise.resolve();
    }),
    closeAsync: vi.fn((): Promise<void> => {
      calls.push('close');
      return Promise.resolve();
    }),
    getFirstAsync: vi.fn((): Promise<null> => Promise.resolve(null)),
  };
  return {
    calls,
    db,
    deleteFails: 0,
    openDatabaseAsync: vi.fn((): Promise<typeof db> => {
      calls.push('open');
      return Promise.resolve(db);
    }),
    deleteDatabaseAsync: vi.fn((): Promise<void> => {
      calls.push('delete');
      if (sqlite.deleteFails > 0) {
        sqlite.deleteFails -= 1;
        return Promise.reject(new Error('database is open'));
      }
      return Promise.resolve();
    }),
  };
});

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: sqlite.openDatabaseAsync,
  deleteDatabaseAsync: sqlite.deleteDatabaseAsync,
}));

import { deleteSearchDatabase, sqliteSearchStore } from './search-store';

beforeEach(() => {
  sqlite.calls.length = 0;
  sqlite.deleteFails = 0;
  vi.clearAllMocks();
});

describe('removing the saved copy', () => {
  it('wipe closes the open copy, then deletes the file', async () => {
    const store = sqliteSearchStore('acct-1');
    await store.isComplete('agt_1');
    sqlite.calls.length = 0;
    await store.wipe();
    expect(sqlite.calls).toEqual(['close', 'delete']);
  });

  it('wipe empties the copy when the file cannot be deleted, and never throws', async () => {
    sqlite.deleteFails = 1;
    const store = sqliteSearchStore('acct-1');
    await expect(store.wipe()).resolves.toBeUndefined();
    expect(sqlite.calls).toEqual(['delete', 'open', 'exec:empty', 'close', 'delete']);
  });

  it('wipe still resolves when emptying fails too', async () => {
    sqlite.deleteFails = 2;
    sqlite.db.execAsync.mockRejectedValueOnce(new Error('disk I/O error'));
    const store = sqliteSearchStore('acct-1');
    await expect(store.wipe()).resolves.toBeUndefined();
  });

  it('sign-out deletion empties the copy when the file cannot be deleted', async () => {
    sqlite.deleteFails = 1;
    await expect(deleteSearchDatabase('acct-1')).resolves.toBeUndefined();
    expect(sqlite.calls).toEqual(['delete', 'open', 'exec:empty', 'close', 'delete']);
  });
});
