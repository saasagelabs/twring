import { describe, expect, it } from 'vitest';

import {
  newRecoverySalt,
  normalizeRecoveryWords,
  openBackup,
  recoveryBackupRequestSchema,
  recoveryCheck,
  RecoveryError,
  recoveryKeyFrom,
  recoveryKeyFromAsync,
  recoveryWords,
  sealBackup,
} from './recovery';
import { base64urlDecode, base64urlEncode } from './seal-core';

const salt = new Uint8Array(16).fill(7);
const devicePrivate = new Uint8Array(32).fill(9);
const binding = { account: 'hosted_u1', deviceId: `dev_${'a'.repeat(20)}` };

/** Another word for the last place that keeps the checksum wrong or right, never the same. */
function oneWrong(words: string[]): string[] {
  return [...words.slice(0, 11), words[11] === 'abandon' ? 'ability' : 'abandon'];
}

describe('recovery key', () => {
  it('makes 12 different valid words each time', () => {
    const a = recoveryWords();
    const b = recoveryWords();
    expect(a).toHaveLength(12);
    expect(normalizeRecoveryWords(a)).toEqual(a);
    expect(a).not.toEqual(b);
  });

  it('restores the device key from the words', () => {
    const words = recoveryWords();
    const backup = sealBackup(recoveryKeyFrom(words, salt), devicePrivate, binding);
    expect(openBackup(recoveryKeyFrom(words, salt), backup, binding)).toEqual(devicePrivate);
  });

  it('refuses one wrong word', () => {
    const words = recoveryWords();
    const sealed = sealBackup(recoveryKeyFrom(words, salt), devicePrivate, binding);
    expect(() => openBackup(recoveryKeyFrom(oneWrong(words), salt), sealed, binding)).toThrow();
  });

  it('reads words in any case with extra spaces, and rejects a bad checksum locally', () => {
    const words = recoveryWords();
    const typed = `  ${words.slice(0, 6).join('   ').toUpperCase()}\n${words.slice(6).join(' ')}  `;
    expect(normalizeRecoveryWords(typed)).toEqual(words);
    expect(normalizeRecoveryWords(words.slice(0, 11))).toBeUndefined();
    // A word that is not in the list never passes.
    expect(normalizeRecoveryWords([...words.slice(0, 11), 'twring'])).toBeUndefined();
    expect(() => recoveryKeyFrom([...words.slice(0, 11), 'twring'], salt)).toThrow(RecoveryError);
  });

  it('derives the same key sync and async, and another key for another salt', async () => {
    const words = recoveryWords();
    const key = recoveryKeyFrom(words, salt);
    expect(key).toHaveLength(32);
    expect(await recoveryKeyFromAsync(words, salt)).toEqual(key);
    expect(recoveryKeyFrom(words, newRecoverySalt())).not.toEqual(key);
  });

  it('tells wrong words apart from a damaged backup with the check value', () => {
    const words = recoveryWords();
    const key = recoveryKeyFrom(words, salt);
    const check = recoveryCheck(key);
    const sealed = sealBackup(key, devicePrivate, binding);
    const other = recoveryKeyFrom(recoveryWords(), salt);
    expect(() => openBackup(other, sealed, binding, check)).toThrow(
      expect.objectContaining({ code: 'wrong_words' }),
    );
    const bytes = base64urlDecode(sealed);
    bytes[30] = bytes[30]! ^ 1;
    expect(() => openBackup(key, base64urlEncode(bytes), binding, check)).toThrow(
      expect.objectContaining({ code: 'damaged' }),
    );
    expect(() => openBackup(key, 'abc', binding, check)).toThrow(
      expect.objectContaining({ code: 'damaged' }),
    );
  });

  it('binds the account and the device id', () => {
    const words = recoveryWords();
    const key = recoveryKeyFrom(words, salt);
    const sealed = sealBackup(key, devicePrivate, binding);
    expect(() => openBackup(key, sealed, { ...binding, account: 'hosted_u2' })).toThrow();
    expect(() =>
      openBackup(key, sealed, { ...binding, deviceId: `dev_${'b'.repeat(20)}` }),
    ).toThrow();
  });

  it('the upload shape has room for no words', () => {
    const words = recoveryWords();
    const key = recoveryKeyFrom(words, salt);
    const body = {
      device_id: binding.deviceId,
      salt: base64urlEncode(salt),
      check: recoveryCheck(key),
      sealed: sealBackup(key, devicePrivate, binding),
    };
    expect(recoveryBackupRequestSchema.parse(body)).toEqual(body);
    expect(recoveryBackupRequestSchema.safeParse({ ...body, words }).success).toBe(false);
  });
});
