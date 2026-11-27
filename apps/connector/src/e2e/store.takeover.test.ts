import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as FsPromises from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, saveConfig } from '../config';
import { ensureDeviceKey, type E2eConfig } from './keys';
import type * as Store from './store';
import { baseConfig } from './test-fixtures';

/** Both waiters stat the stale lock before either removes it: the race in R3-8. */
const barrier = vi.hoisted(() => ({
  lockPath: '',
  waiting: 0,
  release: () => {},
  opened: false,
  removes: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    // The second waiter's delete lands only after the first has made its own lock.
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (String(args[0]) === barrier.lockPath) barrier.opened = true;
      return handle;
    },
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (String(args[0]) === barrier.lockPath && ++barrier.removes === 2) {
        while (!barrier.opened) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return real.rm(...args);
    },
    // Saving takes a moment, so a second holder would read the config before it is saved.
    rename: async (...args: Parameters<typeof real.rename>) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return real.rename(...args);
    },
    stat: async (...args: Parameters<typeof real.stat>) => {
      const result = await real.stat(...args);
      if (String(args[0]) === barrier.lockPath && barrier.waiting < 2) {
        barrier.waiting++;
        const both = new Promise<void>((resolve) => {
          const previous = barrier.release;
          barrier.release = () => {
            previous();
            resolve();
          };
        });
        if (barrier.waiting === 2) barrier.release();
        await both;
      }
      return result;
    },
  };
});

const PHONE_1 = `dev_${'c'.repeat(20)}`;
const PHONE_2 = `dev_${'d'.repeat(20)}`;

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twring-takeover-'));
  path = join(dir, 'config.json');
  await saveConfig(path, ensureDeviceKey(baseConfig).config);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A separate copy of the store module, as a second process would have (its own queue). */
async function freshStore(): Promise<typeof Store> {
  vi.resetModules();
  return import('./store');
}

describe('taking over a stale lock (R3-8)', () => {
  it('lets only one of two waiters hold it, and keeps both changes', async () => {
    await writeFile(`${path}.lock`, 'dead\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);
    barrier.lockPath = `${path}.lock`;
    barrier.waiting = 0;
    barrier.release = () => {};
    barrier.opened = false;
    barrier.removes = 0;

    const a = await freshStore();
    const b = await freshStore();
    const addPhone =
      (id: string) =>
      (current: E2eConfig): E2eConfig => ({
        ...current,
        devices: [
          ...current.devices,
          {
            id,
            kind: 'phone' as const,
            name: 'Pixel',
            public_key: current.public_key,
            verified_at: '2026-11-25T00:00:00.000Z',
          },
        ],
      });
    await Promise.all([a.updateE2e(path, addPhone(PHONE_1)), b.updateE2e(path, addPhone(PHONE_2))]);
    const saved = await loadConfig(path);
    expect(saved?.e2e?.devices.map((d) => d.id).sort()).toEqual([PHONE_1, PHONE_2]);
  });
});
