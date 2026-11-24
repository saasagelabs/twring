import { loadConfig, saveConfig } from '../config';
import type { E2eConfig } from './keys';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Changes the private chat part of the saved config: read fresh from disk, changed, written back,
 * one change at a time in this process. The running copy and `private pair` both write it, so
 * neither may write back an old copy of what the other changed. Undefined when the file has no
 * device key (it was removed or paired again meanwhile).
 */
export function updateE2e(
  path: string,
  change: (current: E2eConfig) => E2eConfig,
): Promise<E2eConfig | undefined> {
  const run = queue.then(async () => {
    const config = await loadConfig(path);
    if (config?.e2e === undefined) return undefined;
    const e2e = change(config.e2e);
    await saveConfig(path, { ...config, e2e });
    return e2e;
  });
  queue = run.catch(() => undefined);
  return run;
}
