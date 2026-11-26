import { describe, expect, it } from 'vitest';

import {
  approvalCode,
  approvalCommitment,
  approvalCommitmentMatches,
  newApprovalSecret,
} from './approval-sas';
import { safetyCode } from './message-seal';
import { generateSealKeyPair } from './seal-core';

const bytes = (fill: number) => new Uint8Array(32).fill(fill);

describe('second-phone approval code (commit, then reveal)', () => {
  it('makes 32-byte random secrets', () => {
    const a = newApprovalSecret();
    expect(a).toHaveLength(32);
    expect(newApprovalSecret()).not.toEqual(a);
  });

  it('checks a reveal against the commitment', () => {
    const key = generateSealKeyPair().publicKey;
    const secret = bytes(7);
    const commitment = approvalCommitment(key, secret);
    expect(commitment).toHaveLength(32);
    expect(approvalCommitmentMatches(commitment, key, secret)).toBe(true);
    expect(approvalCommitmentMatches(commitment, key, bytes(8))).toBe(false);
    expect(approvalCommitmentMatches(commitment, generateSealKeyPair().publicKey, secret)).toBe(
      false,
    );
    expect(approvalCommitmentMatches(commitment.slice(0, 31), key, secret)).toBe(false);
  });

  it('gives 6 digits that depend on both keys and both nonces, in order', () => {
    const n = bytes(10);
    const a = bytes(11);
    const code = approvalCode(n, a, bytes(1), bytes(2));
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(approvalCode(n, a, bytes(1), bytes(2))).toBe(code);
    expect(approvalCode(a, n, bytes(1), bytes(2))).not.toBe(code);
    expect(approvalCode(n, a, bytes(2), bytes(1))).not.toBe(code);
    expect(approvalCode(n, a, bytes(1), bytes(3))).not.toBe(code);
    expect(approvalCode(n, bytes(12), bytes(1), bytes(2))).not.toBe(code);
    expect(code).not.toBe(safetyCode(n, a));
  });

  it('refuses inputs that are not 32 bytes', () => {
    const k = bytes(1);
    expect(() => approvalCode(k, k, k, new Uint8Array(31))).toThrow();
    expect(() => approvalCommitment(new Uint8Array(3), k)).toThrow();
  });
});
