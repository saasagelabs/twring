import { z } from 'zod';

import { membersSchema } from './members';

export type MembersOp = { kind: 'list' } | { kind: 'add' | 'remove'; emails: string[] };

export interface MembersResult {
  /** The file to write, or undefined when nothing changes (list, or no-op). */
  next?: string;
  emails: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
}

const invalidFile = 'beta-members.json is invalid; fix it on the server before changing it';

export function applyMembersOp(current: string | undefined, op: MembersOp): MembersResult {
  let existing: string[];
  try {
    existing =
      current === undefined ? [] : membersSchema.parse(JSON.parse(current) as unknown).emails;
  } catch {
    throw new Error(invalidFile);
  }

  const members = new Set(existing);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  if (op.kind !== 'list') {
    if (op.emails.length === 0) throw new Error('name at least one email');

    const requested = new Set<string>();
    for (const input of op.emails) {
      const email = input.trim().toLowerCase();
      if (!z.email().safeParse(email).success) throw new Error(`not a valid email: ${input}`);
      requested.add(email);
    }

    for (const email of requested) {
      if (op.kind === 'add') {
        if (members.has(email)) unchanged.push(email);
        else {
          members.add(email);
          added.push(email);
        }
      } else if (members.delete(email)) removed.push(email);
      else unchanged.push(email);
    }

    if (removed.length > 0 && members.size === 0) {
      throw new Error('refusing to remove every member: the beta would lock everyone out');
    }
  }

  const emails = [...members].sort();
  added.sort();
  removed.sort();
  unchanged.sort();
  if (added.length === 0 && removed.length === 0) {
    return { emails, added, removed, unchanged };
  }

  const next = `${JSON.stringify({ emails }, null, 2)}\n`;
  membersSchema.parse(JSON.parse(next) as unknown);
  return { next, emails, added, removed, unchanged };
}
