import { randomInt } from 'node:crypto';

import { z } from 'zod';

import {
  hashCode,
  inviteCodeRecordSchema,
  inviteCodesFileSchema,
  redemptionRecordSchema,
  type InviteCodeRecord,
} from './invites';

export type CodesOp =
  | { kind: 'new'; count?: number; uses?: number; days?: number; note?: string }
  | { kind: 'list' }
  | { kind: 'revoke'; codes: string[] };

export interface CodeRow {
  hashPrefix: string;
  note: string;
  uses: number;
  redeemed: number;
  expires: string;
  status: 'active' | 'used' | 'expired';
}

export function applyCodesOp(
  currentText: string | undefined,
  op: CodesOp,
  extra: { autoCodes?: string; redemptions?: string } = {},
): { next?: string; newCodes: string[]; rows: CodeRow[] } {
  let owner: InviteCodeRecord[];
  let auto: InviteCodeRecord[];
  let redemptions: z.infer<typeof redemptionRecordSchema>[];
  try {
    owner =
      currentText === undefined ? [] : inviteCodesFileSchema.parse(JSON.parse(currentText)).codes;
  } catch {
    throw new Error('invite-codes.json is invalid; fix it on the server before changing it');
  }
  try {
    auto =
      extra.autoCodes === undefined
        ? []
        : z.array(inviteCodeRecordSchema).parse(JSON.parse(extra.autoCodes));
    redemptions =
      extra.redemptions === undefined
        ? []
        : z.array(redemptionRecordSchema).parse(JSON.parse(extra.redemptions));
  } catch {
    throw new Error('invite code data is invalid; fix it on the server before changing it');
  }
  const newCodes: string[] = [];
  let next: string | undefined;
  if (op.kind === 'new') {
    const count = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(op.count ?? 1);
    const uses = z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(op.uses ?? 1);
    const days = z
      .number()
      .int()
      .min(1)
      .max(365)
      .parse(op.days ?? 14);
    const note = z
      .string()
      .max(80)
      .parse(op.note ?? '');
    const known = new Set([...owner, ...auto].map((item) => item.hash));
    const at = new Date();
    for (let i = 0; i < count; i += 1) {
      let code: string | undefined;
      let hash: string | undefined;
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const candidate = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const candidateHash = hashCode(candidate);
        if (known.has(candidateHash)) continue;
        code = candidate;
        hash = candidateHash;
        break;
      }
      if (code === undefined || hash === undefined)
        throw new Error('could not create unique invite code');
      known.add(hash);
      newCodes.push(code);
      owner.push({
        hash,
        uses,
        expires_at: new Date(at.getTime() + days * 86_400_000).toISOString(),
        note,
        created_at: at.toISOString(),
      });
    }
    next = `${JSON.stringify({ codes: owner }, null, 2)}\n`;
  } else if (op.kind === 'revoke') {
    if (op.codes.length === 0) throw new Error('name at least one code');
    const hashes = new Set(
      op.codes.map((code) => {
        if (!/^\d{6}$/.test(code)) throw new Error('codes must be exactly 6 digits');
        return hashCode(code);
      }),
    );
    if (auto.some((item) => hashes.has(item.hash)))
      throw new Error('auto codes cannot be revoked by this tool');
    const kept = owner.filter((item) => !hashes.has(item.hash));
    if (kept.length !== owner.length) {
      owner = kept;
      next = `${JSON.stringify({ codes: owner }, null, 2)}\n`;
    }
  }
  const now = Date.now();
  const rows = [...owner, ...auto].map((item) => {
    const redeemed = redemptions.filter((row) => row.hash === item.hash).length;
    return {
      hashPrefix: item.hash.slice(0, 8),
      note: item.note,
      uses: item.uses,
      redeemed,
      expires: item.expires_at.slice(0, 10),
      status:
        Date.parse(item.expires_at) <= now
          ? ('expired' as const)
          : redeemed >= item.uses
            ? ('used' as const)
            : ('active' as const),
    };
  });
  return { ...(next && { next }), newCodes, rows };
}
