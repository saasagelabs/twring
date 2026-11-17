import { z } from 'zod';

import type { Collection } from '../store/collection';
import type { SendResult } from './invite-flow';

/**
 * One row per person Twring has seen signed in, for the one reminder to connect an agent
 * (owner decision 2026-11-18: 10 people had signed in a day earlier and never connected one).
 * The address is kept only until the reminder is settled.
 */
export const noAgentReminderRecordSchema = z.object({
  user_id: z.string().min(1),
  email: z.email().optional(),
  first_seen_at: z.iso.datetime(),
  settled_at: z.iso.datetime().optional(),
  outcome: z.enum(['sent', 'has_agent', 'called', 'expired', 'rejected', 'existing']).optional(),
});
export type NoAgentReminderRecord = z.infer<typeof noAgentReminderRecordSchema>;

/** How long after first being seen a person with no agent is reminded. */
export const REMINDER_AFTER_MS = 24 * 60 * 60_000;
/**
 * A reminder this late (the server was off, the email service down) is not sent. It also bounds
 * retries to under a day, while Resend still remembers the first try's idempotency key (24 h), so
 * a send whose answer was lost can never deliver a second copy.
 */
export const REMINDER_TOO_LATE_MS = REMINDER_AFTER_MS + 23 * 60 * 60_000;
/** Emails per run, so a backlog goes out gently. */
export const MAX_REMINDERS_PER_RUN = 20;

export function noAgentReminderEmail(): { subject: string; text: string } {
  return {
    subject: 'Connect your agent to Twring',
    text: `Hi,

You signed in to Twring, but you haven't connected an agent yet. It takes about a minute:

1. Open Twring and tap Connect my agent.
2. Twring gives you a short message. Send it to the AI agent you already use.
3. Your agent sets itself up, and then you can call it.

Stuck on a step, or not sure your agent will work? Just reply to this email and we'll help.

Twring`,
  };
}

export interface NoAgentReminderOptions {
  records: Collection<NoAgentReminderRecord>;
  hasAgent(userId: string): Promise<boolean>;
  /** Someone calling on an agent shared with them is using Twring already. */
  hasCalled(userId: string): Promise<boolean>;
  send(email: {
    to: string;
    subject: string;
    text: string;
    replyTo?: string;
    idempotencyKey?: string;
  }): Promise<SendResult>;
  replyTo?: string;
  now?: () => Date;
}

export class NoAgentReminder {
  /** People already on file, so an app launch costs no write once they are. */
  private readonly known = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly options: NoAgentReminderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * A signed-in member opened the app: the first time starts their 24 hours. `stillWanted` is
   * checked as the row is written: false once Delete my data has started, so a slow app open
   * cannot bring back what the deletion removed.
   */
  async seen(
    userId: string,
    email: string | undefined,
    stillWanted: () => boolean = () => true,
  ): Promise<void> {
    const address = email?.trim().toLowerCase();
    if (this.known.has(userId) || address === undefined || address === '') return;
    if (!z.email().safeParse(address).success) return;
    if ((await this.options.records.read()).some((r) => r.user_id === userId)) {
      this.known.add(userId);
      return;
    }
    const written = await this.options.records.update((items) => {
      if (!stillWanted()) return { items, result: false };
      if (items.some((r) => r.user_id === userId)) return { items, result: true };
      return {
        items: [
          ...items,
          { user_id: userId, email: address, first_seen_at: this.now().toISOString() },
        ],
        result: true,
      };
    });
    if (written) this.known.add(userId);
  }

  /** Sends the reminders that are due; each person gets at most one. */
  async run(): Promise<void> {
    const at = this.now().getTime();
    const due = (await this.options.records.read()).filter(
      (r) => r.settled_at === undefined && Date.parse(r.first_seen_at) + REMINDER_AFTER_MS <= at,
    );
    let sent = 0;
    for (const row of due) {
      const outcome = await this.decide(row, at);
      if (outcome === 'send') {
        if (sent >= MAX_REMINDERS_PER_RUN) continue;
        sent += 1;
        const result = await this.options.send({
          to: row.email!,
          ...(this.options.replyTo !== undefined && { replyTo: this.options.replyTo }),
          // A send whose answer was lost comes back as 'retry'; the same key stops a second copy.
          idempotencyKey: `no-agent-reminder/${row.user_id}`,
          ...noAgentReminderEmail(),
        });
        if (result === 'retry') continue;
        await this.settle(row.user_id, result === 'sent' ? 'sent' : 'rejected');
      } else {
        await this.settle(row.user_id, outcome);
      }
    }
  }

  async deleteAllForUser(userId: string): Promise<number> {
    this.known.delete(userId);
    return this.options.records.update((items) => {
      const kept = items.filter((r) => r.user_id !== userId);
      return { items: kept, result: items.length - kept.length };
    });
  }

  private async decide(
    row: NoAgentReminderRecord,
    at: number,
  ): Promise<'send' | 'has_agent' | 'called' | 'expired' | 'rejected'> {
    if (row.email === undefined) return 'rejected';
    if (Date.parse(row.first_seen_at) + REMINDER_TOO_LATE_MS <= at) return 'expired';
    if (await this.options.hasAgent(row.user_id)) return 'has_agent';
    if (await this.options.hasCalled(row.user_id)) return 'called';
    return 'send';
  }

  private settle(userId: string, outcome: NonNullable<NoAgentReminderRecord['outcome']>) {
    const settledAt = this.now().toISOString();
    return this.options.records.update((items) => ({
      items: items.map((r) =>
        r.user_id === userId && r.settled_at === undefined
          ? {
              user_id: r.user_id,
              first_seen_at: r.first_seen_at,
              settled_at: settledAt,
              outcome,
            }
          : r,
      ),
      result: undefined,
    }));
  }
}
