import * as SQLite from 'expo-sqlite';

import { newestFirst, type SearchRow, type SearchStore } from './search-index';

/** One database file per account and server, in the app's private storage. */
export function searchDatabaseName(scope: string): string {
  return `chat-search-${scope.replace(/[^A-Za-z0-9_-]/g, '_')}.db`;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages (agent_id);
CREATE TABLE IF NOT EXISTS complete (agent_id TEXT PRIMARY KEY NOT NULL);
`;

// FTS5 is built in by default (expo-sqlite's enableFTS defaults to true). The full-text table
// follows the messages table through triggers.
const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
`;

interface Row {
  id: string;
  agent_id: string;
  role: string;
  text: string;
  created_at: string;
  seq: number;
}

function toRow(row: Row): SearchRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    role: row.role === 'you' ? 'you' : 'agent',
    text: row.text,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

/** A term as an FTS5 prefix query: quoted so punctuation is never read as syntax. */
const ftsTerm = (term: string) => `"${term.replace(/"/g, '""')}"*`;
const likeTerm = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function sqliteSearchStore(scope: string): SearchStore {
  const name = searchDatabaseName(scope);
  let opening: Promise<{ db: SQLite.SQLiteDatabase; fts: boolean }> | undefined;
  const open = () => {
    opening ??= (async () => {
      const db = await SQLite.openDatabaseAsync(name);
      await db.execAsync(SCHEMA);
      let fts = true;
      try {
        await db.execAsync(FTS);
      } catch {
        fts = false; // Plain matching still works on a build without FTS5.
      }
      return { db, fts };
    })().catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };

  return {
    async upsert(rows) {
      const { db } = await open();
      await db.withTransactionAsync(async () => {
        for (const row of rows)
          await db.runAsync(
            `INSERT INTO messages (id, agent_id, role, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET text = excluded.text, role = excluded.role,
               created_at = excluded.created_at, seq = excluded.seq
             WHERE messages.text IS NOT excluded.text OR messages.seq IS NOT excluded.seq`,
            [row.id, row.agentId, row.role, row.text, row.createdAt, row.seq],
          );
      });
    },
    async remove(ids) {
      const { db } = await open();
      await db.withTransactionAsync(async () => {
        for (const id of ids) await db.runAsync('DELETE FROM messages WHERE id = ?', [id]);
      });
    },
    async removeAgent(agentId) {
      const { db } = await open();
      await db.runAsync('DELETE FROM messages WHERE agent_id = ?', [agentId]);
      await db.runAsync('DELETE FROM complete WHERE agent_id = ?', [agentId]);
    },
    async wipe() {
      const current = opening;
      opening = undefined;
      if (current) await current.then(({ db }) => db.closeAsync()).catch(() => undefined);
      await SQLite.deleteDatabaseAsync(name);
    },
    async search(terms, limit) {
      const { db, fts } = await open();
      const rows = fts
        ? await db.getAllAsync<Row>(
            `SELECT m.id, m.agent_id, m.role, m.text, m.created_at, m.seq
             FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ? ORDER BY m.created_at DESC, m.seq DESC LIMIT ?`,
            [terms.map(ftsTerm).join(' '), limit],
          )
        : await db.getAllAsync<Row>(
            `SELECT id, agent_id, role, text, created_at, seq FROM messages
             WHERE ${terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(' AND ')}
             ORDER BY created_at DESC, seq DESC LIMIT ?`,
            [...terms.map(likeTerm), limit],
          );
      return rows.map(toRow).sort(newestFirst);
    },
    async isComplete(agentId) {
      const { db } = await open();
      return (
        (await db.getFirstAsync('SELECT agent_id FROM complete WHERE agent_id = ?', [agentId])) !==
        null
      );
    },
    async setComplete(agentId) {
      const { db } = await open();
      await db.runAsync('INSERT OR IGNORE INTO complete (agent_id) VALUES (?)', [agentId]);
    },
  };
}

/** Deletes the saved copy for an account that is signing out, opened this launch or not. */
export async function deleteSearchDatabase(scope: string): Promise<void> {
  try {
    await SQLite.deleteDatabaseAsync(searchDatabaseName(scope));
  } catch {
    /* No file yet, or already removed. */
  }
}
