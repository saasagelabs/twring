import { afterEach, describe, expect, it, vi } from 'vitest';

import { DISK_CHECK_MS, diskLow, watchDisk } from './disk-watch';

const GB = 1024 ** 3;

/** statfs numbers for a disk of `totalGb` with `freeGb` available, in 4 KB blocks. */
function disk(totalGb: number, freeGb: number) {
  const bsize = 4096;
  return { bsize, blocks: (totalGb * GB) / bsize, bavail: (freeGb * GB) / bsize };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('diskLow', () => {
  it('is low below 15% free', () => {
    expect(diskLow(disk(160, 23))).toBe(true);
    expect(diskLow(disk(160, 25))).toBe(false);
  });

  it('is low below 5 GB free, even on a small disk above 15%', () => {
    expect(diskLow(disk(20, 4))).toBe(true);
    expect(diskLow(disk(20, 6))).toBe(false);
  });
});

describe('watchDisk', () => {
  it('checks every 10 minutes and alerts with the free space when low', async () => {
    vi.useFakeTimers();
    let stats = disk(160, 80);
    const alert = vi.fn();
    const stop = watchDisk({ path: '/var/lib/cord', statfs: () => Promise.resolve(stats), alert });
    expect(DISK_CHECK_MS).toBe(10 * 60_000);
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(alert).not.toHaveBeenCalled();
    stats = disk(160, 4);
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(alert).toHaveBeenCalledWith({ freeBytes: 4 * GB, totalBytes: 160 * GB });
    stop();
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS * 3);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('a failing statfs never throws out of the timer', async () => {
    vi.useFakeTimers();
    const alert = vi.fn();
    const failed = vi.fn();
    const stop = watchDisk({
      path: '/missing',
      statfs: () => Promise.reject(new Error('ENOENT')),
      alert,
      onError: failed,
    });
    await vi.advanceTimersByTimeAsync(DISK_CHECK_MS);
    expect(alert).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
    stop();
  });
});
