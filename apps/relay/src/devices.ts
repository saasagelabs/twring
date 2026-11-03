import { randomBytes } from 'node:crypto';

import { RELAY_TICKET_AUDIENCE } from '@twring/contracts';
import { decodeJwt, importJWK, jwtVerify } from 'jose';

import type { RelayDb } from './db';
import { safeEqual, sha256Hex, type Install, type InstallStore } from './installs';

/** A ticket lives at most this long (`exp` no further ahead than now plus this), in seconds. */
export const TICKET_MAX_SECONDS = 600;

export const HANDLE_PATTERN = /^hnd_[A-Za-z0-9_-]{43}$/;

/** A phone of a self-hosted server, as the relay knows it: push tokens only. */
export interface RelayDevice {
  id: string;
  installId: string;
  platform: 'android' | 'ios';
  fcmToken?: string;
  voipToken?: string;
  apnsToken?: string;
}

export interface NewDevice {
  platform: 'android' | 'ios';
  fcmToken?: string;
  voipToken?: string;
  apnsToken?: string;
}

/** `hnd_` + 32 random bytes, base64url. Given to the server once; only its hash is stored. */
export function newHandle(): string {
  return `hnd_${randomBytes(32).toString('base64url')}`;
}

/**
 * The install and device id behind a device ticket: a compact EdDSA JWS by the key of the install
 * named in `iss`, for audience `twring-relay`, unexpired, at most 600 s ahead, with `sub` and `jti`.
 * Undefined for anything else (unknown or revoked server, wrong key, wrong audience, expired). The
 * caller still has to spend the `jti` once.
 */
export async function checkTicket(
  ticket: string,
  installs: InstallStore,
  now: number,
): Promise<{ install: Install; deviceRef: string; jti: string; expiresAt: number } | undefined> {
  try {
    const unverified = decodeJwt(ticket);
    if (typeof unverified.iss !== 'string') return undefined;
    const install = installs.findByServerId(unverified.iss);
    if (install === undefined || install.revokedAt !== undefined) return undefined;
    const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: install.publicKey }, 'EdDSA');
    const { payload } = await jwtVerify(ticket, key, {
      algorithms: ['EdDSA'],
      audience: RELAY_TICKET_AUDIENCE,
      issuer: install.serverId,
      currentDate: new Date(now),
      requiredClaims: ['exp', 'sub', 'jti'],
    });
    const exp = payload.exp!;
    const sub = payload.sub!;
    const jti = payload.jti!;
    const holds =
      sub.length >= 1 &&
      sub.length <= 128 &&
      jti.length >= 1 &&
      jti.length <= 128 &&
      exp - Math.floor(now / 1000) <= TICKET_MAX_SECONDS;
    return holds ? { install, deviceRef: sub, jti, expiresAt: exp * 1000 } : undefined;
  } catch {
    return undefined;
  }
}

interface DeviceRow {
  id: string;
  install_id: string;
  handle_hash: string;
  platform: 'android' | 'ios';
  fcm_token: string | null;
  voip_token: string | null;
  apns_token: string | null;
}

function toDevice(row: DeviceRow): RelayDevice {
  return {
    id: row.id,
    installId: row.install_id,
    platform: row.platform,
    ...(row.fcm_token !== null && { fcmToken: row.fcm_token }),
    ...(row.voip_token !== null && { voipToken: row.voip_token }),
    ...(row.apns_token !== null && { apnsToken: row.apns_token }),
  };
}

/** Phones in SQLite. Handles are stored as SHA-256 hashes; tokens are kept to send pushes. */
export class DeviceStore {
  constructor(private readonly db: RelayDb) {}

  /**
   * Spends a ticket's id (scoped to its server) until it expires. False when it was already used.
   */
  useTicket(serverId: string, jti: string, expiresAt: number, now: number): boolean {
    this.db.sqlite.prepare('DELETE FROM tickets_used WHERE expires_at <= ?').run(now);
    const result = this.db.sqlite
      .prepare('INSERT OR IGNORE INTO tickets_used (jti, expires_at) VALUES (?, ?)')
      .run(`${serverId}:${jti}`, expiresAt);
    return result.changes === 1;
  }

  /**
   * Registers a phone under an install and returns its new handle (shown once). The same phone
   * registering again replaces its earlier record, so an old handle stops working.
   */
  register(installId: string, deviceRef: string, input: NewDevice, now: number): string {
    const handle = newHandle();
    const sqlite = this.db.sqlite;
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite
        .prepare('DELETE FROM devices WHERE install_id = ? AND device_ref = ?')
        .run(installId, deviceRef);
      // A token belongs to one install: another install's phone holding it moves here (its old
      // handle stops working).
      for (const token of [input.fcmToken, input.voipToken, input.apnsToken]) {
        if (token === undefined) continue;
        sqlite
          .prepare(
            `DELETE FROM devices WHERE install_id <> ?
               AND (fcm_token = ? OR voip_token = ? OR apns_token = ?)`,
          )
          .run(installId, token, token, token);
      }
      sqlite
        .prepare(
          `INSERT INTO devices (id, install_id, device_ref, handle_hash, platform, fcm_token,
             voip_token, apns_token, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `rdv_${randomBytes(16).toString('base64url')}`,
          installId,
          deviceRef,
          sha256Hex(handle),
          input.platform,
          input.fcmToken ?? null,
          input.voipToken ?? null,
          input.apnsToken ?? null,
          new Date(now).toISOString(),
        );
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
    return handle;
  }

  /** The live (not stale) phone behind `handle`, only when it belongs to `installId`. */
  findForInstall(handle: string, installId: string): RelayDevice | undefined {
    if (!HANDLE_PATTERN.test(handle)) return undefined;
    const hash = sha256Hex(handle);
    const row = this.db.sqlite
      .prepare('SELECT * FROM devices WHERE handle_hash = ? AND stale_at IS NULL')
      .get(hash) as DeviceRow | undefined;
    if (row === undefined || !safeEqual(row.handle_hash, hash)) return undefined;
    return row.install_id === installId ? toDevice(row) : undefined;
  }

  /** The push service said this phone's token is gone: the handle stops working. */
  markStale(id: string, now: number): void {
    this.db.sqlite
      .prepare('UPDATE devices SET stale_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), id);
  }

  /** Forgets a phone. False when the handle is unknown or belongs to another install. */
  remove(handle: string, installId: string): boolean {
    if (!HANDLE_PATTERN.test(handle)) return false;
    const result = this.db.sqlite
      .prepare('DELETE FROM devices WHERE handle_hash = ? AND install_id = ?')
      .run(sha256Hex(handle), installId);
    return result.changes === 1;
  }
}
