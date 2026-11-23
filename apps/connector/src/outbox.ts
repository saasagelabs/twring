/** What one send of a held result came to. */
export type OutboxSendResult = 'delivered' | 'retry' | 'dropped';

/** Results held at most this long: past it, the person has moved on. */
export const OUTBOX_MAX_AGE_MS = 60 * 60 * 1000;
/** At most this many held results; the oldest is dropped first. */
export const OUTBOX_MAX = 16;

interface Held {
  at: number;
  send: () => Promise<OutboxSendResult>;
}

/**
 * Agent results that finished while the link to Twring was down and could not be sent yet. Each is
 * kept under its turn id (the same key the gateway dedupes on) and sent again after the next
 * reconnect, so a late answer is not lost and a repeat is never shown twice. In memory only: a
 * restart of the connector drops them, like the turns themselves.
 */
export class ResultOutbox {
  private readonly held = new Map<string, Held>();
  private flushing: Promise<void> | undefined;
  private readonly max: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: { max?: number; maxAgeMs?: number; now?: () => number } = {}) {
    this.max = options.max ?? OUTBOX_MAX;
    this.maxAgeMs = options.maxAgeMs ?? OUTBOX_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.held.size;
  }

  keys(): string[] {
    return [...this.held.keys()];
  }

  /** Holds a result to send after the next reconnect; the same key replaces the earlier one. */
  hold(key: string, send: () => Promise<OutboxSendResult>): void {
    this.held.delete(key);
    this.held.set(key, { at: this.now(), send });
    while (this.held.size > this.max) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.held.delete(oldest);
    }
  }

  /** Sends every held result once, in order; one flush at a time. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async drain(): Promise<void> {
    for (const [key, entry] of [...this.held]) {
      if (this.held.get(key) !== entry) continue;
      if (this.now() - entry.at > this.maxAgeMs) {
        this.held.delete(key);
        continue;
      }
      let result: OutboxSendResult;
      try {
        result = await entry.send();
      } catch {
        result = 'retry';
      }
      // A newer result held under the same key meanwhile stays.
      if (result !== 'retry' && this.held.get(key) === entry) this.held.delete(key);
    }
  }
}
