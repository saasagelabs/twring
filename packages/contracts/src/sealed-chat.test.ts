import { describe, expect, it } from 'vitest';
import { base64urlEncode } from './seal-core';
import {
  MAX_PAIRED_DEVICES,
  pairClaimSchema,
  publicKeySchema,
  sealedEnvelopeV1Schema,
} from './sealed-chat';

const key = base64urlEncode(new Uint8Array(32).fill(7));
const envelope = {
  v: 1,
  sender_device: 'dev_aaaaaaaaaaaaaaaaaaaa',
  sender_seq: 1,
  nonce: base64urlEncode(new Uint8Array(24)),
  body: 'abc',
  keys: [{ device: 'dev_bbbbbbbbbbbbbbbbbbbb', wrapped: 'xyz' }],
};

describe('sealed chat schemas', () => {
  it('accepts a minimal v1 envelope', () => {
    expect(sealedEnvelopeV1Schema.parse(envelope)).toEqual(envelope);
  });
  it('rejects a public key that is not 32 bytes', () => {
    expect(publicKeySchema.safeParse(base64urlEncode(new Uint8Array(31))).success).toBe(false);
    expect(publicKeySchema.safeParse(key).success).toBe(true);
  });
  it('caps wrapped keys at the device cap', () => {
    const keys = Array.from({ length: MAX_PAIRED_DEVICES + 1 }, (_, i) => ({
      device: `dev_${String.fromCharCode(97 + i).repeat(20)}`,
      wrapped: 'x',
    }));
    expect(sealedEnvelopeV1Schema.safeParse({ ...envelope, keys }).success).toBe(false);
  });
  it('rejects an unknown version', () => {
    expect(sealedEnvelopeV1Schema.safeParse({ ...envelope, v: 2 }).success).toBe(false);
  });
  it('rejects a claim without a mac', () => {
    expect(
      pairClaimSchema.safeParse({
        offer_id: 'off_aaaaaaaaaaaaaaaaaaaa',
        phone_device_id: 'dev_aaaaaaaaaaaaaaaaaaaa',
        phone_public_key: key,
        phone_name: 'Pixel',
      }).success,
    ).toBe(false);
  });
});
