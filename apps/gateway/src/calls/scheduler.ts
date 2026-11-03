/** Timer seam so call-lifecycle timeouts are testable without real waits. */
export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
  setInterval(callback: () => void, ms: number): () => void;
}

export const systemScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    return () => clearInterval(handle);
  },
};
