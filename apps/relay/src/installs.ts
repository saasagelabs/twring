import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ringServiceStateSchema } from '@twring/contracts';
import { z } from 'zod';

import type { RelayDb } from './db';

type RingServiceState = z.infer<typeof ringServiceStateSchema>;

/** One registered self-hosted server. */
export interface Install {
  id: string;
  serverId: string;
  /** Raw Ed25519 public key, unpadded base64url. */
  publicKey: string;
  email: string;
  news: boolean;
  address?: string;
  verifiedAt?: string;
  createdAt: string;
  /** When the email address was set (registration or a later change). */
  emailChangedAt?: string;
  paidUntil: string;
  partnerId?: string;
  revokedAt?: string;
}

/** Unverified installs keep ringing this long, then pause until the address is confirmed. */
export const UNVERIFIED_GRACE_MS = 7 * 86_400_000;
/** The email link works this long. */
export const VERIFY_LINK_TTL_MS = 7 * 86_400_000;

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time equality of two strings (compared as SHA-256 digests, so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/** A relay key: `twr_` + 32 random bytes, base64url. Shown once; only its hash is stored. */
export function newRelayKey(): string {
  return `twr_${randomBytes(32).toString('base64url')}`;
}

export function newLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * An email address as stored and as counted for the per-address cap: the domain is lower-cased
 * (domains are case-insensitive), the local part kept as given.
 */
export function normalizeEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`;
}

/**
 * How an address is kept in `email_sends` (the per-address cap): a SHA-256 of the lower-cased
 * address, never the address itself.
 */
export function emailSendKey(email: string): string {
  return sha256Hex(normalizeEmail(email).toLowerCase());
}

/** Two base64url public keys hold the same bytes (compared in constant time). */
export function samePublicKey(a: string, b: string): boolean {
  const left = Buffer.from(a, 'base64url');
  const right = Buffer.from(b, 'base64url');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The ring service state an install is in at `now`. */
export function ringState(install: Install, now: number): RingServiceState {
  if (now >= Date.parse(install.paidUntil)) return 'expired';
  if (install.verifiedAt !== undefined) return 'active';
  // A new address gets a fresh grace: count from the later of creation and the last change.
  const from = Math.max(
    Date.parse(install.createdAt),
    install.emailChangedAt === undefined ? 0 : Date.parse(install.emailChangedAt),
  );
  return now - from < UNVERIFIED_GRACE_MS ? 'unverified' : 'paused';
}

interface InstallRow {
  id: string;
  server_id: string;
  public_key: string;
  email: string;
  news: number;
  address: string | null;
  partner_id: string | null;
  key_hash: string;
  verified_at: string | null;
  created_at: string;
  email_changed_at: string | null;
  paid_until: string;
  revoked_at: string | null;
}

function toInstall(row: InstallRow): Install {
  return {
    id: row.id,
    serverId: row.server_id,
    publicKey: row.public_key,
    email: row.email,
    news: row.news === 1,
    ...(row.address !== null && { address: row.address }),
    ...(row.verified_at !== null && { verifiedAt: row.verified_at }),
    createdAt: row.created_at,
    ...(row.email_changed_at !== null && { emailChangedAt: row.email_changed_at }),
    paidUntil: row.paid_until,
    ...(row.partner_id !== null && { partnerId: row.partner_id }),
    ...(row.revoked_at !== null && { revokedAt: row.revoked_at }),
  };
}

export interface NewInstall {
  serverId: string;
  publicKey: string;
  email: string;
  news: boolean;
  address?: string;
  partnerId?: string;
  paidUntil: string;
}

/** Installs in SQLite. Keys and link tokens are stored as SHA-256 hashes only. */
export class InstallStore {
  constructor(private readonly db: RelayDb) {}

  findByServerId(serverId: string): Install | undefined {
    const row = this.db.sqlite
      .prepare('SELECT * FROM installs WHERE server_id = ?')
      .get(serverId) as InstallRow | undefined;
    return row === undefined ? undefined : toInstall(row);
  }

  findById(id: string): Install | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM installs WHERE id = ?').get(id) as
      InstallRow | undefined;
    return row === undefined ? undefined : toInstall(row);
  }

  /** The install a relay key belongs to (looked up by hash, then compared in constant time). */
  findByKey(key: string): Install | undefined {
    const hash = sha256Hex(key);
    const row = this.db.sqlite.prepare('SELECT * FROM installs WHERE key_hash = ?').get(hash) as
      InstallRow | undefined;
    if (row === undefined || !safeEqual(row.key_hash, hash)) return undefined;
    return toInstall(row);
  }

  /** Creates an install; returns it with its key (shown once). Its email is queued by the caller. */
  create(input: NewInstall, now: number): { install: Install; key: string } {
    const id = `ins_${randomBytes(16).toString('base64url')}`;
    const key = newRelayKey();
    this.db.sqlite
      .prepare(
        `INSERT INTO installs (id, server_id, public_key, email, news, address, partner_id, key_hash,
           created_at, paid_until, email_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.serverId,
        input.publicKey,
        input.email,
        input.news ? 1 : 0,
        input.address ?? null,
        input.partnerId ?? null,
        sha256Hex(key),
        new Date(now).toISOString(),
        input.paidUntil,
        new Date(now).toISOString(),
      );
    return { install: this.findById(id)!, key };
  }

  /**
   * The same server registering again (proved by its key): a new relay key replaces the old one.
   * `paid_until`, the partner and creation time are kept. A changed email needs confirming again
   * (its old link stops working and the last-sent time resets, so a new email can go at once).
   */
  reissue(
    existing: Install,
    input: { email: string; news: boolean; address?: string },
    now: number,
  ): { install: Install; key: string } {
    const key = newRelayKey();
    const sameEmail = existing.email === input.email;
    this.db.sqlite
      .prepare(
        `UPDATE installs SET key_hash = ?, email = ?, news = ?, address = ?,
           verified_at = CASE WHEN ? THEN verified_at ELSE NULL END,
           verify_hash = CASE WHEN ? THEN verify_hash ELSE NULL END,
           verify_expires_at = CASE WHEN ? THEN verify_expires_at ELSE NULL END,
           last_email_at = CASE WHEN ? THEN last_email_at ELSE NULL END,
           email_changed_at = CASE WHEN ? THEN ? ELSE email_changed_at END
         WHERE id = ?`,
      )
      .run(
        sha256Hex(key),
        input.email,
        input.news ? 1 : 0,
        input.address ?? existing.address ?? null,
        sameEmail ? 1 : 0,
        sameEmail ? 1 : 0,
        sameEmail ? 1 : 0,
        sameEmail ? 1 : 0,
        // A fresh ring grace only when a confirmed address is replaced; changing an unconfirmed
        // one keeps the original grace start, so alternating addresses cannot ring for ever.
        !sameEmail && existing.verifiedAt !== undefined ? 1 : 0,
        new Date(now).toISOString(),
        existing.id,
      );
    return { install: this.findById(existing.id)!, key };
  }

  /** When the last verification email to this install went out (ms), if ever. */
  lastEmailAt(id: string): number | undefined {
    const row = this.db.sqlite
      .prepare('SELECT last_email_at FROM installs WHERE id = ?')
      .get(id) as { last_email_at: number | null } | undefined;
    return row?.last_email_at ?? undefined;
  }

  /**
   * Records a registration proof's id until it expires. False when it was already used: a
   * replayed proof must never mint a new key.
   */
  useProof(jti: string, expiresAt: number, now: number): boolean {
    this.db.sqlite.prepare('DELETE FROM proofs_used WHERE expires_at <= ?').run(now);
    const result = this.db.sqlite
      .prepare('INSERT OR IGNORE INTO proofs_used (jti, expires_at) VALUES (?, ?)')
      .run(jti, expiresAt);
    return result.changes === 1;
  }

  /** Uses an email link token once. True when it confirmed an install. */
  verify(linkToken: string, now: number): boolean {
    const hash = sha256Hex(linkToken);
    const result = this.db.sqlite
      .prepare(
        `UPDATE installs SET verified_at = ?, verify_hash = NULL, verify_expires_at = NULL
         WHERE verify_hash = ? AND verify_expires_at > ? AND revoked_at IS NULL`,
      )
      .run(new Date(now).toISOString(), hash, new Date(now).toISOString());
    return result.changes === 1;
  }

  /** Sets where the relay may probe this install (the only place it ever probes for it). */
  setAddress(id: string, address: string): void {
    this.db.sqlite.prepare('UPDATE installs SET address = ? WHERE id = ?').run(address, id);
  }

  /**
   * Deletes an install and everything the relay keeps for it: phones, daily usage and call audio
   * records, and its address's send records (the server's own `DELETE /v1/installs/self`, run by `twring uninstall`).
   */
  delete(id: string): void {
    const db = this.db.sqlite;
    const email = this.findById(id)?.email;
    db.exec('BEGIN');
    try {
      if (email !== undefined) {
        db.prepare('DELETE FROM email_sends WHERE address = ?').run(emailSendKey(email));
      }
      for (const table of ['devices', 'usage_daily', 'audio_sessions']) {
        db.prepare(`DELETE FROM ${table} WHERE install_id = ?`).run(id);
      }
      db.prepare('DELETE FROM installs WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Every install registered with `email`, compared without case. */
  idsByEmail(email: string): string[] {
    return (
      this.db.sqlite
        .prepare('SELECT id FROM installs WHERE LOWER(email) = LOWER(?)')
        .all(email.trim()) as { id: string }[]
    ).map((row) => row.id);
  }

  /** Drops the hashed send records of an address (privacy requests). */
  forgetEmailSends(email: string): void {
    this.db.sqlite
      .prepare('DELETE FROM email_sends WHERE address = ?')
      .run(emailSendKey(email.trim()));
  }

  /** Revokes an install's key for good. False when there is no such install. */
  revoke(id: string, now: number): boolean {
    const result = this.db.sqlite
      .prepare('UPDATE installs SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(new Date(now).toISOString(), id);
    return result.changes === 1;
  }
}

/** A partner allowed to create installs for its customers. Only the token's hash is kept. */
export interface Partner {
  id: string;
  tokenHash: string;
}

const partnersFileSchema = z.array(
  z.object({
    id: z.string().min(1).max(64),
    token_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
);

/** Reads `RELAY_PARTNER_TOKENS_FILE`: `[{ id, token_sha256 }]`. */
export async function loadPartners(file: string): Promise<Partner[]> {
  const parsed = partnersFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  return parsed.map((entry) => ({ id: entry.id, tokenHash: entry.token_sha256 }));
}

/** The partner a token belongs to. Checks every partner in constant time. */
export function partnerFor(partners: readonly Partner[], token: string): Partner | undefined {
  const hash = sha256Hex(token);
  let found: Partner | undefined;
  for (const partner of partners) {
    if (safeEqual(partner.tokenHash, hash)) found = partner;
  }
  return found;
}
