import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_PAIRED_DEVICES,
  e2eDeviceSchema,
  e2eDeviceWithNoteSchema,
  trustNoteSchema,
  type E2eDevice,
  type E2eDeviceWithNote,
  type PhoneApproval,
  type PhoneApprovalRequest,
  type TrustNote,
  type PairClaim,
  type RecoveryBackupRequest,
} from '@twring/contracts';

/**
 * Device keys for private chats (ADR-044): every phone and computer of an account that may open
 * sealed messages, and the short-lived pairing offers that add them. Public keys are not secret,
 * so they are stored plainly; nothing here can open a message.
 */

export class E2eDeviceError extends Error {
  constructor(
    readonly code:
      | 'device_cap'
      | 'duplicate_key'
      | 'device_conflict'
      | 'handle_taken'
      | 'approval_cap'
      | 'already_added'
      | 'device_removed',
  ) {
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
  /** The typed code's lookup handle (C3 #11); absent for an older computer's offer. */
  handle?: string;
  /** The computer's key commitment for the typed code (`offerKeyMac`), registered with it. */
  keyMac?: string;
  /** The computer's commitment to its connector id for the typed code (`offerConnectorMac`). */
  connectorMac?: string;
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
  trust_note: string | null;
};
type ApprovalRow = {
  id: string;
  user_id: string;
  device_id: string;
  public_key: string;
  name: string;
  state: string;
  created_at: string;
  expires_at: string;
  approver_id: string | null;
  approver_name: string | null;
  approver_key: string | null;
  note: string | null;
  commitment?: string | null;
  approver_nonce?: string | null;
  reveal?: string | null;
};

/** Open phone approvals (pending or claimed) an account may hold at once (C3 #11 P4b ruling 1). */
export const MAX_OPEN_APPROVALS = 3;
type OfferRow = {
  user_id: string;
  id: string;
  connector_id: string;
  connector_device_id: string;
  connector_public_key: string;
  expires_at: string;
  claim: string | null;
  handle: string | null;
  key_mac: string | null;
  connector_mac: string | null;
};

type RecoveryRow = {
  user_id: string;
  device_id: string;
  salt: string;
  check_value: string;
  sealed: string;
  updated_at: string;
};

/** A stored recovery backup: salt, check value and ciphertext only (C3 #11). */
export type RecoveryRecord = RecoveryBackupRequest & { updated_at: string };

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const newOfferId = () => `off_${[...randomBytes(20)].map((byte) => ALPHABET[byte & 31]).join('')}`;
const newApprovalId = () =>
  `pap_${[...randomBytes(20)].map((byte) => ALPHABET[byte & 31]).join('')}`;

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
      CREATE TABLE IF NOT EXISTS e2e_recovery(user_id TEXT PRIMARY KEY, device_id TEXT NOT NULL,
        salt TEXT NOT NULL, check_value TEXT NOT NULL, sealed TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    // Typed pairing codes (C3 #11). Added in place, so an existing database keeps its offers.
    const columns = this.db.prepare('PRAGMA table_info(e2e_pair_offers)').all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'handle'))
      this.db.exec('ALTER TABLE e2e_pair_offers ADD COLUMN handle TEXT');
    if (!columns.some((column) => column.name === 'key_mac'))
      this.db.exec('ALTER TABLE e2e_pair_offers ADD COLUMN key_mac TEXT');
    if (!columns.some((column) => column.name === 'connector_mac'))
      this.db.exec('ALTER TABLE e2e_pair_offers ADD COLUMN connector_mac TEXT');
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS e2e_pair_offers_handle ON e2e_pair_offers(user_id, handle)',
    );
    // Approving a second phone (C3 #11, Task 27): the note the approving phone sealed rides on
    // the new phone's row, given only to clients that ask for it (`?notes=1`).
    const deviceColumns = this.db.prepare('PRAGMA table_info(e2e_devices)').all() as {
      name: string;
    }[];
    if (!deviceColumns.some((column) => column.name === 'trust_note'))
      this.db.exec('ALTER TABLE e2e_devices ADD COLUMN trust_note TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS e2e_phone_approvals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        device_id TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, approver_id TEXT, approver_name TEXT,
        approver_key TEXT, note TEXT);
      CREATE INDEX IF NOT EXISTS e2e_phone_approvals_user ON e2e_phone_approvals(user_id, state);
    `);
    // ADR-046 commit, then reveal: nullable, so rows from older apps read as having none.
    const approvalColumns = this.db.prepare('PRAGMA table_info(e2e_phone_approvals)').all() as {
      name: string;
    }[];
    for (const column of ['commitment', 'approver_nonce', 'reveal'])
      if (!approvalColumns.some((c) => c.name === column))
        this.db.exec(`ALTER TABLE e2e_phone_approvals ADD COLUMN ${column} TEXT`);
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
    return e2eDeviceSchema.parse(this.fields(row));
  }

  private deviceWithNote(row: DeviceRow): E2eDeviceWithNote {
    return e2eDeviceWithNoteSchema.parse({
      ...this.fields(row),
      ...(row.trust_note !== null && { trust_note: JSON.parse(row.trust_note) as unknown }),
    });
  }

  private fields(row: DeviceRow) {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      public_key: row.public_key,
      ...(row.connector_id !== null && { connector_id: row.connector_id }),
      added_at: row.added_at,
      ...(row.revoked_at !== null && { revoked_at: row.revoked_at }),
    };
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

  private insertDevice(userId: string, device: NewDevice, note?: TrustNote): E2eDevice {
    const existing = this.db
      .prepare('SELECT * FROM e2e_devices WHERE user_id=? AND id=?')
      .get(userId, device.id) as DeviceRow | undefined;
    if (existing) {
      if (existing.revoked_at === null && existing.public_key === device.public_key) {
        if (note === undefined) return this.device(existing);
        // ADR-045: an approved phone that was already active keeps the note on its row.
        this.db
          .prepare('UPDATE e2e_devices SET trust_note=? WHERE user_id=? AND id=?')
          .run(JSON.stringify(note), userId, device.id);
        return this.device({ ...existing, trust_note: JSON.stringify(note) });
      }
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
        'INSERT INTO e2e_devices(user_id,id,kind,name,public_key,connector_id,added_at,trust_note) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        userId,
        device.id,
        device.kind,
        device.name,
        device.public_key,
        device.connector_id ?? null,
        this.now().toISOString(),
        note === undefined ? null : JSON.stringify(note),
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

  /** Active devices, then those revoked at or after `since` (with `revoked_at`), oldest first. */
  listWithRevoked(userId: string, since: Date): E2eDevice[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM e2e_devices WHERE user_id=? AND (revoked_at IS NULL OR revoked_at>=?) ORDER BY added_at, id',
        )
        .all(userId, since.toISOString()) as DeviceRow[]
    ).map((row) => this.device(row));
  }

  /** As `listWithRevoked`, with each row's trust note when it has one (`?notes=1`). */
  listWithNotes(userId: string, since: Date): E2eDeviceWithNote[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM e2e_devices WHERE user_id=? AND (revoked_at IS NULL OR revoked_at>=?) ORDER BY added_at, id',
        )
        .all(userId, since.toISOString()) as DeviceRow[]
    ).map((row) => this.deviceWithNote(row));
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

  /**
   * A new offer. A typed handle must be unique among the account's live offers: one already held
   * throws `handle_taken` so the computer picks another code (checked and inserted in one step).
   */
  createOffer(
    userId: string,
    input: Omit<PairOfferRecord, 'id' | 'userId' | 'expiresAt' | 'claim'> & { expiresAt: Date },
  ): PairOfferRecord {
    const now = this.now().toISOString();
    this.db.prepare('DELETE FROM e2e_pair_offers WHERE expires_at<?').run(now);
    const id = newOfferId();
    this.transaction(() => {
      if (
        input.handle !== undefined &&
        this.db
          .prepare('SELECT 1 FROM e2e_pair_offers WHERE user_id=? AND handle=? AND expires_at>?')
          .get(userId, input.handle, now) !== undefined
      )
        throw new E2eDeviceError('handle_taken');
      this.db
        .prepare(
          'INSERT INTO e2e_pair_offers(id,user_id,connector_id,connector_device_id,connector_public_key,expires_at,handle,key_mac,connector_mac) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          userId,
          input.connectorId,
          input.connectorDeviceId,
          input.connectorPublicKey,
          input.expiresAt.toISOString(),
          input.handle ?? null,
          input.keyMac ?? null,
          input.connectorMac ?? null,
        );
    });
    return this.offer(userId, id)!;
  }

  /** This account's live, unclaimed offer with this typed handle; never another account's. */
  offerByHandle(userId: string, handle: string): PairOfferRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM e2e_pair_offers WHERE user_id=? AND handle=? AND key_mac IS NOT NULL AND claim IS NULL AND expires_at>?',
      )
      .get(userId, handle, this.now().toISOString()) as OfferRow | undefined;
    return row && this.record(row);
  }

  /** This account's offer, expired or not; never another account's. */
  offer(userId: string, offerId: string): PairOfferRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM e2e_pair_offers WHERE id=? AND user_id=?')
      .get(offerId, userId) as OfferRow | undefined;
    return row && this.record(row);
  }

  private record(row: OfferRow): PairOfferRecord {
    return {
      id: row.id,
      userId: row.user_id,
      connectorId: row.connector_id,
      connectorDeviceId: row.connector_device_id,
      connectorPublicKey: row.connector_public_key,
      expiresAt: row.expires_at,
      ...(row.handle !== null && { handle: row.handle }),
      ...(row.key_mac !== null && { keyMac: row.key_mac }),
      ...(row.connector_mac !== null && { connectorMac: row.connector_mac }),
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

  /** Saves (or replaces) the account's one recovery backup. */
  putRecovery(userId: string, backup: RecoveryBackupRequest): RecoveryRecord {
    const updatedAt = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO e2e_recovery(user_id,device_id,salt,check_value,sealed,updated_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET device_id=excluded.device_id, salt=excluded.salt,
           check_value=excluded.check_value, sealed=excluded.sealed, updated_at=excluded.updated_at`,
      )
      .run(userId, backup.device_id, backup.salt, backup.check, backup.sealed, updatedAt);
    return { ...backup, updated_at: updatedAt };
  }

  /** This account's backup; never another account's. */
  recovery(userId: string): RecoveryRecord | undefined {
    const row = this.db.prepare('SELECT * FROM e2e_recovery WHERE user_id=?').get(userId) as
      RecoveryRow | undefined;
    return (
      row && {
        device_id: row.device_id,
        salt: row.salt,
        check: row.check_value,
        sealed: row.sealed,
        updated_at: row.updated_at,
      }
    );
  }

  deleteRecovery(userId: string): boolean {
    return (
      Number(this.db.prepare('DELETE FROM e2e_recovery WHERE user_id=?').run(userId).changes) > 0
    );
  }

  private approvalFrom(row: ApprovalRow): PhoneApproval {
    const open = row.state === 'pending' || row.state === 'claimed';
    const expired = open && Date.parse(row.expires_at) <= this.now().getTime();
    return {
      id: row.id,
      state: (expired ? 'expired' : row.state) as PhoneApproval['state'],
      device_id: row.device_id,
      name: row.name,
      public_key: row.public_key,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ...(row.approver_id !== null &&
        row.approver_name !== null &&
        row.approver_key !== null && {
          approver: { id: row.approver_id, name: row.approver_name, public_key: row.approver_key },
        }),
      ...(typeof row.commitment === 'string' && { commitment: row.commitment }),
      ...(typeof row.approver_nonce === 'string' && { approver_nonce: row.approver_nonce }),
      ...(typeof row.reveal === 'string' && { reveal: row.reveal }),
      ...(row.note !== null && { trust_note: trustNoteSchema.parse(JSON.parse(row.note)) }),
    };
  }

  /**
   * A new phone asks to be approved (C3 #11, Task 27). Its open request, if any, is replaced; an
   * account holds at most MAX_OPEN_APPROVALS open ones. Refused when the phone is already active
   * (unless it asks as a second phone, ADR-045), when the person removed this device id (it stays
   * removed: the phone asks again with a new key), or when a new phone finds the account at the
   * device cap.
   */
  requestApproval(userId: string, request: PhoneApprovalRequest, expiresAt: Date): PhoneApproval {
    const now = this.now().toISOString();
    const id = newApprovalId();
    this.transaction(() => {
      const self = this.db
        .prepare(
          'SELECT public_key FROM e2e_devices WHERE user_id=? AND id=? AND revoked_at IS NULL',
        )
        .get(userId, request.device_id) as { public_key: string } | undefined;
      if (self !== undefined) {
        const others = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM e2e_devices WHERE user_id=? AND kind='phone' AND id<>? AND revoked_at IS NULL",
          )
          .get(userId, request.device_id) as { n: number };
        // ADR-045: an already-paired phone may ask another phone to approve it.
        if (self.public_key !== request.public_key || others.n === 0)
          throw new E2eDeviceError('already_added');
      } else {
        // Its accept could never add it (`insertDevice` refuses a removed id), so the request
        // would wait in vain until it expires.
        const removed = this.db
          .prepare('SELECT 1 FROM e2e_devices WHERE user_id=? AND id=? AND revoked_at IS NOT NULL')
          .get(userId, request.device_id);
        if (removed !== undefined) throw new E2eDeviceError('device_removed');
        const active = this.db
          .prepare('SELECT COUNT(*) AS n FROM e2e_devices WHERE user_id=? AND revoked_at IS NULL')
          .get(userId) as { n: number };
        if (active.n >= MAX_PAIRED_DEVICES) throw new E2eDeviceError('device_cap');
      }
      this.db
        .prepare(
          "DELETE FROM e2e_phone_approvals WHERE user_id=? AND device_id=? AND state IN ('pending','claimed')",
        )
        .run(userId, request.device_id);
      const open = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM e2e_phone_approvals WHERE user_id=? AND state IN ('pending','claimed') AND expires_at>?",
        )
        .get(userId, now) as { n: number };
      if (open.n >= MAX_OPEN_APPROVALS) throw new E2eDeviceError('approval_cap');
      this.db
        .prepare(
          "INSERT INTO e2e_phone_approvals(id,user_id,device_id,public_key,name,state,created_at,expires_at,commitment) VALUES(?,?,?,?,?,'pending',?,?,?)",
        )
        .run(
          id,
          userId,
          request.device_id,
          request.public_key,
          request.name,
          now,
          expiresAt.toISOString(),
          request.commitment ?? null,
        );
    });
    return this.approval(userId, id)!;
  }

  /** This account's approval; never another account's. */
  approval(userId: string, id: string): PhoneApproval | undefined {
    const row = this.db
      .prepare('SELECT * FROM e2e_phone_approvals WHERE id=? AND user_id=?')
      .get(id, userId) as ApprovalRow | undefined;
    return row && this.approvalFrom(row);
  }

  /** The account's open (pending or claimed, not expired) approvals, oldest first. */
  openApprovals(userId: string): PhoneApproval[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM e2e_phone_approvals WHERE user_id=? AND state IN ('pending','claimed') AND expires_at>? ORDER BY created_at, id",
        )
        .all(userId, this.now().toISOString()) as ApprovalRow[]
    ).map((row) => this.approvalFrom(row));
  }

  /** A trusted phone takes a pending approval (or the one it already took). */
  claimApproval(userId: string, id: string, approver: E2eDevice): boolean {
    const result = this.db
      .prepare(
        "UPDATE e2e_phone_approvals SET state='claimed', approver_id=?, approver_name=?, approver_key=? WHERE id=? AND user_id=? AND expires_at>? AND (state='pending' OR (state='claimed' AND approver_id=?))",
      )
      .run(
        approver.id,
        approver.name,
        approver.public_key,
        id,
        userId,
        this.now().toISOString(),
        approver.id,
      );
    return Number(result.changes) > 0;
  }

  /**
   * The approving phone that claimed the approval sets its nonce (ADR-046): once, only while the
   * approval is claimed by it, open, and carries the new phone's commitment.
   */
  setApproverNonce(userId: string, id: string, approverId: string, nonce: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE e2e_phone_approvals SET approver_nonce=? WHERE id=? AND user_id=? AND state='claimed' AND approver_id=? AND commitment IS NOT NULL AND approver_nonce IS NULL AND expires_at>?",
      )
      .run(nonce, id, userId, approverId, this.now().toISOString());
    return Number(result.changes) > 0;
  }

  /**
   * The new phone reveals its secret (ADR-046): once, only after the approver's nonce is set,
   * while the approval is open.
   */
  setReveal(userId: string, id: string, deviceId: string, reveal: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE e2e_phone_approvals SET reveal=? WHERE id=? AND user_id=? AND device_id=? AND state='claimed' AND approver_nonce IS NOT NULL AND reveal IS NULL AND expires_at>?",
      )
      .run(reveal, id, userId, deviceId, this.now().toISOString());
    return Number(result.changes) > 0;
  }

  /**
   * The approving phone says the codes matched: the new phone joins the account's devices with
   * the note on its row, and the approval keeps the note for the new phone's next poll. Throws
   * E2eDeviceError at the device cap (nothing changes then). A request that carries a commitment
   * (ADR-046) is accepted only after the nonce and the reveal, so an older approving app, which
   * shows the code that can be ground, cannot add a phone that is waiting for the new code. Such a
   * try turns the request down, so the new phone ends at once instead of when it expires.
   */
  acceptApproval(userId: string, id: string, approverId: string, note: TrustNote): boolean {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM e2e_phone_approvals WHERE id=? AND user_id=? AND state='claimed' AND approver_id=? AND expires_at>? AND (commitment IS NULL OR (approver_nonce IS NOT NULL AND reveal IS NOT NULL))",
        )
        .get(id, userId, approverId, this.now().toISOString()) as ApprovalRow | undefined;
      if (row === undefined) {
        this.db
          .prepare(
            "UPDATE e2e_phone_approvals SET state='denied' WHERE id=? AND user_id=? AND state='claimed' AND approver_id=? AND commitment IS NOT NULL AND (approver_nonce IS NULL OR reveal IS NULL)",
          )
          .run(id, userId, approverId);
        return false;
      }
      this.insertDevice(
        userId,
        { id: row.device_id, kind: 'phone', name: row.name, public_key: row.public_key },
        note,
      );
      this.db
        .prepare("UPDATE e2e_phone_approvals SET state='accepted', note=? WHERE id=?")
        .run(JSON.stringify(note), id);
      return true;
    });
  }

  /** An active phone of the account turns an open approval down. */
  denyApproval(userId: string, id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE e2e_phone_approvals SET state='denied' WHERE id=? AND user_id=? AND state IN ('pending','claimed') AND expires_at>?",
      )
      .run(id, userId, this.now().toISOString());
    return Number(result.changes) > 0;
  }

  /** Delete my data: every device, offer, approval and recovery backup of the account. Returns the devices removed. */
  deleteAllForUser(userId: string): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM e2e_phone_approvals WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM e2e_pair_offers WHERE user_id=?').run(userId);
      this.db.prepare('DELETE FROM e2e_recovery WHERE user_id=?').run(userId);
      return Number(this.db.prepare('DELETE FROM e2e_devices WHERE user_id=?').run(userId).changes);
    });
  }

  close(): void {
    this.db.close();
  }
}
