import type { InviteStatus } from '@twring/contracts';

/**
 * iOS: a ring on the system call screen is checked on the server every few seconds, because the
 * cancel push (an ordinary push) may never arrive. When the invite is no longer pending, the call
 * screen closes with the matching reason. Checking stops once the ring is answered, declined or
 * gone from the call screen; the native ring timer still ends it if the server cannot be reached.
 */
export interface RingWatchDeps {
  /** Rings still showing (unanswered) on the system call screen. */
  ringing(): Promise<string[]>;
  getStatus(inviteId: string, signal: AbortSignal): Promise<InviteStatus>;
  ringOver(inviteId: string, status: InviteStatus): void;
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  intervalMs?: number;
  timeoutMs?: number;
}

export const RING_WATCH_INTERVAL_MS = 3_000;
export const RING_WATCH_TIMEOUT_MS = 2_500;

/** A ring that is no longer pending on the server is over. */
export function ringIsOver(status: InviteStatus): boolean {
  return status !== 'pending';
}

export interface RingWatch {
  watch(inviteId: string): void;
  stopAll(): void;
  watching(): string[];
}

export function createRingWatch(deps: RingWatchDeps): RingWatch {
  const intervalMs = deps.intervalMs ?? RING_WATCH_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? RING_WATCH_TIMEOUT_MS;
  const watches = new Map<string, { handle: unknown; busy: boolean }>();

  const stop = (inviteId: string) => {
    const entry = watches.get(inviteId);
    if (entry === undefined) return;
    deps.clearInterval(entry.handle);
    watches.delete(inviteId);
  };

  const check = async (inviteId: string) => {
    const entry = watches.get(inviteId);
    if (entry === undefined || entry.busy) return;
    entry.busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (!(await deps.ringing()).includes(inviteId)) {
        stop(inviteId);
        return;
      }
      const status = await deps.getStatus(inviteId, controller.signal);
      if (!watches.has(inviteId) || !ringIsOver(status)) return;
      stop(inviteId);
      deps.ringOver(inviteId, status);
    } catch {
      // Offline or slow: try again next time; the ring's own timer still ends it.
    } finally {
      clearTimeout(timer);
      entry.busy = false;
    }
  };

  return {
    watch(inviteId) {
      if (watches.has(inviteId)) return;
      const handle = deps.setInterval(() => void check(inviteId), intervalMs);
      watches.set(inviteId, { handle, busy: false });
    },
    stopAll() {
      [...watches.keys()].forEach(stop);
    },
    watching: () => [...watches.keys()],
  };
}
