import { readFile, stat } from 'node:fs/promises';

import { z } from 'zod';

export const membersSchema = z.strictObject({
  emails: z.array(z.string().trim().toLowerCase().pipe(z.email())),
});

const CHECK_INTERVAL_MS = 5_000;

/** Reads a small owner-managed membership file, caching it until a later mtime check. */
export function createBetaMembers(
  path: string,
  options: { now?: () => number; onUnavailable?: () => void } = {},
): { has(email: string | undefined): Promise<boolean> } {
  const now = options.now ?? Date.now;
  let nextCheck = -Infinity;
  let lastVersion: string | undefined;
  let emails: ReadonlySet<string> | undefined;
  let pending: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    nextCheck = now() + CHECK_INTERVAL_MS;
    let version = 'missing';
    try {
      const metadata = await stat(path);
      version = `${metadata.mtimeMs}:${metadata.size}`;
      if (version === lastVersion) return;
      const parsed = membersSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      emails = new Set(parsed.emails);
    } catch {
      emails = undefined;
      if (version !== lastVersion) options.onUnavailable?.();
    }
    lastVersion = version;
  }

  return {
    async has(email) {
      if (now() >= nextCheck) {
        pending ??= refresh().finally(() => {
          pending = undefined;
        });
      }
      if (pending !== undefined) await pending;
      return email !== undefined && (emails?.has(email.trim().toLowerCase()) ?? false);
    },
  };
}
