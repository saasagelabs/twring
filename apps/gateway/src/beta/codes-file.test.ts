import { describe, expect, it } from 'vitest';

import { applyCodesOp } from './codes-file';
import { hashCode, inviteCodesFileSchema } from './invites';

describe('applyCodesOp', () => {
  it('creates unique codes and avoids owner and auto hashes', () => {
    const existing = {
      hash: hashCode('123456'),
      uses: 1,
      expires_at: '2099-01-01T00:00:00.000Z',
      note: '',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const result = applyCodesOp(
      JSON.stringify({ codes: [existing] }),
      { kind: 'new', count: 20, note: 'X wave' },
      { autoCodes: JSON.stringify([{ ...existing, hash: hashCode('654321') }]) },
    );
    expect(new Set(result.newCodes).size).toBe(20);
    expect(result.newCodes).not.toContain('123456');
    expect(result.newCodes).not.toContain('654321');
    expect(inviteCodesFileSchema.parse(JSON.parse(result.next!)).codes).toHaveLength(21);
  });

  it('lists active, used and expired codes from both sources', () => {
    const base = { uses: 1, note: '', created_at: '2026-01-01T00:00:00.000Z' };
    const active = { ...base, hash: hashCode('123456'), expires_at: '2099-01-01T00:00:00.000Z' };
    const expired = { ...base, hash: hashCode('234567'), expires_at: '2020-01-01T00:00:00.000Z' };
    const used = { ...base, hash: hashCode('345678'), expires_at: '2099-01-01T00:00:00.000Z' };
    const result = applyCodesOp(
      JSON.stringify({ codes: [active, expired] }),
      { kind: 'list' },
      {
        autoCodes: JSON.stringify([used]),
        redemptions: JSON.stringify([
          { hash: used.hash, email: 'a@example.com', at: '2026-01-01T00:00:00.000Z' },
        ]),
      },
    );
    expect(result.rows.map((row) => row.status)).toEqual(['active', 'expired', 'used']);
    expect(result.rows[0]?.hashPrefix).toHaveLength(8);
    expect(result.next).toBeUndefined();
  });

  it('revokes owner codes, but refuses auto codes', () => {
    const row = {
      hash: hashCode('123456'),
      uses: 1,
      expires_at: '2099-01-01T00:00:00.000Z',
      note: '',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    expect(
      inviteCodesFileSchema.parse(
        JSON.parse(
          applyCodesOp(JSON.stringify({ codes: [row] }), { kind: 'revoke', codes: ['123456'] })
            .next!,
        ),
      ).codes,
    ).toEqual([]);
    expect(() =>
      applyCodesOp(
        undefined,
        { kind: 'revoke', codes: ['123456'] },
        { autoCodes: JSON.stringify([row]) },
      ),
    ).toThrow('auto codes cannot be revoked');
  });

  it('enforces limits and rejects invalid files without echoing contents', () => {
    for (const op of [
      { kind: 'new', count: 101 },
      { kind: 'new', uses: 0 },
      { kind: 'new', days: 366 },
      { kind: 'new', note: 'x'.repeat(81) },
    ] as const)
      expect(() => applyCodesOp(undefined, op)).toThrow();
    expect(() => applyCodesOp('private bad data', { kind: 'list' })).toThrow(
      'invite-codes.json is invalid',
    );
  });
});
