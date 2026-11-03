import type { RelayDb } from './db';
import { verificationEmail, type EmailSender } from './email';
import {
  emailSendKey,
  newLinkToken,
  sha256Hex,
  UNVERIFIED_GRACE_MS,
  VERIFY_LINK_TTL_MS,
} from './installs';

/** Verification emails to one address per 24 hours, whoever registers it. */
export const EMAILS_PER_ADDRESS_PER_DAY = 3;
/** Re-registering an unverified install sends no new email this soon after the last one. */
export const RESEND_AFTER_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface PendingRow {
  id: string;
  email: string;
  news: number;
  verified_at: string | null;
  revoked_at: string | null;
  created_at: string;
  email_requested_at: number | null;
  email_pending: number;
}

/**
 * Verification emails with caps and a small queue. A wanted email is marked pending on the
 * install; it goes out now if the per-address and relay-wide caps allow, otherwise (or when the
 * email service fails for now) a timer retries it until it is sent or the install's 7 days pass.
 * A fresh link token is minted per email and only its hash is stored, after the send succeeds.
 */
/** Forgets send records older than a day (the caps look back one day). Run by the sweeper. */
export function pruneEmailSends(db: RelayDb, now: number): void {
  db.sqlite.prepare('DELETE FROM email_sends WHERE sent_at <= ?').run(now - DAY_MS);
}

export class Mailer {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly options: {
      db: RelayDb;
      sender: EmailSender;
      publicUrl: string;
      perDay: number;
      now: () => number;
      log: { info(obj: object, msg: string): void };
    },
  ) {}

  /** Asks for a verification email for this install and tries to send it now. */
  async request(installId: string): Promise<void> {
    this.options.db.sqlite
      .prepare('UPDATE installs SET email_pending = 1, email_requested_at = ? WHERE id = ?')
      .run(this.options.now(), installId);
    await this.deliver(installId);
  }

  /** Retries every held email (the timer calls this). */
  async retryPending(): Promise<void> {
    const rows = this.options.db.sqlite
      .prepare('SELECT id FROM installs WHERE email_pending = 1')
      .all() as { id: string }[];
    for (const row of rows) await this.deliver(row.id);
  }

  private async deliver(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      await this.deliverOnce(id);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async deliverOnce(id: string): Promise<void> {
    const { db, now } = this.options;
    const row = db.sqlite
      .prepare(
        'SELECT id, email, news, verified_at, revoked_at, created_at, email_requested_at, email_pending FROM installs WHERE id = ?',
      )
      .get(id) as PendingRow | undefined;
    if (row === undefined || row.email_pending !== 1) return;
    const at = now();
    const done = () =>
      db.sqlite.prepare('UPDATE installs SET email_pending = 0 WHERE id = ?').run(id);
    if (
      row.verified_at !== null ||
      row.revoked_at !== null ||
      // Give up 7 days after the email was asked for (not after the install was created).
      at - (row.email_requested_at ?? Date.parse(row.created_at)) >= UNVERIFIED_GRACE_MS
    ) {
      done();
      return;
    }

    db.sqlite.prepare('DELETE FROM email_sends WHERE sent_at <= ?').run(at - DAY_MS);
    const count = (sql: string, ...args: (string | number)[]) =>
      (db.sqlite.prepare(sql).get(...args) as { n: number }).n;
    if (
      count(
        'SELECT COUNT(*) AS n FROM email_sends WHERE address = ? AND sent_at > ?',
        emailSendKey(row.email),
        at - DAY_MS,
      ) >= EMAILS_PER_ADDRESS_PER_DAY ||
      count('SELECT COUNT(*) AS n FROM email_sends WHERE sent_at > ?', at - DAY_MS) >=
        this.options.perDay
    ) {
      this.options.log.info({ event: 'install_email_held' }, 'verification email held by a cap');
      return;
    }

    const token = newLinkToken();
    const link = new URL('/v1/installs/verify', this.options.publicUrl);
    link.searchParams.set('t', token);
    const outcome = await this.options.sender.send({
      to: row.email,
      ...verificationEmail({ link: link.toString(), news: row.news === 1 }),
    });
    this.options.log.info({ event: 'install_email', outcome }, 'verification email');
    if (outcome === 'retry') return;
    if (outcome === 'rejected') {
      done();
      return;
    }
    const sentAt = now();
    db.sqlite
      .prepare('INSERT INTO email_sends (address, sent_at) VALUES (?, ?)')
      .run(emailSendKey(row.email), sentAt);
    db.sqlite
      .prepare(
        `UPDATE installs SET email_pending = 0, last_email_at = ?, verify_hash = ?,
           verify_expires_at = ? WHERE id = ?`,
      )
      .run(sentAt, sha256Hex(token), new Date(sentAt + VERIFY_LINK_TTL_MS).toISOString(), id);
  }
}
