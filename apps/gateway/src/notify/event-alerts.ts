/**
 * Alerts that reach the owner before users do (wave 1, track 2.2). Every log line passes through
 * `record`; each rule counts what it cares about in 5-minute windows and alerts once per window
 * when its count reaches the threshold. The owner alert itself sends at most one email per subject
 * a day. Thresholds start conservative and are tuned after a week.
 */

export const ALERT_WINDOW_MS = 5 * 60_000;

/** pino's level for error. */
const ERROR_LEVEL = 50;

export interface AlertRule {
  subject: string;
  threshold: number;
  /** How much this log line adds to the rule's count (0 for most lines). */
  count(level: number, fields: Record<string, unknown>): number;
  /** With a key, the count is how many different keys were seen (one flapping laptop is one). */
  key?(fields: Record<string, unknown>): string | undefined;
  text(count: number): string;
}

const isEvent = (fields: Record<string, unknown>, ...names: string[]) =>
  typeof fields.event === 'string' && names.includes(fields.event);

export const WAVE_ONE_RULES: readonly AlertRule[] = [
  {
    subject: 'Twring: calls failing',
    threshold: 3,
    count: (_level, f) => (isEvent(f, 'call_failed', 'call_create_failed') ? 1 : 0),
    text: (n) =>
      `${n} calls failed in 5 minutes. Check the gateway log (journalctl -u cord-gateway) for call_failed and call_create_failed, and LiveKit and Deepgram status.`,
  },
  {
    subject: 'Twring: pushes failing',
    threshold: 5,
    count: (_level, f) => {
      if (isEvent(f, 'ring_unreachable')) return 1;
      if (isEvent(f, 'push_sent') && typeof f.failed === 'number') return f.failed;
      return 0;
    },
    text: (n) =>
      `${n} pushes failed or rings reached no phone in 5 minutes. Phones may not be ringing. Check push_sent and ring_unreachable in the gateway log, and the FCM and APNs keys.`,
  },
  {
    subject: 'Twring: server errors',
    threshold: 5,
    count: (level) => (level >= ERROR_LEVEL ? 1 : 0),
    text: (n) =>
      `${n} server errors in 5 minutes. Check the gateway log for level 50 lines (journalctl -u cord-gateway).`,
  },
  {
    subject: 'Twring: computers dropping',
    threshold: 3,
    count: (_level, f) => (isEvent(f, 'connector_disconnected') ? 1 : 0),
    key: (f) => (typeof f.connector_id === 'string' ? f.connector_id : undefined),
    text: (n) =>
      `${n} computers disconnected in 5 minutes. A network problem on the server, or a bad release of the computer tool, can do this.`,
  },
];

export class EventAlerts {
  private window = -1;
  private readonly counts = new Map<AlertRule, number>();
  private readonly keys = new Map<AlertRule, Set<string>>();
  private readonly fired = new Set<AlertRule>();
  private stopped = false;

  constructor(
    private readonly options: {
      rules: readonly AlertRule[];
      alert: (subject: string, text: string) => void;
      now?: () => number;
    },
  ) {}

  /** One log line. Never throws: logging must not fail because of an alert. */
  record(level: number, fields: unknown): void {
    if (this.stopped) return;
    try {
      const f =
        typeof fields === 'object' && fields !== null ? (fields as Record<string, unknown>) : {};
      const window = Math.floor((this.options.now ?? Date.now)() / ALERT_WINDOW_MS);
      if (window !== this.window) {
        this.window = window;
        this.counts.clear();
        this.keys.clear();
        this.fired.clear();
      }
      for (const rule of this.options.rules) {
        const add = rule.count(level, f);
        if (!(add > 0)) continue;
        const key = rule.key?.(f);
        let total: number;
        if (key !== undefined) {
          const seen = this.keys.get(rule) ?? new Set<string>();
          seen.add(key);
          this.keys.set(rule, seen);
          total = seen.size + (this.counts.get(rule) ?? 0);
        } else {
          total = (this.counts.get(rule) ?? 0) + add;
          this.counts.set(rule, total);
        }
        if (total >= rule.threshold && !this.fired.has(rule)) {
          this.fired.add(rule);
          this.options.alert(rule.subject, rule.text(total));
        }
      }
    } catch {
      // A broken rule must never break logging.
    }
  }

  /** The server is shutting down: its own disconnects and errors are not news. */
  stop(): void {
    this.stopped = true;
  }
}
