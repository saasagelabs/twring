import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { CredentialKeys } from '@twring/config/gateway';

const derive = (key: string, info: string) =>
  Buffer.from(hkdfSync('sha256', Buffer.from(key, 'base64'), Buffer.alloc(0), info, 32));

export function fileKeys(config: CredentialKeys): CredentialKeys {
  return {
    currentVersion: config.currentVersion,
    keys: new Map(
      [...config.keys].map(([version, key]) => [
        version,
        derive(key, 'cord-files-v1').toString('base64'),
      ]),
    ),
  };
}

export function fileLinkKey(config: CredentialKeys): Buffer {
  const key = config.keys.get(config.currentVersion);
  if (!key) throw new Error('current file link key is missing');
  return derive(key, 'cord-file-links-v1');
}

export const fileAad = (userId: string, fileId: string): string => `file:${userId}:${fileId}`;

export function sealBlob(
  keys: CredentialKeys,
  keyVersion: number,
  bytes: Buffer,
  aad: string,
): Buffer {
  const encoded = keys.keys.get(keyVersion);
  if (!encoded || keyVersion < 1 || keyVersion > 65535)
    throw new Error('file key version is missing');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encoded, 'base64'), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(aad));
  const version = Buffer.alloc(3);
  version[0] = 1;
  version.writeUInt16BE(keyVersion, 1);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([version, iv, cipher.getAuthTag(), ciphertext]);
}

export function openBlob(keys: CredentialKeys, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < 32 || sealed[0] !== 1) throw new Error('file could not be decrypted');
  const encoded = keys.keys.get(sealed.readUInt16BE(1));
  if (!encoded) throw new Error('file could not be decrypted');
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(encoded, 'base64'),
      sealed.subarray(3, 15),
      { authTagLength: 16 },
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(15, 31));
    return Buffer.concat([decipher.update(sealed.subarray(31)), decipher.final()]);
  } catch {
    throw new Error('file could not be decrypted');
  }
}
