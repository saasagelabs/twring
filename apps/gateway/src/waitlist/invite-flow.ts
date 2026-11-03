import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { Collection } from '../store/collection';

import type { WaitlistRecord } from './routes';

/**
 * Wave 1 invites: the owner hears about new requests in one
 * combined email, approves a batch, and Twring emails each approved person an invite (no code).
 */

/** How often new requests are gathered into one email to the owner. */
export const DIGEST_EVERY_MS = 15 * 60_000;
/** How often the approvals file is checked. */
export const APPROVALS_EVERY_MS = 15_000;
/** Sends to one person before giving up and telling the owner. */
const MAX_INVITE_ATTEMPTS = 3;

export const approvalsFileSchema = z.object({
  approvals: z.array(
    z.object({
      id: z.string().min(1).max(64),
      at: z.iso.datetime(),
      all: z.literal(true).optional(),
      emails: z.array(z.string().max(320)).max(1000).optional(),
    }),
  ),
});
export type Approval = z.infer<typeof approvalsFileSchema>['approvals'][number];

/** The owner's approvals (written by the operations scripts). Missing: none; damaged: none, reported. */
export async function readApprovalsFile(
  path: string,
  onInvalid: () => void,
): Promise<readonly Approval[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    return approvalsFileSchema.parse(JSON.parse(text)).approvals;
  } catch {
    onInvalid();
    return [];
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  /** Where replies go (a person's invite: the support address). */
  replyTo?: string;
}

/** sent; retry later (rate limit, daily cap, outage); or rejected (this address won't take it). */
export type SendResult = 'sent' | 'retry' | 'rejected';

export interface InviteLinks {
  android?: string;
  iphone?: string;
}

/**
 * The invite: install, sign in, connect. No code: the person is let in by email address once
 * this is sent (InviteFlow.invite), and app sign-ins get in on their own (beta/routes.ts).
 */
export function inviteEmail(options: { links: InviteLinks }): { subject: string; text: string } {
  const { links } = options;
  const iphone = links.iphone
    ? `iPhone: install TestFlight from the App Store, then open this link on your iPhone and tap Install: ${links.iphone}`
    : "iPhone: reply to this email and we'll add you to the iPhone test.";
  const android = `Android: download and open ${links.android ?? 'https://twring.com'} (allow the install if your phone asks)`;
  return {
    subject: 'Your Twring invite',
    text: `Hi,

You're in. Twring lets you call the AI agents you already use, and lets them ring you.

1. Install Twring on your phone.
   ${iphone}
   ${android}
2. Open Twring and sign in with Google, or Apple on iPhone, using this email address. You are in.
3. Tap Connect my agent and follow the steps: Twring gives you a short message to send to your agent.

Your agent can ring your phone when a job is done or needs you.

Questions? Just reply to this email.

Twring`,
  };
}

export function requestDigest(
  fresh: readonly WaitlistRecord[],
  totals: { pending: number; failed: readonly string[] },
  /** AUTO_ADMIT_PER_DAY: when on, the email says nothing is needed from the owner. */
  autoPerDay = 0,
): { subject: string; text: string } {
  const where = (source: WaitlistRecord['source']) =>
    source === 'app' ? 'the app' : source === 'beta' ? 'twring.com/beta' : 'twring.com';
  const lines = fresh.map(
    (r) => `- ${r.email} (${where(r.source)}, ${r.created_at.slice(0, 16).replace('T', ' ')} UTC)`,
  );
  const failed = totals.failed.length > 0 ? `\n\nCouldn't email: ${totals.failed.join(', ')}` : '';
  const count = fresh.length;
  const listed = count > 0 ? `New requests:\n${lines.join('\n')}\n\n` : '';
  return {
    subject:
      count > 0
        ? `Twring: ${count} new access ${count === 1 ? 'request' : 'requests'}`
        : 'Twring: invites that could not be sent',
    text:
      autoPerDay > 0
        ? `${listed}Nothing to do: Twring lets people in automatically, up to ${autoPerDay} a day. People who signed in to the app are in already; people who asked on the website get their invite by email. Anyone past today's limit gets in tomorrow.${failed}`
        : `${listed}${totals.pending} waiting for an invite in total.${failed}

To invite them, tell Claude "approve all", or run the approve-all command from the operations checkout.
(Claude can also approve one person, or list who is waiting.)
Each approved person gets an invite by email, with steps for iPhone and Android.`,
  };
}

/** Automatic invites go only to requests this recent: older ones were seen and left by the owner. */
const AUTO_INVITE_WINDOW_MS = 7 * 86_400_000;

