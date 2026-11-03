import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { CredentialKeys } from '@twring/config/gateway';
import type { SpeechProvider } from '@twring/contracts';
import { z } from 'zod';

const IV_BYTES = 12;
/** GCM tags are pinned to the full 16 bytes: a truncated tag weakens forgery resistance. */
const TAG_BYTES = 16;

const base64Bytes = (length: number) =>
  z.string().refine((value) => Buffer.from(value, 'base64').length === length, {
    message: `must be ${length} bytes of base64`,
  });

/** A sealed secret as stored. None of these fields is secret on its own. */
export const sealedSecretSchema = z.object({
  alg: z.literal('aes-256-gcm'),
  key_version: z.number().int().min(1),
  iv: base64Bytes(IV_BYTES),
  ciphertext: z.string(),
  tag: base64Bytes(TAG_BYTES),
});
export type SealedSecret = z.infer<typeof sealedSecretSchema>;

/** Decryption failed: wrong key, unknown key version, tampering, or a mismatched owner. */
export class CredentialDecryptError extends Error {
  constructor() {
    super('credential could not be decrypted');
    this.name = 'CredentialDecryptError';
  }
}

/**
 * AES-256-GCM with a random 12-byte IV per secret. The additional data binds a ciphertext to its
 * owner (user and agent), so a sealed secret copied onto another agent does not decrypt. New
 * secrets use the current key; older versions stay readable while their keys are configured.
 */
export class CredentialCipher {
  private readonly keys: ReadonlyMap<number, Buffer>;
  private readonly currentVersion: number;

  constructor(config: CredentialKeys) {
    const keys = new Map<number, Buffer>();
    for (const [version, key] of config.keys) {
      const bytes = Buffer.from(key, 'base64');
      if (bytes.length !== 32) throw new Error(`credential key version ${version} is not 32 bytes`);
      keys.set(version, bytes);
    }
    if (!keys.has(config.currentVersion)) throw new Error('current credential key is missing');
    this.keys = keys;
    this.currentVersion = config.currentVersion;
  }

  seal(plaintext: string, aad: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentVersion)!, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      alg: 'aes-256-gcm',
      key_version: this.currentVersion,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  open(sealed: SealedSecret, aad: string): string {
    const key = this.keys.get(sealed.key_version);
    if (key === undefined) throw new CredentialDecryptError();
    try {
      const iv = Buffer.from(sealed.iv, 'base64');
      const tag = Buffer.from(sealed.tag, 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialDecryptError();
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new CredentialDecryptError();
    }
  }
}

/** The additional authenticated data for one agent's credential. */
export function credentialAad(userId: string, agentId: string): string {
  return `cord-credential:v1:${userId}:${agentId}`;
}

/** The additional authenticated data for one person's key for one speech provider. */
export function speechKeyAad(userId: string, provider: SpeechProvider): string {
  return `cord-speech-key:v1:${userId}:${provider}`;
}

/** Keys for sealing message text: each credential key run through HKDF-SHA256 (info `cord-messages-v1`), so message and credential ciphertexts never share a key. */
export function messageKeys(config: CredentialKeys): CredentialKeys {
  return {
    currentVersion: config.currentVersion,
    keys: new Map(
      [...config.keys].map(([version, key]) => [
        version,
        Buffer.from(
          hkdfSync('sha256', Buffer.from(key, 'base64'), Buffer.alloc(0), 'cord-messages-v1', 32),
        ).toString('base64'),
      ]),
    ),
  };
}

export function messageAad(userId: string, threadId: string, messageId: string): string {
  return `cord-message:v1:${userId}:${threadId}:${messageId}`;
}
