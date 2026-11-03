import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { emailSendKey } from './installs';

/** The relay's one SQLite file. Later tasks add `devices`, `tickets_used`, `usage_daily`, `audio_sessions`. */
export interface RelayDb {
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * Numbered schema steps. Step N brings a database to `user_version` N. Never edit a shipped step;
 * add a new one. Column additions are idempotent (skipped when the column exists), because
 * databases from before the runner have `user_version` 0 but already hold some of these.
 */
const MIGRATIONS: readonly ((db: DatabaseSync) => void)[] = [
  // 1: installs (the original Task 6 schema).
  (db) =>
    db.exec(`CREATE TABLE IF NOT EXISTS installs (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  email TEXT NOT NULL,
  news INTEGER NOT NULL,
  address TEXT,
  partner_id TEXT,
  key_hash TEXT NOT NULL UNIQUE,
  verify_hash TEXT UNIQUE,
  verify_expires_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  paid_until TEXT NOT NULL,
  revoked_at TEXT
);`),
  // 2: the email queue and single-use registration proofs.
  (db) => {
    // A verification email is waiting to go out (held by a cap or a failed send).
    addColumn(db, 'installs', 'email_pending', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'installs', 'last_email_at', 'INTEGER');
    db.exec(`
CREATE TABLE IF NOT EXISTS proofs_used (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS email_sends (address TEXT NOT NULL, sent_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS email_sends_address ON email_sends (address, sent_at);`);
  },
  // 3: when an email was last asked for (the queue gives up 7 days after it), and when the
  // address was set (the unverified ring grace counts from here).
  (db) => {
    addColumn(db, 'installs', 'email_requested_at', 'INTEGER');
    addColumn(db, 'installs', 'email_changed_at', 'TEXT');
  },
  // 4: phones (push tokens behind a hashed handle), single-use device tickets, daily usage.
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  handle_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  fcm_token TEXT,
  voip_token TEXT,
  apns_token TEXT,
  created_at TEXT NOT NULL,
  stale_at TEXT
);
CREATE INDEX IF NOT EXISTS devices_install ON devices (install_id, device_ref);
CREATE TABLE IF NOT EXISTS tickets_used (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_daily (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (install_id, day, kind)
);`),
  // 5: Twring-run call audio sessions (minutes are counted into usage_daily when one ends).
  (db) =>
    db.exec(`
CREATE TABLE IF NOT EXISTS audio_sessions (
  room TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  minutes INTEGER
);
CREATE INDEX IF NOT EXISTS audio_sessions_open ON audio_sessions (install_id, ended_at);`),
  // 6: LiveKit settles audio minutes: an end report only marks a session ending; whether its
  // room ever started decides if a session with no word from LiveKit is billed.
  (db) => {
    addColumn(db, 'audio_sessions', 'ending_at', 'INTEGER');
    addColumn(db, 'audio_sessions', 'room_started', 'INTEGER NOT NULL DEFAULT 0');
  },
  // 7: a room the two-hour net closed still has to be deleted on LiveKit (retried until done).
  (db) => addColumn(db, 'audio_sessions', 'room_close_pending', 'INTEGER NOT NULL DEFAULT 0'),
  // 8: email_sends keeps a hash of the address, never the address (rows from before are hashed).
  (db) => {
    const rows = db
      .prepare("SELECT DISTINCT address FROM email_sends WHERE address LIKE '%@%'")
      .all() as { address: string }[];
    const update = db.prepare('UPDATE email_sends SET address = ? WHERE address = ?');
    for (const { address } of rows) update.run(emailSendKey(address), address);
  },
];

/** The schema version this code writes. */
export const RELAY_DB_VERSION = MIGRATIONS.length;

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** Brings the database to `RELAY_DB_VERSION` in one transaction; refuses a newer one. */
export function migrate(db: DatabaseSync): void {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
    .user_version;
  if (version > RELAY_DB_VERSION) {
    throw new Error(
      `The relay database is at version ${version}, written by a newer version of the relay ` +
        `(this one knows ${RELAY_DB_VERSION}). Update the relay before starting it.`,
    );
  }
  if (version === RELAY_DB_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let step = version; step < RELAY_DB_VERSION; step += 1) MIGRATIONS[step]!(db);
    db.exec(`PRAGMA user_version = ${RELAY_DB_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Opens (and creates or migrates if needed) the relay database. `:memory:` is for tests. */
export function openRelayDb(file: string): RelayDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file);
  try {
    sqlite.exec('PRAGMA journal_mode = WAL;');
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return { sqlite, close: () => sqlite.close() };
}
