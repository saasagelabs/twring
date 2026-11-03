import type { GatewayEndReason, GatewayState, StatusMessage } from '@twring/contracts';

import type { Scheduler } from './scheduler';
import type { MediaTransport, TransportEvent, TransportHandlers } from './transport';

/** Deterministic clock: time moves only when a test calls advance(). */
export class ManualScheduler implements Scheduler {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void; everyMs?: number }
  >();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback });
    return () => this.timers.delete(id);
  }

  setInterval(callback: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, callback, everyMs: ms });
    return () => this.timers.delete(id);
  }

  get pending(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.time = timer.at;
      if (timer.everyMs === undefined) this.timers.delete(id);
      else timer.at += timer.everyMs;
      timer.callback();
    }
    this.time = target;
  }
}

/** In-memory MediaTransport that records what the runtime did and lets tests inject events. */
export class FakeTransport implements MediaTransport {
  handlers: TransportHandlers | undefined;
  connectSignal: AbortSignal | undefined;
  readonly published: Int16Array[] = [];
  readonly states: GatewayState[] = [];
  readonly endReasons: GatewayEndReason[] = [];
  readonly statuses: StatusMessage[] = [];
  readonly reliableStatuses: StatusMessage[] = [];
  closeCount = 0;
  clearCount = 0;
  connectBehavior: 'resolve' | 'reject' | 'hang' = 'resolve';

  connect(handlers: TransportHandlers, signal: AbortSignal): Promise<void> {
    this.handlers = handlers;
    this.connectSignal = signal;
    if (this.connectBehavior === 'reject') return Promise.reject(new Error('ICE failed'));
    if (this.connectBehavior === 'hang') {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return Promise.resolve();
  }

  /** When true, publishing stalls like real-time playout with a full queue. */
  holdPublishing = false;

  publishFrame(samples: Int16Array): Promise<void> {
    this.published.push(samples);
    if (this.holdPublishing) return new Promise(() => undefined);
    return Promise.resolve();
  }

  clearOutput(): void {
    this.clearCount += 1;
  }

  setGatewayState(state: GatewayState, endReason?: GatewayEndReason): Promise<void> {
    this.states.push(state);
    if (endReason !== undefined) this.endReasons.push(endReason);
    return Promise.resolve();
  }

  sendStatus(message: StatusMessage, options: { reliable?: boolean } = {}): Promise<void> {
    this.statuses.push(message);
    if (options.reliable === true) this.reliableStatuses.push(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }

  emit(event: TransportEvent): void {
    this.handlers?.onEvent(event);
  }

  frame(samples: Int16Array): void {
    this.handlers?.onCallerFrame(samples);
  }
}

export interface LoggedEvent {
  level: 'info' | 'warn';
  fields: Record<string, unknown>;
}

export function recordingLogger(): {
  events: LoggedEvent[];
  names(): string[];
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
} {
  const events: LoggedEvent[] = [];
  return {
    events,
    names: () => events.map((e) => String(e.fields.event)),
    info: (fields) => events.push({ level: 'info', fields }),
    warn: (fields) => events.push({ level: 'warn', fields }),
  };
}

/** Lets every queued promise callback (the output pump) run to completion. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
