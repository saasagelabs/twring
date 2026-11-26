import { describe, expect, it } from 'vitest';

import { fileAad, newFileKey, openFile, SEALED_FILE_OVERHEAD, sealFile } from './message-seal';
import { SealError } from './seal-core';

const aad = fileAad({ accountId: 'con_a', agentId: 'claude-code' });

describe('sealed files', () => {
  it('has the documented overhead', () => {
    expect(SEALED_FILE_OVERHEAD).toBe(40);
  });
  it('round trips and adds exactly the overhead', () => {
    const key = newFileKey();
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    const blob = sealFile(key, bytes, aad);
    expect(blob.length).toBe(bytes.length + SEALED_FILE_OVERHEAD);
    expect(openFile(key, blob, aad)).toEqual(bytes);
  });
  it('uses a fresh key and a fresh nonce each time', () => {
    expect(newFileKey()).not.toEqual(newFileKey());
    const key = newFileKey();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sealFile(key, bytes, aad)).not.toEqual(sealFile(key, bytes, aad));
  });
  it('refuses a flipped byte, another key, another chat and a short blob', () => {
    const key = newFileKey();
    const blob = sealFile(key, new Uint8Array([1, 2, 3]), aad);
    const flipped = blob.slice();
    flipped[30] = (flipped[30] ?? 0) ^ 1;
    expect(() => openFile(key, flipped, aad)).toThrow(SealError);
    expect(() => openFile(newFileKey(), blob, aad)).toThrow(SealError);
    expect(() => openFile(key, blob, fileAad({ accountId: 'con_a', agentId: 'other' }))).toThrow(
      SealError,
    );
    expect(() => openFile(key, blob.subarray(0, SEALED_FILE_OVERHEAD), aad)).toThrow(SealError);
  });
  it('refuses a key of the wrong length', () => {
    expect(() => sealFile(new Uint8Array(16), new Uint8Array([1]), aad)).toThrow(SealError);
    const blob = sealFile(newFileKey(), new Uint8Array([1]), aad);
    expect(() => openFile(new Uint8Array(16), blob, aad)).toThrow(SealError);
  });
});
