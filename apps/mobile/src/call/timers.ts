/** Timer seam so call timeouts are testable (CLAUDE.md: timers behind testable abstractions). */
export interface Timers {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

/** Named call timeouts (CALL_STATE_MACHINE §10). */
export const CALL_TIMEOUTS = {
  /** POST /v1/calls round trip. */
  prepareMs: 10_000,
  /** Joining LiveKit and publishing the microphone. */
  mediaConnectMs: 15_000,
  /** From session created until both media and gateway are ready. */
  gatewayReadyMs: 20_000,
  /** How long RECONNECTING may last before the call fails. */
  reconnectBudgetMs: 20_000,
  /** Best-effort server hang-up during cleanup. */
  endRequestMs: 3_000,
  /** One microphone mute/unmute on the transport; past it the view rolls back to the real state. */
  muteMs: 3_000,
  /** Waiting for the background service start and then its stop, so hang-up always finishes. */
  backgroundStopMs: 5_000,
} as const;

/**
 * A signal that aborts when `parent` aborts or after `ms`. Hand-rolled because React Native's
 * AbortSignal lacks the static `any()` and `timeout()` helpers. Call `dispose()` when done so
 * the timer and listener don't outlive the request.
 */
export function deadline(
  parent: AbortSignal,
  ms: number,
  timers: Timers,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort);
  const cancelTimer = timers.setTimeout(abort, ms);
  return {
    signal: controller.signal,
    dispose: () => {
      cancelTimer();
      parent.removeEventListener('abort', abort);
    },
  };
}
