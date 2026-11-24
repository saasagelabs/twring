import { x25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';

import { newMessageKey, unwrapKey, wrapKey, wrapKeyCacheSize } from './message-seal';

describe('wrap key cache', () => {
  it('stays bounded at 32 entries and still opens wraps for evicted pairs', () => {
    const me = x25519.utils.randomSecretKey();
    const mePub = x25519.getPublicKey(me);
    const aad = new Uint8Array([1, 2, 3]);
    const firstPeer = x25519.utils.randomSecretKey();
    const msgKey = newMessageKey();
    const wrapped = wrapKey(msgKey, firstPeer, mePub, aad);
    for (let i = 0; i < 40; i++) {
      wrapKey(newMessageKey(), x25519.utils.randomSecretKey(), mePub, aad);
    }
    expect(wrapKeyCacheSize()).toBe(32);
    expect(unwrapKey(wrapped, me, x25519.getPublicKey(firstPeer), aad)).toEqual(msgKey);
  });

  it('never mixes up two pairs that share a key', () => {
    const me = x25519.utils.randomSecretKey();
    const a = x25519.utils.randomSecretKey();
    const b = x25519.utils.randomSecretKey();
    const aad = new Uint8Array([9]);
    const k = newMessageKey();
    const wrapped = wrapKey(k, a, x25519.getPublicKey(me), aad);
    expect(() => unwrapKey(wrapped, me, x25519.getPublicKey(b), aad)).toThrow();
    expect(unwrapKey(wrapped, me, x25519.getPublicKey(a), aad)).toEqual(k);
  });
});