export class InviteFlow {
  constructor(
    private readonly options: {
      records: Collection<WaitlistRecord>;
      ownerTo: string;
      send: (email: OutgoingEmail) => Promise<SendResult>;
      /** Lets the person in by email address (InviteService.letIn). */
      letIn: (email: string) => Promise<void>;
      isMember: (email: string) => Promise<boolean>;
      readApprovals: () => Promise<readonly Approval[]>;
      links: InviteLinks;
      /**
       * AUTO_ADMIT_PER_DAY: website requests from the last week get their invite without an
       * approval, oldest first, while today's invites (approved ones included) stay under this.
       */
      autoInvitePerDay?: number;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** One email to the owner about requests they haven't heard of, and invites that failed. */
  async sendDigest(): Promise<void> {
    const rows = await this.options.records.read();
    const fresh = rows.filter((r) => r.notified_at === undefined);
    const failed = rows
      .filter((r) => r.invite_failed_at !== undefined && r.invite_failure_reported_at === undefined)
      .map((r) => r.email);
    if (fresh.length === 0 && failed.length === 0) return;
    if ((this.options.autoInvitePerDay ?? 0) > 0 && failed.length === 0) {
      // Automatic mode: nothing for the owner to do, so no email (it would also spend the
      // email allowance the owner alerts share). Mark them seen so a switch back stays quiet.
      const at = this.now().toISOString();
      const seen = new Set(fresh.map((r) => r.email));
      await this.options.records.update((items) => ({
        items: items.map((r) =>
          seen.has(r.email) && r.notified_at === undefined ? { ...r, notified_at: at } : r,
        ),
        result: undefined,
      }));
      return;
    }
    const pending = rows.filter(
      (r) => r.invited_at === undefined && r.invite_failed_at === undefined,
    ).length;
    const result = await this.options.send({
      to: this.options.ownerTo,
      ...requestDigest(fresh, { pending, failed }, this.options.autoInvitePerDay ?? 0),
    });
    if (result !== 'sent') return;
    const at = this.now().toISOString();
    const told = new Set(fresh.map((r) => r.email));
    const reported = new Set(failed);
    await this.options.records.update((items) => ({
      items: items.map((r) => ({
        ...r,
        ...(told.has(r.email) && r.notified_at === undefined && { notified_at: at }),
        ...(reported.has(r.email) &&
          r.invite_failed_at !== undefined && { invite_failure_reported_at: at }),
      })),
      result: undefined,
    }));
  }

  /**
   * Emails an invite to each approved person not yet invited. Safe to run again: sends once each.
   * When the email service says "later" (rate limit, daily cap, outage), the batch stops for this
   * round and resumes on the next one: nobody is marked failed for it. A person who failed is
   * tried again when a newer approval names them.
   */
  async processApprovals(): Promise<void> {
    const approvals = await this.options.readApprovals();
    const autoPerDay = this.options.autoInvitePerDay ?? 0;
    if (approvals.length === 0 && autoPerDay <= 0) return;
    const rows = await this.options.records.read();
    const named = (r: WaitlistRecord, after?: string) =>
      approvals.some(
        (a) =>
          (after === undefined || Date.parse(a.at) > Date.parse(after)) &&
          a.emails?.some((e) => e.trim().toLowerCase() === r.email) === true,
      );
    const due = rows.filter((r) => {
      if (r.invited_at !== undefined) return false;
      if (r.invite_failed_at !== undefined) return named(r, r.invite_failed_at);
      return (
        named(r) ||
        approvals.some((a) => a.all === true && Date.parse(r.created_at) <= Date.parse(a.at))
      );
    });
    if (autoPerDay > 0) {
      const now = this.now();
      const day = now.toISOString().slice(0, 10);
      const invitedToday = rows.filter((r) => r.invited_at?.startsWith(day) === true).length;
      const room = Math.max(0, autoPerDay - invitedToday - due.length);
      const since = now.getTime() - AUTO_INVITE_WINDOW_MS;
      const waiting = rows
        .filter(
          (r) =>
            !due.includes(r) &&
            r.invited_at === undefined &&
            r.invite_failed_at === undefined &&
            // App sign-ins get in on the spot (beta/routes.ts); an email code would be noise.
            r.source !== 'app' &&
            Date.parse(r.created_at) >= since,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      due.push(...waiting.slice(0, room));
    }
    for (const row of due) {
      if ((await this.invite(row)) === 'retry') return;
    }
  }

  private async invite(row: WaitlistRecord): Promise<SendResult> {
    const { email } = row;
    const now = this.now();
    let result: SendResult;
    if (await this.options.isMember(email)) {
      result = 'sent';
    } else {
      result = await this.options.send({
        to: email,
        replyTo: this.options.ownerTo,
        ...inviteEmail({ links: this.options.links }),
      });
      // Let in only once the email went out: a member is never emailed again, so letting in
      // first would lose the invite whenever the send is retried or rejected.
      if (result === 'sent') await this.options.letIn(email);
    }
    if (result === 'retry') return result;
    const at = now.toISOString();
    // Someone tried again after failing starts counting afresh.
    const retried = row.invite_failed_at !== undefined;
    await this.options.records.update((items) => ({
      items: items.map((r) => {
        if (r.email !== email) return r;
        const rest = { ...r };
        delete rest.invite_failed_at;
        delete rest.invite_failure_reported_at;
        delete rest.invite_attempts;
        if (result === 'sent') return { ...rest, invited_at: at };
        const attempts = (retried ? 0 : (r.invite_attempts ?? 0)) + 1;
        return {
          ...rest,
          invite_attempts: attempts,
          ...(attempts >= MAX_INVITE_ATTEMPTS && { invite_failed_at: at }),
        };
      }),
      result: undefined,
    }));
    return result;
  }
}
