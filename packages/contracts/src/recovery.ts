import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { utf8ToBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { scrypt, scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { z } from 'zod';

import { base64urlDecode, base64urlEncode } from './seal-core';
import { e2eDeviceIdSchema } from './sealed-chat';

/**
 * Optional recovery key for private chats (ADR-044, C3 #11). The phone shows 12 BIP39 words
 * (128 bits with a checksum) once; scrypt turns them and a per-backup salt into a key that seals
 * the phone's device key. The server stores the salt, a short check value and the sealed backup,
 * never the words or the key, so it cannot open it. Pure @noble and @scure, so it runs in Hermes.
 */

export const RECOVERY_WORD_COUNT = 12;
export const RECOVERY_SALT_BYTES = 16;
/** scrypt cost: N=2^15, r=8, p=1 (about 32 MB), 32-byte output. */
export const RECOVERY_SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
/** Most characters of a sealed backup: a device key plus a short list of trusted computers. */
export const MAX_RECOVERY_SEALED_CHARS = 8_000;

const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const CHECK_BYTES = 8;
const LABEL = 'twring-recovery-v1';

export class RecoveryError extends Error {
  constructor(
    /** `wrong_words`: not 12 valid words, or not the words this backup was made with. */
    readonly code: 'wrong_words' | 'damaged',
  ) {
    super(code);
    this.name = 'RecoveryError';
  }
}

/** 12 fresh English words with a checksum. */
export function recoveryWords(): string[] {
  return generateMnemonic(wordlist, 128).split(' ');
}

/**
 * Words as people type them: any case, extra spaces or line breaks. Undefined unless they are 12
 * valid words with a matching checksum, so one wrong word fails before any network call.
 */
export function normalizeRecoveryWords(input: string | string[]): string[] | undefined {
  const text = Array.isArray(input) ? input.join(' ') : input;
  const words = text.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length !== RECOVERY_WORD_COUNT) return undefined;
  return validateMnemonic(words.join(' '), wordlist) ? words : undefined;
}

export function newRecoverySalt(): Uint8Array {
  return randomBytes(RECOVERY_SALT_BYTES);
}

function entropyOf(words: string[]): Uint8Array {
  const valid = normalizeRecoveryWords(words);
  if (valid === undefined) throw new RecoveryError('wrong_words');
  return mnemonicToEntropy(valid.join(' '), wordlist);
}

function checkSalt(salt: Uint8Array): void {
  if (salt.length !== RECOVERY_SALT_BYTES) throw new RecoveryError('damaged');
}

/** The recovery key for these words and salt. Throws `wrong_words` for invalid words. */
export function recoveryKeyFrom(words: string[], salt: Uint8Array): Uint8Array {
  checkSalt(salt);
  return scrypt(entropyOf(words), salt, RECOVERY_SCRYPT);
}

/** The same key without blocking the app for the whole scrypt run. */
export function recoveryKeyFromAsync(words: string[], salt: Uint8Array): Promise<Uint8Array> {
  checkSalt(salt);
  return scryptAsync(entropyOf(words), salt, RECOVERY_SCRYPT);
}

/** What a backup is bound to: this account (server and person) and the device it restores. */
export interface RecoveryBinding {
  account: string;
  deviceId: string;
}

function aad(binding: RecoveryBinding): Uint8Array {
  return utf8ToBytes(JSON.stringify([LABEL, binding.account, binding.deviceId]));
}

const subKey = (key: Uint8Array, info: string, length: number) =>
  hkdf(sha256, key, undefined, utf8ToBytes(`${LABEL}-${info}`), length);

/** A short value that tells wrong words apart from a damaged backup. */
export function recoveryCheck(key: Uint8Array): string {
  return base64urlEncode(subKey(key, 'check', CHECK_BYTES));
}

/** Seals `plaintext` (the device key payload): base64url of nonce then ciphertext and tag. */
export function sealBackup(
  key: Uint8Array,
  plaintext: Uint8Array,
  binding: RecoveryBinding,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(subKey(key, 'seal', 32), nonce, aad(binding)).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce);
  out.set(sealed, NONCE_BYTES);
  return base64urlEncode(out);
}

/**
 * Opens a backup. With `check`, a key that does not match it throws `wrong_words`; anything else
 * that fails (a changed byte, another account or device) throws `damaged`.
 */
export function openBackup(
  key: Uint8Array,
  sealed: string,
  binding: RecoveryBinding,
  check?: string,
): Uint8Array {
  if (check !== undefined && !checkMatches(key, check)) throw new RecoveryError('wrong_words');
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(sealed);
  } catch {
    throw new RecoveryError('damaged');
  }
  if (bytes.length < NONCE_BYTES + TAG_BYTES) throw new RecoveryError('damaged');
  try {
    return xchacha20poly1305(
      subKey(key, 'seal', 32),
      bytes.subarray(0, NONCE_BYTES),
      aad(binding),
    ).decrypt(bytes.subarray(NONCE_BYTES));
  } catch {
    throw new RecoveryError(check === undefined ? 'wrong_words' : 'damaged');
  }
}

/** True when the key matches a stored check value (constant time). */
function checkMatches(key: Uint8Array, check: string): boolean {
  let stored: Uint8Array;
  try {
    stored = base64urlDecode(check);
  } catch {
    return false;
  }
  const mine = subKey(key, 'check', CHECK_BYTES);
  if (stored.length !== mine.length) return false;
  let diff = 0;
  for (let i = 0; i < mine.length; i++) diff |= mine[i]! ^ stored[i]!;
  return diff === 0;
}

const b64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/** `PUT /v1/e2e/recovery`: everything the server keeps. No words, no key. */
export const recoveryBackupRequestSchema = z
  .object({
    device_id: e2eDeviceIdSchema,
    /** 16 bytes, unpadded base64url. */
    salt: b64url(22, 22),
    /** 8 bytes, unpadded base64url. */
    check: b64url(11, 11),
    sealed: b64url(1, MAX_RECOVERY_SEALED_CHARS),
  })
  .strict();
export type RecoveryBackupRequest = z.infer<typeof recoveryBackupRequestSchema>;

/** `GET /v1/e2e/recovery`: the backup, and whether its device was removed from the account. */
export const recoveryBackupResponseSchema = recoveryBackupRequestSchema
  .extend({ updated_at: z.iso.datetime(), device_removed: z.boolean() })
  .strict();
export type RecoveryBackupResponse = z.infer<typeof recoveryBackupResponseSchema>;
