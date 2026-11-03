import { createHash, randomInt } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

import type { Collection } from '../store/collection';

export const inviteCodeRecordSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  uses: z.number().int().min(1),
  expires_at: z.iso.datetime(),
  note: z.string().max(80),
  created_at: z.iso.datetime(),
});
export const inviteCodesFileSchema = z.object({ codes: z.array(inviteCodeRecordSchema) }).strict();
export const redemptionRecordSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  email: z.email(),
  at: z.iso.datetime(),
  /** The account that redeemed, for the daily report. Absent on rows from before 2026-10-22. */
  user_id: z.string().min(1).optional(),
  /** Let in without a code (AUTO_ADMIT_PER_DAY). */
  auto: z.literal(true).optional(),
  /** Let in because Twring emailed them an invite (no code). */
  invited: z.literal(true).optional(),
});

/** The hash stored for people let in without a code: never the hash of a six-digit code. */
const AUTO_ADMIT_HASH = createHash('sha256').update('auto-admit').digest('hex');
export type InviteCodeRecord = z.infer<typeof inviteCodeRecordSchema>;
export type RedemptionRecord = z.infer<typeof redemptionRecordSchema>;

export function normalizeCode(input: string): string | undefined {
  const code = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(code) ? code : undefined;
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface InviteService {
  isMember(email: string | undefined): Promise<boolean>;
  redeem(email: string, code: string, userId?: string): Promise<'member' | 'redeemed' | 'invalid'>;
  /**
   * Lets a signed-in person in without a code while today's (UTC) automatic places last:
   * 'closed' when automatic places are off, 'full' when today's are taken.
   */
  admit(email: string, userId: string): Promise<'member' | 'admitted' | 'full' | 'closed'>;
  /** Lets someone in by email address before Twring emails their invite. */
  letIn(email: string): Promise<void>;
  createAutoCode(note: string, now?: Date): Promise<string>;
}

export function createInviteService(options: {
  members: { has(email: string | undefined): Promise<boolean> };
  codesFile: string;
  autoCodes: Collection<InviteCodeRecord>;
  redemptions: Collection<RedemptionRecord>;
  /** People let in without a code each UTC day; 0 (the default) turns it off. */
  autoAdmitPerDay?: number;
  now?: () => Date;
  onUnavailable?: () => void;
}): InviteService {
  const now = options.now ?? (() => new Date());
  let nextCheck = -Infinity;
  let lastVersion: string | undefined;
  let ownerCodes: readonly InviteCodeRecord[] = [];
  let pending: Promise<void> | undefined;

  async function readOwnerCodes(): Promise<readonly InviteCodeRecord[]> {
    if (now().getTime() >= nextCheck) {
      pending ??= (async () => {
        nextCheck = now().getTime() + 5_000;
        let version = 'missing';
        try {
          const metadata = await stat(options.codesFile);
          version = `${metadata.mtimeMs}:${metadata.size}`;
          if (version === lastVersion) return;
          const parsed: unknown = JSON.parse(await readFile(options.codesFile, 'utf8'));
          ownerCodes = inviteCodesFileSchema.parse(parsed).codes;
        } catch {
          ownerCodes = [];
          if (version !== 'missing' && version !== lastVersion) options.onUnavailable?.();
        }
        lastVersion = version;
      })().finally(() => {
        pending = undefined;
      });
    }
    if (pending) await pending;
    return ownerCodes;
  }

  return {
    async isMember(email) {
      if (email === undefined) return false;
      const normalized = email.trim().toLowerCase();
      if (await options.members.has(normalized)) return true;
      return (await options.redemptions.read()).some((record) => record.email === normalized);
    },
    async redeem(email, input, userId) {
      const normalized = email.trim().toLowerCase();
      if (await this.isMember(normalized)) return 'member';
      const code = normalizeCode(input);
      if (!code) return 'invalid';
      const hash = hashCode(code);
      const record = [...(await readOwnerCodes()), ...(await options.autoCodes.read())].find(
        (candidate) => candidate.hash === hash,
      );
      if (!record || Date.parse(record.expires_at) <= now().getTime()) return 'invalid';
      return options.redemptions.update((items) => {
        if (items.some((item) => item.email === normalized)) {
          return { items, result: 'member' as const };
        }
        if (items.filter((item) => item.hash === hash).length >= record.uses) {
          return { items, result: 'invalid' as const };
        }
        return {
          items: [
            ...items,
            {
              hash,
              email: normalized,
              at: now().toISOString(),
              ...(userId && { user_id: userId }),
            },
          ],
          result: 'redeemed' as const,
        };
      });
    },
    async admit(email, userId) {
      const normalized = email.trim().toLowerCase();
      if (await this.isMember(normalized)) return 'member';
      const perDay = options.autoAdmitPerDay ?? 0;
      if (perDay <= 0) return 'closed';
      const at = now().toISOString();
      const day = at.slice(0, 10);
      const takenToday = (items: readonly RedemptionRecord[]) =>
        items.filter((item) => item.auto === true && item.at.startsWith(day)).length;
      // A full day is the common answer for people waiting: no write for it.
      if (takenToday(await options.redemptions.read()) >= perDay) return 'full';
      return options.redemptions.update((items) => {
        if (items.some((item) => item.email === normalized)) {
          return { items, result: 'member' as const };
        }
        if (takenToday(items) >= perDay) return { items, result: 'full' as const };
        return {
          items: [
            ...items,
            { hash: AUTO_ADMIT_HASH, email: normalized, at, user_id: userId, auto: true as const },
          ],
          result: 'admitted' as const,
        };
      });
    },
    async letIn(email) {
      const normalized = email.trim().toLowerCase();
      if (await options.members.has(normalized)) return;
      await options.redemptions.update((items) =>
        items.some((item) => item.email === normalized)
          ? { items, result: undefined }
          : {
              items: [
                ...items,
                {
                  hash: AUTO_ADMIT_HASH,
                  email: normalized,
                  at: now().toISOString(),
                  invited: true as const,
                },
              ],
              result: undefined,
            },
      );
    },
    async createAutoCode(note, at = now()) {
      inviteCodeRecordSchema.shape.note.parse(note);
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        const hash = hashCode(code);
        if ((await readOwnerCodes()).some((item) => item.hash === hash)) continue;
        const expires = new Date(at.getTime() + 14 * 86_400_000).toISOString();
        const added = await options.autoCodes.update((items) => {
          if (items.some((item) => item.hash === hash)) return { items, result: false };
          return {
            items: [
              ...items,
              { hash, uses: 1, expires_at: expires, note, created_at: at.toISOString() },
            ],
            result: true,
          };
        });
        if (added) return code;
      }
      throw new Error('could not create invite code');
    },
  };
}
