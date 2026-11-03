import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { fileAad, fileKeys, openBlob, sealBlob } from './cipher';

describe('sealed files', () => {
  it('opens only with the right key, version, AAD, and intact bytes', () => {
    const source = { currentVersion: 1, keys: new Map([[1, randomBytes(32).toString('base64')]]) };
    const keys = fileKeys(source);
    const aad = fileAad('alice', `fil_${'a'.repeat(20)}`);
    const sealed = sealBlob(keys, 1, Buffer.from('private'), aad);
    expect(openBlob(keys, sealed, aad).toString()).toBe('private');
    expect(() => openBlob(keys, sealed, fileAad('bob', `fil_${'a'.repeat(20)}`))).toThrow();
    expect(() => openBlob(keys, sealed, fileAad('alice', `fil_${'b'.repeat(20)}`))).toThrow();
    expect(() =>
      openBlob(
        fileKeys({ currentVersion: 2, keys: new Map([[2, randomBytes(32).toString('base64')]]) }),
        sealed,
        aad,
      ),
    ).toThrow();
    const changed = Buffer.from(sealed);
    changed[changed.length - 1]! ^= 1;
    expect(() => openBlob(keys, changed, aad)).toThrow();
    expect(() => openBlob(keys, sealed.subarray(0, 20), aad)).toThrow();
  });
});
