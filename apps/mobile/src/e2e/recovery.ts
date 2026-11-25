import { x25519 } from '@noble/curves/ed25519.js';
import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  newRecoverySalt,
  normalizeRecoveryWords,
  openBackup,
  publicKeySchema,
  recoveryBackupResponseSchema,
  recoveryCheck,
  RecoveryError,
  recoveryKeyFromAsync,
  recoveryWords,
  sealBackup,
  type RecoveryBackupRequest,
  type RecoveryBackupResponse,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadDeviceKey, restoreDeviceKey, TRUSTED_KEY_NAME } from './device-key';
import { loadTrusted, trustedDeviceSchema } from './pairing';

/**
 * Optional recovery key for private chats (C3 #11, ADR-044). The phone shows 12 words once and
 * seals its device key, with the computers it verified, under a key made from them. Only the salt,
 * a check value and the sealed backup go to the server. The words are never stored, logged or
 * sent: they live in the screen's state until it closes. A restored phone has the same key, so
 * the same device id, and its computers need no new pairing.
 */

/** The words the person types back to show they wrote them down (1-based). */
export const RECOVERY_CHECK_POSITIONS = [3, 9] as const;

export const RECOVERY_COPY = {
  offer: "Save a recovery key? Without it, a new phone can't read old private messages.",
  wrongWords: "Those words don't match. Check them and try again.",
  damaged:
    "This recovery key can't be opened here, so nothing was changed. Pair this phone with your computer instead.",
  removed:
    'This recovery key belongs to a phone that was removed from Private chats, so it no longer works. Pair this phone with your computer instead.',
  network: 'Twring could not reach the server. Check your connection and try again.',
  hasKey: 'This phone is already set up for private chats.',
  noDevice: 'Pair this phone with your computer first, then save a recovery key.',
  refused:
    'This phone is not set up for private chats on this account any more. Pair it again first.',
} as const;

export interface RecoveryApi {
  /** `GET /v1/e2e/recovery` */
  get(): Promise<{ status: number; body: unknown }>;
  /** `PUT /v1/e2e/recovery`: salt, check value and sealed backup only. */
  put(body: RecoveryBackupRequest): Promise<{ status: number; body: unknown }>;
  /** `DELETE /v1/e2e/recovery` */
  remove(): Promise<{ status: number; body: unknown }>;
}

