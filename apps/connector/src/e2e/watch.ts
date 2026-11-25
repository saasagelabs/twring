import type { E2eConfig } from './keys';
import { helloFeatures } from './turn';

/** How often a running copy with no paired phone reads its saved private chat settings again. */
export const PAIRING_WATCH_MS = 10_000;

const hasPhone = (e2e: E2eConfig | undefined) =>
  e2e?.devices.some((device) => device.kind === 'phone') ?? false;

export interface PairingWatch {
  /** Reads the saved settings now; says hello again if what this copy offers changed. */
  check(): Promise<void>;
  stop(): void;
}

/**
 * `private pair` runs as its own process and writes the paired phone into the config file: the
 * running copy reads it from there (only reads, so it never writes back an old copy) every
 * PAIRING_WATCH_MS until a phone is paired here, and says hello again with the new features, so
 * Twring starts handing it private messages without a restart.
 */
export function watchPairing(options: {
  read: () => Promise<E2eConfig | undefined>;
  current: () => E2eConfig | undefined;
  apply: (e2e: E2eConfig | undefined) => void;
  rehello: () => void;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): PairingWatch {
  const set = options.setInterval ?? ((fn, ms) => setInterval(fn, ms).unref());
  const clear =
    options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let handle: unknown;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (handle !== undefined) clear(handle);
    handle = undefined;
  };
  const check = async () => {
    if (stopped) return;
    const fresh = await options.read().catch(() => undefined);
    if (stopped) return;
    if (helloFeatures(fresh).join() !== helloFeatures(options.current()).join()) {
      options.apply(fresh);
      options.rehello();
    }
    if (hasPhone(options.current())) stop();
  };
  if (hasPhone(options.current())) stopped = true;
  else
    handle = set(() => void check().catch(() => undefined), options.intervalMs ?? PAIRING_WATCH_MS);
  return { check, stop };
}
