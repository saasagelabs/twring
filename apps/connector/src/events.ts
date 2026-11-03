import type { ApprovalAction, FileMimeType } from '@twring/contracts';
import type { LocalFile } from './turn-files';

/**
 * What a local agent adapter reports while it answers one turn. The channel session turns these
 * into Twring `AgentEvent`s (ids, seq, run.started/done), so each adapter only translates its own
 * agent's wire format. Adapters relay the agent's own activity; they never run tools themselves.
 */
export type LocalAgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool.start'; id: string; name: string; label?: string }
  | { type: 'tool.end'; id: string; status: 'success' | 'error' | 'cancelled' }
  | { type: 'activity'; label: string }
  | { type: 'file'; name: string; mimeType: FileMimeType; data: Uint8Array }
  | {
      type: 'approval.required';
      id: string;
      action: ApprovalAction;
      title: string;
      description?: string;
    };

/**
 * One agent on this computer, for one call. `sendTurn` streams the agent's answer to `text` and
 * ends when the agent is done; aborting `signal` cancels the turn (the adapter asks the agent to
 * stop the way its interface allows). Only one turn runs at a time. `close` ends the agent.
 */
export interface LocalAgentAdapter {
  sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { surface?: 'call' | 'text'; files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent>;
  close(): void;
  decide?(approvalId: string, decision: 'approve' | 'deny'): void;
  sessionRef?(): string | undefined;
  /** Consumes a session replacement marker, once on the first turn of the new session. */
  takeNewSession?(): boolean;
}

/** A failure the phone may hear about; `code` is stable, never agent text. */
export class LocalAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalAgentError';
  }
}

/** Callback → async iterable, single consumer. */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    this.wake();
  }

  get isEnded(): boolean {
    return this.ended;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.ended) {
        if (this.failure !== null) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}