export interface RecoveryDeps {
  api: RecoveryApi;
  store: SecureKeyValue;
  /** This server and account (`currentScope`): bound into the backup. */
  account: string;
  now?: () => number;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

const payloadSchema = z
  .object({
    v: z.literal(1),
    private_key: publicKeySchema,
    trusted: z.array(trustedDeviceSchema).max(16),
  })
  .strict();

export function newRecoveryWords(): string[] {
  return recoveryWords();
}

/** Whether the typed words are the shown words at RECOVERY_CHECK_POSITIONS, in any case. */
export function wroteDown(words: string[], typed: readonly string[]): boolean {
  return RECOVERY_CHECK_POSITIONS.every(
    (position, i) => (typed[i] ?? '').trim().toLowerCase() === words[position - 1],
  );
}

export type SaveFailure = 'no_device' | 'network' | 'refused';

export async function saveRecoveryKey(
  deps: RecoveryDeps,
  words: string[],
): Promise<{ ok: true } | { ok: false; code: SaveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return { ok: false, code: 'no_device' };
  const trusted = await loadTrusted(deps.store);
  const salt = newRecoverySalt();
  const key = await recoveryKeyFromAsync(words, salt);
  const payload = new TextEncoder().encode(
    JSON.stringify({ v: 1, private_key: base64urlEncode(me.privateKey), trusted }),
  );
  const body: RecoveryBackupRequest = {
    device_id: me.deviceId,
    salt: base64urlEncode(salt),
    check: recoveryCheck(key),
    sealed: sealBackup(key, payload, { account: deps.account, deviceId: me.deviceId }),
  };
  let answer: { status: number };
  try {
    answer = await deps.api.put(body);
  } catch {
    deps.log?.('e2e_recovery_save_failed', { reason: 'network' });
    return { ok: false, code: 'network' };
  }
  if (answer.status < 200 || answer.status >= 300) {
    const code = answer.status === 404 ? 'refused' : 'network';
    deps.log?.('e2e_recovery_save_failed', { reason: code, status: answer.status });
    return { ok: false, code };
  }
  deps.log?.('e2e_recovery_saved', { trusted: trusted.length });
  return { ok: true };
}

export type BackupLookup =
  | { kind: 'none' }
  | { kind: 'removed' }
  | { kind: 'network' }
  | { kind: 'found'; backup: RecoveryBackupResponse };

/**
 * Whether to offer a restore: only on a phone with no device key, and only when the server holds
 * a backup. A backup for a removed phone is reported so the screen can say so.
 */
export async function restoreOffer(
  deps: Pick<RecoveryDeps, 'api' | 'store'>,
): Promise<BackupLookup> {
  if ((await loadDeviceKey(deps.store)) !== undefined) return { kind: 'none' };
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.api.get();
  } catch {
    return { kind: 'network' };
  }
  if (answer.status === 404) return { kind: 'none' };
  if (answer.status < 200 || answer.status >= 300) return { kind: 'network' };
  const parsed = recoveryBackupResponseSchema.safeParse(answer.body);
  if (!parsed.success) return { kind: 'none' };
  return parsed.data.device_removed ? { kind: 'removed' } : { kind: 'found', backup: parsed.data };
}

export type RestoreFailure = 'wrong_words' | 'damaged' | 'has_key';

/** Opens the backup with the typed words and puts the device key and its computers back. */
export async function restoreFromWords(
  deps: RecoveryDeps,
  backup: RecoveryBackupResponse,
  typed: string,
): Promise<{ ok: true; deviceId: string } | { ok: false; code: RestoreFailure }> {
  const fail = (code: RestoreFailure) => {
    deps.log?.('e2e_recovery_restore_failed', { reason: code });
    return { ok: false as const, code };
  };
  // Checked on the phone first: a wrong word never costs a server call or a scrypt run.
  const words = normalizeRecoveryWords(typed);
  if (words === undefined) return fail('wrong_words');
  if ((await loadDeviceKey(deps.store)) !== undefined) return fail('has_key');
  let payload: z.infer<typeof payloadSchema>;
  let privateKey: Uint8Array;
  try {
    const key = await recoveryKeyFromAsync(words, base64urlDecode(backup.salt));
    const opened = openBackup(
      key,
      backup.sealed,
      { account: deps.account, deviceId: backup.device_id },
      backup.check,
    );
    const parsed = payloadSchema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    if (!parsed.success) return fail('damaged');
    payload = parsed.data;
    privateKey = base64urlDecode(payload.private_key);
    // The key must be the device the server named, or nothing is restored.
    if (deviceIdFor(x25519.getPublicKey(privateKey)) !== backup.device_id) return fail('damaged');
  } catch (error) {
    return fail(error instanceof RecoveryError ? error.code : 'damaged');
  }
  const restored = await restoreDeviceKey(deps.store, privateKey, deps.now);
  await deps.store.setItemAsync(TRUSTED_KEY_NAME, JSON.stringify(payload.trusted));
  deps.log?.('e2e_recovery_restored', { trusted: payload.trusted.length });
  return { ok: true, deviceId: restored.deviceId };
}

/** Removes the server's copy (the words alone open nothing without it). */
export async function deleteRecoveryKey(deps: Pick<RecoveryDeps, 'api'>): Promise<boolean> {
  try {
    const answer = await deps.api.remove();
    return answer.status >= 200 && answer.status < 300;
  } catch {
    return false;
  }
}
