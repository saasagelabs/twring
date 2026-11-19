/**
 * Ending the call's audio session without blocking the hang-up.
 *
 * iOS refuses to deactivate the session while audio I/O is still running (TWRING-APP-5/6), and
 * WebRTC's audio unit stops a moment after the room disconnects. So a refusal is retried in the
 * background after short delays; only a session that still will not end is reported. Until it
 * ends, other apps' audio (music, podcasts) stays ducked.
 */

/** Delays before each retry after the first refusal. */
export const STOP_RETRY_DELAYS_MS = [300, 1000] as const;

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let pending: AbortController | undefined;

/**
 * A new call cancels any retry still waiting to end the previous call's session: a late retry
 * would otherwise switch off the new call's audio.
 */
export function cancelPendingStop(): void {
  pending?.abort();
  pending = undefined;
}

/**
 * Stops the audio session once and returns; after a refusal, retries in the background and
 * calls `report` with the last error only if every retry is refused too.
 */
export async function stopAudioSessionWithRetry(
  stop: () => Promise<void>,
  report: (error: unknown) => void,
  wait: (ms: number) => Promise<void> = defaultWait,
): Promise<void> {
  try {
    await stop();
    return;
  } catch (refusal) {
    cancelPendingStop();
    const controller = new AbortController();
    pending = controller;
    void retry(controller, refusal, stop, report, wait);
  }
}

async function retry(
  controller: AbortController,
  refusal: unknown,
  stop: () => Promise<void>,
  report: (error: unknown) => void,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  let last = refusal;
  for (const delay of STOP_RETRY_DELAYS_MS) {
    await wait(delay);
    if (controller.signal.aborted) return;
    try {
      await stop();
      if (pending === controller) pending = undefined;
      return;
    } catch (error) {
      last = error;
    }
  }
  if (controller.signal.aborted) return;
  if (pending === controller) pending = undefined;
  report(last);
}
