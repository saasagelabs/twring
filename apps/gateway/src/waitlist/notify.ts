import { FixedWindowLimiter } from '../rate-limit';

export interface NewSignup {
  email: string;
  source: 'landing' | 'beta' | 'app';
  createdAt: string;
  total: number;
}

export type SignupNotifier = (signup: NewSignup) => Promise<void>;

/** The owner's email for one request; used only when the invite gate is off. */
export function signupEmail(signup: NewSignup): { subject: string; text: string } {
  return {
    subject: `New Twring beta request: ${signup.email}`,
    text: `Someone asked for Twring beta access.

Email: ${signup.email}
Source: ${signup.source === 'beta' ? 'twring.com/beta' : signup.source === 'app' ? 'app' : 'twring.com landing page'}
Time: ${signup.createdAt} (UTC)
Requests in the list: ${signup.total}

To let them in, ask Claude to add them, or add them with the members command from the operations checkout.
Then send them the invite email.`,
  };
}

export function createResendNotifier(options: {
  apiKey: string;
  from: string;
  to: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxPerHour?: number;
  now?: () => number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): SignupNotifier {
  const send = options.fetch ?? fetch;
  const limiter = new FixedWindowLimiter(options.maxPerHour ?? 30, 60 * 60_000, options.now);

  return async (signup) => {
    if (!limiter.tryAcquire('waitlist')) {
      options.log.info(
        { event: 'waitlist_notify_skipped' },
        'waitlist notification rate cap reached',
      );
      return;
    }

    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [options.to],
          ...signupEmail(signup),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        options.log.warn(
          { event: 'waitlist_notify_failed', status: response.status },
          'waitlist notification failed',
        );
        return;
      }
      options.log.info({ event: 'waitlist_notify_sent' }, 'waitlist notification sent');
    } catch {
      options.log.warn({ event: 'waitlist_notify_failed' }, 'waitlist notification failed');
    }
  };
}

/** Sends one email through Resend. Resolves whether it was accepted; never throws. */
export function createResendSender(options: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): (email: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}) => Promise<'sent' | 'retry' | 'rejected'> {
  const send = options.fetch ?? fetch;
  return async (email) => {
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.replyTo !== undefined && { reply_to: email.replyTo }),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        options.log.warn({ event: 'email_send_failed', status: response.status }, 'email not sent');
        // Rate limit, daily cap or an outage: try later. Anything else: this email won't go.
        return response.status === 429 || response.status >= 500 ? 'retry' : 'rejected';
      }
      options.log.info({ event: 'email_sent' }, 'email sent');
      return 'sent';
    } catch {
      options.log.warn({ event: 'email_send_failed' }, 'email not sent');
      return 'retry';
    }
  };
}
