import { describe, expect, it } from 'vitest';

import {
  MAX_SEAL_PLAINTEXT_BYTES,
  SealError,
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  open,
  seal,
} from './seal';
import { sealWithNonce } from './seal-core';
import * as barrel from './index';
import { sealedEnvelopeSchema } from './selfhost';

// The contracts package has no DOM or Node typings, so keep to ASCII text in these tests.
const enc = { encode: (t: string) => Uint8Array.from(t, (ch) => ch.charCodeAt(0)) };
const dec = { decode: (b: Uint8Array) => String.fromCharCode(...b) };

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function pairKey() {
  const phone = generateSealKeyPair();
  const server = generateSealKeyPair();
  return {
    phone,
    server,
    key: deriveSealKey(server.privateKey, phone.publicKey),
  };
}

describe('base64url', () => {
  it('round trips unpadded', () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 255);
      const text = base64urlEncode(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(base64urlDecode(text)).toEqual(bytes);
    }
  });

  it('rejects padding, other alphabets and impossible lengths', () => {
    expect(() => base64urlDecode('AA==')).toThrow(SealError);
    expect(() => base64urlDecode('a+b/')).toThrow(SealError);
    expect(() => base64urlDecode('AAAAA')).toThrow(SealError);
  });
});

describe('sealed contents', () => {
  it('generates 32-byte keys', () => {
    const { publicKey, privateKey } = generateSealKeyPair();
    expect(publicKey).toHaveLength(32);
    expect(privateKey).toHaveLength(32);
  });

  it('both sides derive the same key', () => {
    const { phone, server } = pairKey();
    const a = deriveSealKey(server.privateKey, phone.publicKey);
    const b = deriveSealKey(phone.privateKey, server.publicKey);
    expect(a).toHaveLength(32);
    expect(a).toEqual(b);
  });

  it('round trips', () => {
    const { key } = pairKey();
    const env = seal(key, enc.encode('Rishi is calling'));
    expect(dec.decode(open(key, env))).toBe('Rishi is calling');
  });

  it('round trips empty plaintext', () => {
    const { key } = pairKey();
    expect(open(key, seal(key, new Uint8Array(0)))).toHaveLength(0);
  });

  it('produces an envelope that matches the contract schema', () => {
    const { key } = pairKey();
    const env = seal(key, enc.encode('hello'));
    expect(sealedEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env.v).toBe(1);
  });

  it('fails with the wrong key', () => {
    const { key } = pairKey();
    const other = pairKey().key;
    const env = seal(key, enc.encode('secret'));
    expect(() => open(other, env)).toThrow(SealError);
  });

  it('fails when a ciphertext byte is flipped', () => {
    const { key } = pairKey();
    const env = seal(key, enc.encode('secret'));
    const bytes = base64urlDecode(env.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => open(key, { ...env, c: base64urlEncode(bytes) })).toThrow(SealError);
  });

  it('fails when the nonce is changed', () => {
    const { key } = pairKey();
    const env = seal(key, enc.encode('secret'));
    const nonce = base64urlDecode(env.n);
    nonce[0] = (nonce[0] ?? 0) ^ 1;
    expect(() => open(key, { ...env, n: base64urlEncode(nonce) })).toThrow(SealError);
  });

  it('fails on malformed envelopes without leaking other errors', () => {
    const { key } = pairKey();
    expect(() => open(key, { v: 1, n: 'short', c: 'AAAA' })).toThrow(SealError);
    expect(() => open(key, { v: 2, n: 'x', c: 'y' } as never)).toThrow(SealError);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => seal(new Uint8Array(16), enc.encode('x'))).toThrow(SealError);
    expect(() => deriveSealKey(new Uint8Array(31), new Uint8Array(32))).toThrow(SealError);
  });

  it('uses a fresh nonce for every seal', () => {
    const { key } = pairKey();
    const nonces = new Set<string>();
    for (let i = 0; i < 1000; i++) nonces.add(seal(key, enc.encode('x')).n);
    expect(nonces.size).toBe(1000);
  });
});

describe('size limit', () => {
  it('seals exactly the maximum and opens it', () => {
    const { key } = pairKey();
    const pt = new Uint8Array(MAX_SEAL_PLAINTEXT_BYTES).fill(7);
    const env = seal(key, pt);
    expect(sealedEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(open(key, env)).toEqual(pt);
  });

  it('refuses one byte over the maximum', () => {
    const { key } = pairKey();
    expect(() => seal(key, new Uint8Array(MAX_SEAL_PLAINTEXT_BYTES + 1))).toThrow(
      new SealError('plaintext too large'),
    );
  });
});

describe('public seal', () => {
  it('has no nonce injection and is not exposed with one', () => {
    const { key } = pairKey();
    const fixed = new Uint8Array(24);
    const loose = barrel.seal as unknown as (...a: unknown[]) => { n: string };
    const a = loose(key, enc.encode('x'), { nonce: fixed });
    expect(a.n).not.toBe(base64urlEncode(fixed));
    expect('sealWithNonce' in barrel).toBe(false);
  });
});

// Known-answer vector: the phone app (Plan B) checks its implementation against these values.
describe('known-answer vector', () => {
  const phonePrivate = hex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
  const serverPrivate = hex('a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
  const nonce = hex('000102030405060708090a0b0c0d0e0f1011121314151617');
  const plaintext = enc.encode('Twring known answer');

  it('matches the recorded key and envelope', () => {
    const phonePublic = generateSealKeyPairFrom(phonePrivate);
    const serverPublic = generateSealKeyPairFrom(serverPrivate);
    const key = deriveSealKey(serverPrivate, phonePublic);
    expect(deriveSealKey(phonePrivate, serverPublic)).toEqual(key);
    expect(toHex(phonePublic)).toBe(
      '07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c',
    );
    expect(toHex(serverPublic)).toBe(
      '605a725d2a4adfeeb1a29e17edd621c1b7593ee8cdbc44ac6c4ab6e2f805d23c',
    );
    expect(toHex(key)).toBe('13a568b343a51c5e323095240586daf0f7f00890967bdfa12f02c2964c77ec26');
    const env = sealWithNonce(key, plaintext, nonce);
    expect(env).toEqual({
      v: 1,
      n: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
      c: 'SGKLOEhsG4IEMFKN7GIsU2p5FaPYm8S2vokI98M39Jz4RUI',
    });
    expect(dec.decode(open(key, env))).toBe('Twring known answer');
  });
});

import { x25519 } from '@noble/curves/ed25519.js';

function generateSealKeyPairFrom(priv: Uint8Array): Uint8Array {
  return x25519.getPublicKey(priv);
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
