/** How long a stopping server lets calls that are already ending finish by themselves. Kept short:
 * ending the rest, saving history and closing must all fit in systemd's TimeoutStopSec (45 s). */
export const DRAIN_WAIT_MS = 5_000;
const DRAIN_POLL_MS = 250;

/**
 * Stops the server without dropping calls mid-sentence (review finding 1): new calls are refused
 * first, calls already ending get up to 5 s, the rest are ended (their rooms and history closed),
 * and only then does the HTTP server close. A failure ending calls still closes the server.
 */
export async function gracefulShutdown(steps: {
  drain(): void;
  liveCalls(): number;
  endCalls(): Promise<void>;
  closeServer(): Promise<void>;
  closeRest(): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const sleep =
    steps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  steps.drain();
  for (let waited = 0; steps.liveCalls() > 0 && waited < DRAIN_WAIT_MS; waited += DRAIN_POLL_MS) {
    await sleep(DRAIN_POLL_MS);
  }
  try {
    await steps.endCalls();
  } finally {
    await steps.closeServer();
    await steps.closeRest();
  }
}

/** How often the live-call count is checked for the deploy script. */
export const LIVE_CALLS_CHECK_MS = 2_000;

/**
 * Keeps a small file holding the number of live calls (`$CORD_DATA_DIR/live-calls`), so a deploy
 * can wait for 0 before restarting. Written at once and whenever the count changes; a failed
 * write is tried again on the next tick. Returns a stop function.
 */
export function watchLiveCalls(options: {
  count: () => number;
  write: (text: string) => Promise<void>;
}): () => void {
  let written: number | undefined;
  let busy = false;
  const tick = async () => {
    const live = options.count();
    if (live === written || busy) return;
    busy = true;
    try {
      await options.write(`${live}\n`);
      written = live;
    } catch {
      // Tried again next tick; the deploy treats a stale file as "unknown" and waits.
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), LIVE_CALLS_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
