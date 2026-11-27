import { utf8ToBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';

import {
  deviceIdFor,
  formatTypedPairCode,
  newTypedPairCode,
  normalizeTypedPairCode,
  offerConnectorMac,
  offerConnectorMacMatches,
  offerKeyMac,
  offerKeyMacMatches,
  splitTypedPairCode,
  typedPairKey,
} from './message-seal';
import { pairClaimSchema, typedPairHandleSchema } from './sealed-chat';
import { base64urlEncode } from './seal-core';

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const CODE = '7KQ2M9XD4HTPW3RV';
const pub = new Uint8Array(32).fill(1);
const devId = `dev_${'a'.repeat(20)}`;

describe('typed pairing code', () => {
  it('makes 16 Crockford characters from fresh randomness every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newTypedPairCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(CROCKFORD);
  });

  it('shows the code in four groups of four', () => {
    expect(formatTypedPairCode(CODE)).toBe('7KQ2-M9XD-4HTP-W3RV');
  });

  it('reads what a person types: any case, dashes and spaces, O as 0, I and L as 1', () => {
    expect(normalizeTypedPairCode('7kq2-m9xd 4htp-w3rv')).toBe(CODE);
    expect(normalizeTypedPairCode(' 7KQ2 M9XD 4HTP W3RV ')).toBe(CODE);
    expect(normalizeTypedPairCode('oOiI-lL00-0000-0000')).toBe('0011110000000000');
  });

  it('refuses U, other characters and the wrong length', () => {
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3RU')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3R!')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3R')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3RVV')).toBeUndefined();
    expect(normalizeTypedPairCode('')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2_M9XD_4HTP_W3RV')).toBeUndefined();
  });

  it('reads a pasted code with a newline or tabs, and refuses lookalike characters', () => {
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3RV\n')).toBe(CODE);
    expect(normalizeTypedPairCode('\t7KQ2--M9XD - 4HTP\r\nW3RV')).toBe(CODE);
    // Full-width digits and Cyrillic letters look the same but are not the code.
    expect(normalizeTypedPairCode('７KQ2-M9XD-4HTP-W3RV')).toBeUndefined();
    expect(normalizeTypedPairCode('7КQ2-M9XD-4HTP-W3RV')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3R')).toBeUndefined();
    expect(normalizeTypedPairCode('7KQ2-M9XD-4HTP-W3RVA')).toBeUndefined();
  });

  it('splits into a 4-character lookup handle and a 12-character secret', () => {
    expect(splitTypedPairCode(CODE)).toEqual({ handle: '7KQ2', secret: 'M9XD4HTPW3RV' });
    expect(typedPairHandleSchema.safeParse('7KQ2').success).toBe(true);
    for (const bad of ['7kq2', '7KQ', '7KQ2M', 'UUUU', 'I000'])
      expect(typedPairHandleSchema.safeParse(bad).success).toBe(false);
  });

  // Both vectors were cross-checked against Node's own HKDF and HMAC when they were made.
  it('derives the typed key with HKDF-SHA256 over the secret text (fixed vector)', () => {
    const key = typedPairKey('M9XD4HTPW3RV');
    expect(key).toEqual(
      hkdf(sha256, utf8ToBytes('M9XD4HTPW3RV'), undefined, utf8ToBytes('twring-pair-typed-v1'), 32),
    );
    expect(base64urlEncode(key)).toMatchInlineSnapshot(
      `"dGHEFDub84POSu8Cl_Z0ci-WdOYqv8R72mDKWcf9Kj8"`,
    );
  });

  it('commits the offer to the computer key and id (fixed vector, length-prefixed fields)', () => {
    const key = typedPairKey('M9XD4HTPW3RV');
    const mac = offerKeyMac(key, pub, devId);
    const lp = (b: Uint8Array) => {
      const out = new Uint8Array(4 + b.length);
      new DataView(out.buffer).setUint32(0, b.length);
      out.set(b, 4);
      return out;
    };
    const parts = [utf8ToBytes('twring-pair-offer-v1'), lp(pub), lp(utf8ToBytes(devId))];
    const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
    }
    expect(mac).toBe(base64urlEncode(hmac(sha256, key, data)));
    expect(mac).toMatchInlineSnapshot(`"kO8Lj_nP6YchSu9EeiBpePpXfAcT4GMHr47XcdHByHQ"`);
  });

  it('commits to the connector id apart from the key commitment (R4-2)', () => {
    const key = typedPairKey('M9XD4HTPW3RV');
    const con = `con_${'a'.repeat(20)}`;
    const mac = offerConnectorMac(key, pub, devId, con);
    expect(mac).not.toBe(offerKeyMac(key, pub, devId));
    expect(offerConnectorMacMatches(key, pub, devId, con, mac)).toBe(true);
    expect(offerConnectorMacMatches(key, pub, devId, `con_${'b'.repeat(20)}`, mac)).toBe(false);
    expect(offerConnectorMacMatches(typedPairKey('M9XD4HTPW3RW'), pub, devId, con, mac)).toBe(
      false,
    );
    expect(offerConnectorMacMatches(key, pub, devId, con, '%%')).toBe(false);
  });

  it('checks the commitment: another key, id or secret fails', () => {
    const key = typedPairKey('M9XD4HTPW3RV');
    const mac = offerKeyMac(key, pub, devId);
    expect(offerKeyMacMatches(key, pub, devId, mac)).toBe(true);
    expect(offerKeyMacMatches(key, new Uint8Array(32).fill(2), devId, mac)).toBe(false);
    expect(offerKeyMacMatches(key, pub, `dev_${'b'.repeat(20)}`, mac)).toBe(false);
    expect(offerKeyMacMatches(typedPairKey('M9XD4HTPW3RW'), pub, devId, mac)).toBe(false);
    expect(offerKeyMacMatches(key, pub, devId, `${mac.slice(0, -2)}AA`)).toBe(false);
    expect(offerKeyMacMatches(key, pub, devId, 'not base64 !')).toBe(false);
    expect(offerKeyMacMatches(key, pub, devId, '')).toBe(false);
  });

  it('works with a real device id', () => {
    const key = typedPairKey('000000000000');
    const id = deviceIdFor(pub);
    expect(offerKeyMacMatches(key, pub, id, offerKeyMac(key, pub, id))).toBe(true);
  });

  it('lets a claim say which key it used, and nothing else', () => {
    const claim = {
      offer_id: `off_${'a'.repeat(20)}`,
      phone_device_id: devId,
      phone_public_key: base64urlEncode(pub),
      phone_name: 'Pixel',
      mac: 'm',
    };
    expect(pairClaimSchema.safeParse(claim).success).toBe(true);
    expect(pairClaimSchema.safeParse({ ...claim, key: 'qr' }).success).toBe(true);
    expect(pairClaimSchema.safeParse({ ...claim, key: 'typed' }).success).toBe(true);
    expect(pairClaimSchema.safeParse({ ...claim, key: 'other' }).success).toBe(false);
  });
});
