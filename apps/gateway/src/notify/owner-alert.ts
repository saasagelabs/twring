/**
 * Emails the owner about the service (wave 1: today's calling is running out). Sent through
 * Resend like the waitlist notice, at most once per subject per UTC day so a busy day sends one
 * email, not hundreds. Never throws: an alert must not affect what triggered it.
 */
export type OwnerAlert = (
  subject: string,
  text: string,
  options?: { repeatAfterMs?: number },
) => Promise<void>;

export function createOwnerAlert(options: {
  apiKey: string;
  from: string;
  to: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): OwnerAlert {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sentOn = new Map<string, { day: string; at: number }>();

  return async (subject, text, alertOptions) => {
    const at = now();
    const day = new Date(at).toISOString().slice(0, 10);
    const last = sentOn.get(subject);
    // Once a UTC day by default; with repeatAfterMs, again once that long has passed (a second
    // outage the same day still reaches the owner).
    const repeat = alertOptions?.repeatAfterMs;
    if (last !== undefined && (repeat === undefined ? last.day === day : at - last.at < repeat)) {
      return;
    }
    // Claimed before sending so two triggers at once send one email; released if it fails, so
    // the next trigger tries again.
    const claim = { day, at };
    sentOn.set(subject, claim);
    const release = () => {
      if (sentOn.get(subject) === claim) {
        if (last === undefined) sentOn.delete(subject);
        else sentOn.set(subject, last);
      }
    };
    try {
      const response = await send('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: options.from, to: [options.to], subject, text }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        redirect: 'error',
      });
      if (!response.ok) {
        release();
        options.log.warn(
          { event: 'owner_alert_failed', status: response.status },
          'owner alert failed',
        );
        return;
      }
      options.log.info({ event: 'owner_alert_sent', subject }, 'owner alert sent');
    } catch {
      release();
      options.log.warn({ event: 'owner_alert_failed' }, 'owner alert failed');
    }
  };
}
