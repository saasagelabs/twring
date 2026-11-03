export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends one email. Resolves whether it was accepted; never throws. */
export interface EmailSender {
  send(message: EmailMessage): Promise<'sent' | 'retry' | 'rejected'>;
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Resend client, copied from apps/gateway/src/waitlist/notify.ts (`createResendSender`): the relay
 * must not import from the gateway, and one function does not justify a package. Logs carry the
 * outcome only, never the address.
 */
export function createResendSender(options: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  log: Log;
}): EmailSender {
  const send = options.fetch ?? fetch;
  return {
    async send(message) {
      try {
        const response = await send('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: options.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          redirect: 'error',
        });
        if (!response.ok) {
          options.log.warn(
            { event: 'email_send_failed', status: response.status },
            'email not sent',
          );
          return response.status === 429 || response.status >= 500 ? 'retry' : 'rejected';
        }
        options.log.info({ event: 'email_sent' }, 'email sent');
        return 'sent';
      } catch {
        options.log.warn({ event: 'email_send_failed' }, 'email not sent');
        return 'retry';
      }
    },
  };
}

/** Development without a Resend key: the email is skipped (and its link is not logged). */
export function createSkippingSender(log: Log): EmailSender {
  return {
    send() {
      log.info({ event: 'email_skipped' }, 'no email service configured; email skipped');
      return Promise.resolve('rejected');
    },
  };
}

/** The verification email. Plain words, no jargon. */
export function verificationEmail(options: { link: string; news: boolean }): {
  subject: string;
  text: string;
} {
  const uses = options.news
    ? 'We use this address for the ring service, security notices and occasional product news (you said yes to news; you can say no any time by replying to this email).'
    : 'We use this address only for the ring service and security notices.';
  return {
    subject: 'Confirm your Twring server',
    text: `Hi,

A Twring server was just set up with this email address. Please confirm it so your phone keeps ringing when it is locked:

${options.link}

If it is not confirmed within 7 days, rings to locked phones pause until it is. Calls and chats with the app open keep working either way.

${uses}

If you did not set up a Twring server, you can ignore this email.

Twring`,
  };
}
