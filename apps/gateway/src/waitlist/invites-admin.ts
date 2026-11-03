import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { approvalsFileSchema, type Approval } from './invite-flow';
import { waitlistRecordSchema, type WaitlistRecord } from './routes';

/** The invite operations script: what the owner can do with the request list. */
export type InvitesOp =
  | { kind: 'pending' }
  | { kind: 'status' }
  | { kind: 'approve'; all: true }
  | { kind: 'approve'; emails: string[] };

/** Approvals older than this are dropped from the file when a new one is added. */
const KEEP_APPROVALS_MS = 30 * 86_400_000;

const where = (source: WaitlistRecord['source']) =>
  source === 'app' ? 'the app' : source === 'beta' ? 'twring.com/beta' : 'twring.com';

const waiting = (r: WaitlistRecord) =>
  r.invited_at === undefined && r.invite_failed_at === undefined;

/**
 * Applies one op to the server's files, given as text (undefined: the file is missing). Returns
 * the new approvals file to write, if any, and lines to print. Never touches waitlist.json: only
 * the gateway writes it.
 */
export function applyInvitesOp(
  waitlistText: string | undefined,
  approvalsText: string | undefined,
  op: InvitesOp,
  now: Date,
): { next?: string; lines: string[] } {
  let rows: WaitlistRecord[];
  try {
    rows =
      waitlistText === undefined
        ? []
        : z.array(waitlistRecordSchema).parse(JSON.parse(waitlistText));
  } catch {
    throw new Error('waitlist.json is invalid on the server; nothing changed');
  }
  if (op.kind === 'pending') {
    const lines = rows
      .filter(waiting)
      .map(
        (r) =>
          `${r.email}  (${where(r.source)}, ${r.created_at.slice(0, 16).replace('T', ' ')} UTC)`,
      );
    return { lines: lines.length > 0 ? lines : ['Nobody is waiting.'] };
  }
  if (op.kind === 'status') {
    const invited = rows.filter((r) => r.invited_at !== undefined).length;
    const failed = rows.filter((r) => r.invite_failed_at !== undefined).length;
    return {
      lines: [
        `${rows.length} requests: ${rows.filter(waiting).length} waiting, ${invited} invited, ${failed} could not be emailed.`,
      ],
    };
  }

  let approvals: Approval[];
  try {
    approvals =
      approvalsText === undefined
        ? []
        : [...approvalsFileSchema.parse(JSON.parse(approvalsText)).approvals];
  } catch {
    throw new Error('invite-approvals.json is invalid on the server; nothing changed');
  }
  const lines: string[] = [];
  let entry: Approval;
  let count: number;
  if ('all' in op) {
    // Named, not "everyone before this time": the PC's clock and the server's need not agree.
    const emails = rows.filter(waiting).map((r) => r.email);
    count = emails.length;
    if (count > 1000) throw new Error('more than 1000 waiting; approve them in parts by name');
    entry = { id: randomUUID(), at: now.toISOString(), emails };
    if (count === 0) lines.push('Nobody is waiting.');
  } else {
    const wanted = [...new Set(op.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const byEmail = new Map(rows.map((r) => [r.email, r]));
    // Someone who could not be emailed can be approved again by name.
    const due = wanted.filter((e) => {
      const row = byEmail.get(e);
      return row !== undefined && row.invited_at === undefined;
    });
    const unknown = wanted.filter((e) => !byEmail.has(e));
    const done = wanted.filter((e) => byEmail.has(e) && !due.includes(e));
    count = due.length;
    entry = { id: randomUUID(), at: now.toISOString(), emails: due };
    if (count === 0) {
      lines.push(
        `Nobody to invite: ${done.length > 0 ? `${done.join(', ')} was already invited.` : 'no one matched.'}`,
      );
    }
    if (unknown.length > 0) {
      lines.push(
        `Not on the request list (ask them to request access first): ${unknown.join(', ')}`,
      );
    }
  }
  if (count === 0) return { lines };
  return {
    next: serialize(approvals, entry, now),
    lines: [
      `Approved ${count} waiting ${count === 1 ? 'request' : 'requests'}. Invites go out within a minute.`,
      ...lines,
    ],
  };
}

function serialize(approvals: readonly Approval[], entry: Approval, now: Date): string {
  const kept = approvals.filter((a) => now.getTime() - Date.parse(a.at) < KEEP_APPROVALS_MS);
  return `${JSON.stringify({ approvals: [...kept, entry] }, null, 2)}\n`;
}
