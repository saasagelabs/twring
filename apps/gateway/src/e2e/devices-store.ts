import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_PAIRED_DEVICES,
  e2eDeviceSchema,
  type E2eDevice,
  type PairClaim,
} from '@twring/contracts';

/**
 * Device keys for private chats (ADR-044): every phone and computer of an account that may open
 * sealed messages, and the short-lived pairing offers that add them. Public keys are not secret,
 * so they are stored plainly; nothing here can open a message.
 */

export class E2eDeviceError extends Error {
  constructor(readonly code: 'device_cap' | 'duplicate_key' | 'device_conflict') {
    super(code);
    this.name = 'E2eDeviceError';
  }
}

export type NewDevice = Omit<E2eDevice, 'added_at' | 'revoked_at'>;
export type OfferClaim = Omit<PairClaim, 'offer_id'>;

export interface PairOfferRecord {
  id: string;
  userId: string;
  connectorId: string;
  connectorDeviceId: string;
  connectorPublicKey: string;
  expiresAt: string;
  claim?: OfferClaim;
}

type DeviceRow = {
  user_id: string;
  id: string;
  kind: string;
  name: string;
  public_key: string;
  connector_id: string | null;
  added_at: string;
  revoked_at: string | null;
};
type OfferRow = {
  user_id: string;
  id: string;
  connector_id: string;
  connector_device_id: string;
  connector_public_key: string;
  expires_at: string;
  claim: string | null;
};

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const newOfferId = () => `off_${[...randomBytes(20)].map((byte) => ALPHABET[byte & 31]).join('')}`;

export class E2eDeviceStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA secure_delete=ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2e_devices(user_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, public_key TEXT NOT NULL, connector_id TEXT, added_at TEXT NOT NULL,
        revoked_at TEXT, PRIMARY KEY(user_id, id));
      CREATE INDEX IF NOT EXISTS e2e_devices_active ON e2e_devices(user_id, revoked_at);
      CREATE TABLE IF NOT EXISTS e2e_pair_offers(id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        connector_id TEXT NOT NULL, connector_device_id TEXT NOT NULL, connector_public_key TEXT NOT NULL,
        expires_at TEXT NOT NULL, claim TEXT);
      CREATE INDEX IF NOT EXISTS e2e_pair_offers_expiry ON e2e_pair_offers(expires_at);
    `);
  }

  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private device(row: DeviceRow): E2eDevice {
    return e2eDeviceSchema.parse({
      id: row.id,
      kind: row.kind,
      name: row.name,
      public_key: row.public_key,
      ...(row.connector_id !== null && { connector_id: row.connector_id }),
      added_at: row.added_at,
      ...(row.revoked_at !== null && { revoked_at: row.revoked_at }),
    });
  }

  /**
   * Adds an active device. The same device again is a no-op; a 6th active device, a key already
   * active under another id, or an id reused with another key (or after revoke) is refused.
   */
  add(userId: string, device: NewDevice): E2eDevice {
    return this.transaction(() => this.insertDevice(userId, device));
  }

  /** Adds several devices together: all of them, or none when one is refused. */
  addAll(userId: string, list: NewDevice[]): E2eDevice[] {
    return this.transaction(() => list.map((device) => this.insertDevice(userId, device)));
  }

  private insertDevice(userId: string, device: NewDevice): E2eDevice {
    const existing = this.db
      .prepare('SELECT * FROM e2e_devices WHERE user_id=? AND id=?')
      .get(userId, device.id) as DeviceRow | undefined;
    if (existing) {
      if (existing.revoked_at === null && existing.public_key === device.public_key)
        return this.device(existing);
      throw new E2eDeviceError('device_conflict');
    }
    const active = this.db
      .prepare('SELECT public_key FROM e2e_devices WHERE user_id=? AND revoked_at IS NULL')
      .all(userId) as { public_key: string }[];
    if (active.some((row) => row.public_key === device.public_key))
      throw new E2eDeviceError('duplicate_key');
    if (active.length >= MAX_PAIRED_DEVICES) throw new E2eDeviceError('device_cap');
    this.db
      .prepare(
        'INSERT INTO e2e_devices(user_id,id,kind,name,public_key,connector_id,added_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        userId,
        device.id,
        device.kind,
        device.name,
        device.public_key,
        device.connector_id ?? null,
        this.now().toISOString(),
      );
    return this.get(userId, device.id)!;
  }

  /** Active devices only, oldest first. */
  list(userId: string): E2eDevice[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM e2e_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY added_at, id',
        )
        .all(userId) as DeviceRow[]
    ).map((row) => this.device(row));
  }

  /** An active device of this account. */
  get(userId: string, deviceId: string): E2eDevice | undefined {
    const row = this.db
      .prepare('SELECT * FROM e2e_devices WHERE user_id=? AND id=? AND revoked_at IS NULL')
      .get(userId, deviceId) as DeviceRow | undefined;
    return row && this.device(row);
  }

  revoke(userId: string, deviceId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE e2e_devices SET revoked_at=? WHERE user_id=? AND id=? AND revoked_at IS NULL',
      )
      .run(this.now().toISOString(), userId, deviceId);
    return Number(result.changes) > 0;
  }

  createOffer(
    userId: string,
    input: Omit<PairOfferRecord, 'id' | 'userId' | 'expiresAt' | 'claim'> & { expiresAt: Date },
  ): PairOfferRecord {
    this.db.prepare('DELETE FROM e2e_pair_offers WHERE expires_at<?').run(this.now().toISOString());
    const id = newOfferId();
    this.db
      .prepare(
        'INSERT INTO e2e_pair_offers(id,user_id,connector_id,connector_device_id,connector_public_key,expires_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        id,
        userId,
        input.connectorId,
        input.connectorDeviceId,
        input.connectorPublicKey,
        input.expiresAt.toISOString(),
      );
    return this.offer(userId, id)!;
  }

  /** This account's offer, expired or not; never another account's. */
  offer(userId: string, offerId: string): PairOfferRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM e2e_pair_offers WHERE id=? AND user_id=?')
      .get(offerId, userId) as OfferRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      connectorId: row.connector_id,
      connectorDeviceId: row.connector_device_id,
      connectorPublicKey: row.connector_public_key,
      expiresAt: row.expires_at,
      ...(row.claim !== null && { claim: JSON.parse(row.claim) as OfferClaim }),
    };
  }

  /** Records the phone's claim once. */
  claimOffer(
    userId: string,
    offerId: string,
    claim: OfferClaim,
  ): 'claimed' | 'already_claimed' | 'missing' {
    const result = this.db
      .prepare('UPDATE e2e_pair_offers SET claim=? WHERE id=? AND user_id=? AND claim IS NULL')
      .run(JSON.stringify(claim), offerId, userId);
    if (Number(result.changes) > 0) return 'claimed';
    return this.offer(userId, offerId) ? 'already_claimed' : 'missing';
  }

  deleteOffer(userId: string, offerId: string): void {
    this.db.prepare('DELETE FROM e2e_pair_offers WHERE id=? AND user_id=?').run(offerId, userId);
  }

  /** Delete my data: every device and offer of the account. Returns the devices removed. */
  deleteAllForUser(userId: string): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM e2e_pair_offers WHERE user_id=?').run(userId);
      return Number(this.db.prepare('DELETE FROM e2e_devices WHERE user_id=?').run(userId).changes);
    });
  }

  close(): void {
    this.db.close();
  }
}
