/** How often live calls are counted. */
export const CONCURRENCY_CHECK_MS = 30_000;

/** Live calls at which the owner hears that the server is getting full: 80% of the limit. */
export function alertThreshold(limit: number): number {
  return Math.max(1, Math.ceil(limit * 0.8));
}

/**
 * Tells the owner when live calls near `CALL_MAX_CONCURRENT` (wave 1: time to plan a bigger
 * server). The alert itself is deduplicated per day by the owner alert. Returns a stop function.
 */
export function watchConcurrency(options: {
  count: () => number;
  limit: number;
  alert: (live: number, limit: number) => void;
}): () => void {
  const threshold = alertThreshold(options.limit);
  const timer = setInterval(() => {
    const live = options.count();
    if (live >= threshold) options.alert(live, options.limit);
  }, CONCURRENCY_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
