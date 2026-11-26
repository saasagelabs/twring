import { randomUUID } from 'node:crypto';
import { open, readFile, rm, stat } from 'node:fs/promises';

import { loadConfig, saveConfig, type ConnectorConfig } from '../config';
import { e2eConfigSchema, type E2eConfig } from './keys';

/** How long a change waits for another process's lock before giving up. */
export const LOCK_WAIT_MS = 10_000;
/** A lock older than this was left by a process that died mid-change: it is taken over. */
export const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 15;

let queue: Promise<unknown> = Promise.resolve();

export interface UpdateE2eOptions {
  waitMs?: number;
}

/**
 * Changes the private chat part of the saved config: read fresh from disk, changed, written back,
 * one change at a time in this process and, through a lock file next to the config, across
 * processes. The running copy and `private pair` both write it, so neither may write back an old
 * copy of what the other changed (a lost phone, or a seq used twice). Undefined when the file has
 * no device key (it was removed or paired again meanwhile).
 */
export function updateE2e(
  path: string,
  change: (current: E2eConfig) => E2eConfig,
  options: UpdateE2eOptions = {},
): Promise<E2eConfig | undefined> {
  const run = queue.then(() =>
    withFileLock(`${path}.lock`, options.waitMs ?? LOCK_WAIT_MS, async () => {
      const config = await loadConfig(path);
      if (config?.e2e === undefined) return undefined;
      // Never write what the next load would call damaged: a bad change throws instead.
      const e2e = e2eConfigSchema.parse(change(config.e2e));
      await saveConfig(path, { ...config, e2e });
      return e2e;
    }),
  );
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Changes the whole saved config under the same lock as updateE2e, from a fresh read (undefined
 * when there is none or it is damaged). A command that loaded the config before slow work (agent
 * detection, a server request) writes through this, so it never puts back an old private chat
 * part the running copy changed meanwhile (a removed phone, a used seq).
 */
export function updateConfig(
  path: string,
  change: (current: ConnectorConfig | undefined) => ConnectorConfig,
  options: UpdateE2eOptions = {},
): Promise<ConnectorConfig> {
  const run = queue.then(() =>
    withFileLock(`${path}.lock`, options.waitMs ?? LOCK_WAIT_MS, async () => {
      const current = await loadConfig(path).catch(() => undefined);
      const config = change(current);
      await saveConfig(path, config);
      return config;
    }),
  );
  queue = run.catch(() => undefined);
  return run;
}

/**
 * The fresh config with only what a command changed (name, agents, server, token), keeping its
 * private chat part. When the file now holds another pairing (or none), `loaded` is the base: the
 * command's own link is what it just used.
 */
export function withCommandFields(
  current: ConnectorConfig | undefined,
  loaded: ConnectorConfig,
  fields: Partial<Pick<ConnectorConfig, 'name' | 'agents' | 'server' | 'token'>>,
): ConnectorConfig {
  const base = current?.connector_id === loaded.connector_id ? current : loaded;
  return { ...base, ...fields };
}

/**
 * Runs `fn` while holding `lockPath`, made with the exclusive 'wx' flag (atomic on Windows, macOS
 * and Linux). Waits up to `waitMs` for another holder; a lock older than LOCK_STALE_MS is removed.
 * The lock holds a random token and is removed afterwards only if it still holds this one, so a
 * change that ran past LOCK_STALE_MS never removes the lock of the process that took it over.
 */
async function withFileLock<T>(lockPath: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid} ${randomUUID()}\n`;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(token);
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows answers EPERM while another process is deleting the file.
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
    }
    const seen = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (seen !== undefined && (await ageOf(lockPath)) > LOCK_STALE_MS) {
      await takeOver(lockPath, seen);
      continue;
    }
    if (Date.now() >= deadline) throw new Error('config is busy');
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
  try {
    return await fn();
  } finally {
    const holder = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (holder === token) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

const ageOf = (path: string): Promise<number> =>
  stat(path).then(
    (s) => Date.now() - s.mtimeMs,
    () => 0,
  );

/**
 * Removes a stale lock only while holding `${lockPath}.takeover` (made with 'wx'), and only if it
 * still holds the `seen` content. Two waiters that both found it stale can then never both remove
 * it: the second finds the first one's new lock (another token) and leaves it alone. A takeover
 * lock left by a process that died in those few milliseconds is removed once stale.
 */
async function takeOver(lockPath: string, seen: string): Promise<void> {
  const takeoverPath = `${lockPath}.takeover`;
  try {
    const handle = await open(takeoverPath, 'wx', 0o600);
    await handle.close();
  } catch {
    if ((await ageOf(takeoverPath)) > LOCK_STALE_MS)
      await rm(takeoverPath, { force: true }).catch(() => undefined);
    return;
  }
  try {
    const now = await readFile(lockPath, 'utf8').catch(() => undefined);
    if (now === seen) await rm(lockPath, { force: true }).catch(() => undefined);
  } finally {
    await rm(takeoverPath, { force: true }).catch(() => undefined);
  }
}
