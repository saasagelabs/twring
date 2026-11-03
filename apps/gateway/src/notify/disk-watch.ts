/** How often free space on the data disk is checked. */
export const DISK_CHECK_MS = 10 * 60_000;

/** Below this share of the disk free, the owner hears about it. */
const LOW_SHARE = 0.15;
/** Below this many bytes free, the owner hears about it, whatever the disk size. */
const LOW_BYTES = 5 * 1024 ** 3;

/** The `fs.statfs` numbers the check needs. */
export interface DiskStats {
  bsize: number;
  blocks: number;
  bavail: number;
}

/** True when free space is below 15% of the disk or below 5 GB. */
export function diskLow(stats: DiskStats): boolean {
  const free = stats.bavail * stats.bsize;
  const total = stats.blocks * stats.bsize;
  return free < LOW_BYTES || free < total * LOW_SHARE;
}

/**
 * Tells the owner when the data disk runs low (wave 1: uploads and backups share one disk, and a
 * full disk stops every write). The alert itself is deduplicated per day by the owner alert.
 * Returns a stop function.
 */
export function watchDisk(options: {
  path: string;
  statfs: (path: string) => Promise<DiskStats>;
  alert: (space: { freeBytes: number; totalBytes: number }) => void;
  onError?: (error: unknown) => void;
}): () => void {
  const check = async () => {
    try {
      const stats = await options.statfs(options.path);
      if (diskLow(stats)) {
        options.alert({
          freeBytes: stats.bavail * stats.bsize,
          totalBytes: stats.blocks * stats.bsize,
        });
      }
    } catch (error) {
      options.onError?.(error);
    }
  };
  const timer = setInterval(() => void check(), DISK_CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
