import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { openRelayDb, RELAY_DB_VERSION } from './db';
import { emailSendKey, InstallStore } from './installs';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dbFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'twring-relay-db-'));
  dirs.push(dir);
  return join(dir, 'relay.db');
}

/** The schema the first Task 6 commit created (no user_version). */
const ORIGINAL = `
CREATE TABLE installs (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL,
  email TEXT NOT NULL, news INTEGER NOT NULL, address TEXT, partner_id TEXT,
  key_hash TEXT NOT NULL UNIQUE, verify_hash TEXT UNIQUE, verify_expires_at TEXT,
  verified_at TEXT, created_at TEXT NOT NULL, paid_until TEXT NOT NULL, revoked_at TEXT
);`;

/** The schema after fix round 1. */
const ROUND_ONE = ORIGINAL.replace(
  'revoked_at TEXT\n);',
  `revoked_at TEXT, email_pending INTEGER NOT NULL DEFAULT 0, last_email_at INTEGER
);
CREATE TABLE proofs_used (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE email_sends (address TEXT NOT NULL, sent_at INTEGER NOT NULL);
CREATE INDEX email_sends_address ON email_sends (address, sent_at);`,
);

const OLD_ROW = `INSERT INTO installs (id, server_id, public_key, email, news, key_hash, created_at, paid_until)
  VALUES ('ins_old', 'srv_old', 'pk', 'a@example.com', 0, 'h', '2026-10-01T00:00:00.000Z', '2027-06-30T00:00:00.000Z')`;

function columns(db: DatabaseSync): string[] {
  return (db.prepare('PRAGMA table_info(installs)').all() as { name: string }[]).map((c) => c.name);
}

function version(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function useWorks(db: DatabaseSync) {
  const store = new InstallStore({ sqlite: db, close: () => undefined });
  const { install } = store.create(
    {
      serverId: 'srv_new',
      publicKey: 'pk2',
      email: 'b@example.com',
      news: false,
      paidUntil: '2027-06-30T00:00:00.000Z',
    },
    Date.parse('2026-11-01T00:00:00.000Z'),
  );
  expect(install.emailChangedAt).toBe('2026-11-01T00:00:00.000Z');
  expect(store.useProof('j'.repeat(16), Date.now() + 1000, Date.now())).toBe(true);
  expect(store.findById('ins_old')?.email).toBe('a@example.com');
}

describe('relay database migrations', () => {
  for (const [name, ddl] of [
    ['original', ORIGINAL],
    ['round one', ROUND_ONE],
  ] as const) {
    it(`migrates a ${name} database to the current schema`, async () => {
      const file = await dbFile();
      const old = new DatabaseSync(file);
      old.exec(ddl);
      old.exec(OLD_ROW);
      old.close();

      const db = openRelayDb(file);
      expect(version(db.sqlite)).toBe(RELAY_DB_VERSION);
      expect(columns(db.sqlite)).toEqual(
        expect.arrayContaining([
          'email_pending',
          'last_email_at',
          'email_requested_at',
          'email_changed_at',
        ]),
      );
      useWorks(db.sqlite);
      db.close();
    });
  }

  it('hashes the addresses an older database kept in email_sends', async () => {
    const file = await dbFile();
    const old = new DatabaseSync(file);
    old.exec(ROUND_ONE);
    old.exec("INSERT INTO email_sends (address, sent_at) VALUES ('Owner@Example.com', 1)");
    old.close();
    const db = openRelayDb(file);
    const rows = db.sqlite.prepare('SELECT address FROM email_sends').all() as {
      address: string;
    }[];
    expect(rows).toEqual([{ address: emailSendKey('owner@example.com') }]);
    expect(rows[0]!.address).not.toContain('@');
    db.close();
  });

  it('creates a fresh database at the current version', () => {
    const db = openRelayDb(':memory:');
    expect(version(db.sqlite)).toBe(RELAY_DB_VERSION);
    db.sqlite.exec(OLD_ROW);
    useWorks(db.sqlite);
  });

  it('leaves a current database untouched', async () => {
    const file = await dbFile();
    openRelayDb(file).close();
    const before = new DatabaseSync(file);
    const schema = JSON.stringify(
      before.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(),
    );
    before.close();
    const db = openRelayDb(file);
    expect(
      JSON.stringify(db.sqlite.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()),
    ).toBe(schema);
    expect(version(db.sqlite)).toBe(RELAY_DB_VERSION);
    db.close();
  });

  it('refuses a database from a newer relay', async () => {
    const file = await dbFile();
    const newer = new DatabaseSync(file);
    newer.exec(`PRAGMA user_version = ${RELAY_DB_VERSION + 1}`);
    newer.close();
    expect(() => openRelayDb(file)).toThrow(/newer version of the relay/);
  });
});
