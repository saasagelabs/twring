import { spawn, type ChildProcess } from 'node:child_process';
import { open, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LOG_MAX_BYTES,
  logPath,
  pidPath,
  prepareLog,
  removeRunFiles,
  retryWhileBusy,
  rotateLog,
} from './service';

/**
 * Windows: a service that was just stopped can still hold its log for a moment, so touching the
 * file fails with EBUSY. Setup waits for it; uninstall leaves it behind and says so.
 */

const WINDOWS = process.platform === 'win32';

const dirs: string[] = [];
const holders: ChildProcess[] = [];
afterEach(async () => {
  for (const holder of holders.splice(0)) holder.kill();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

/**
 * Holds `log` open for appending for about `holdMs`, the way the Windows launcher's
 * `cmd /c node ... >> log` does, and resolves once the file is held.
 */
async function holdLog(log: string, holdMs: number): Promise<void> {
  const holder = spawn(
    'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      `""${process.execPath}" -e "setTimeout(()=>{},${holdMs})" >> "${log}" 2>&1"`,
    ],
    { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore' },
  );
  holders.push(holder);
  for (const until = Date.now() + 5_000; Date.now() < until;) {
    try {
      await (await open(log, 'a')).close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EBUSY') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the log was never held');
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cord-busy-'));
  dirs.push(dir);
  return dir;
}

const busy = () => Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
const noWait = [0, 0, 0];

describe('files another process still holds', () => {
  it('are tried again after a short wait', async () => {
    let tries = 0;
    const result = await retryWhileBusy(() => {
      tries += 1;
      return tries < 3 ? Promise.reject(busy()) : Promise.resolve('done');
    }, noWait);
    expect(result).toBe('done');
    expect(tries).toBe(3);
  });

  it('other errors are not retried', async () => {
    let tries = 0;
    const missing = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    await expect(
      retryWhileBusy(() => {
        tries += 1;
        return Promise.reject(missing);
      }, noWait),
    ).rejects.toBe(missing);
    expect(tries).toBe(1);
  });

  it('a log that stays busy does not stop setup: it is kept and rotated another time', async () => {
    const dir = await tempDir();
    const log = logPath(dir);
    await writeFile(log, 'x'.repeat(30));
    await prepareLog(log, 20, { rotate: () => Promise.reject(busy()), waits: noWait });
    expect(await readFile(log, 'utf8')).toBe('x'.repeat(30));
  });

  it('a log that frees up in time is rotated as usual', async () => {
    const dir = await tempDir();
    const log = logPath(dir);
    await writeFile(log, 'x'.repeat(30));
    let tries = 0;
    await prepareLog(log, 20, {
      rotate: (path, max) => {
        tries += 1;
        return tries < 2 ? Promise.reject(busy()) : rotateLog(path, max);
      },
      waits: noWait,
    });
    expect(await readFile(log, 'utf8')).toBe('');
    expect(await readFile(`${log}.1`, 'utf8')).toBe('x'.repeat(30));
  });

  it('uninstall removes what it can and leaves a busy log behind', async () => {
    const dir = await tempDir();
    for (const name of ['config.json', 'cord-connect.pid', 'status.json', 'cord-connect.log']) {
      await writeFile(join(dir, name), 'x');
    }
    const left = await removeRunFiles(dir, {
      remove: (path) =>
        path.endsWith('cord-connect.log') ? Promise.reject(busy()) : rm(path, { force: true }),
      waits: noWait,
    });
    expect((await readdir(dir)).sort()).toEqual(['config.json', 'cord-connect.log']);
    expect(left).toEqual([logPath(dir)]);
  });

  it('a real permission problem is not mistaken for a busy file', async () => {
    const dir = await tempDir();
    const denied = () => Object.assign(new Error('permission denied'), { code: 'EACCES' });
    await expect(
      prepareLog(logPath(dir), 20, { rotate: () => Promise.reject(denied()), waits: noWait }),
    ).rejects.toMatchObject({ code: 'EACCES' });
    await expect(
      removeRunFiles(dir, { remove: () => Promise.reject(denied()), waits: noWait }),
    ).rejects.toMatchObject({ code: 'EACCES' });
    // EPERM means busy only on Windows; elsewhere it is a permission problem.
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' });
    const removing = removeRunFiles(dir, { remove: () => Promise.reject(eperm), waits: noWait });
    if (WINDOWS) expect((await removing).length).toBeGreaterThan(0);
    else await expect(removing).rejects.toBe(eperm);
  });

  it.runIf(WINDOWS)(
    'setup waits for a log the stopped service still holds, then carries on (real file)',
    async () => {
      const dir = await tempDir();
      const log = logPath(dir);
      await writeFile(log, 'before\n');
      await holdLog(log, 600);
      await prepareLog(log, LOG_MAX_BYTES, { waits: [250, 500, 1_000, 2_000] });
      expect(await readFile(log, 'utf8')).toContain('before');
    },
    20_000,
  );

  it.runIf(WINDOWS)(
    'uninstall leaves a log still held, says which, and removes the rest (real file)',
    async () => {
      const dir = await tempDir();
      const log = logPath(dir);
      await writeFile(pidPath(dir), '1\n');
      await writeFile(log, 'before\n');
      await holdLog(log, 3_000);
      const left = await removeRunFiles(dir, { waits: [50] });
      expect(left).toEqual([log]);
      expect(await readdir(dir)).toEqual(['cord-connect.log']);
    },
    20_000,
  );
});
