import { rmSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  type FileMimeType,
  type TurnAttachment,
} from '@twring/contracts';

export type LocalFile = { path: string; name: string; mimeType: FileMimeType; sizeBytes: number };

/**
 * The one folder that holds every turn's files on this computer (0700): each turn gets a child
 * named `<pid>-...`, so a copy that was killed mid-turn leaves nothing a later start cannot find.
 */
export function turnFoldersRoot(): string {
  return join(tmpdir(), `twring-turns-${process.getuid?.() ?? 'user'}`);
}

/** Turn folders of this process not removed yet; an exit handler removes them synchronously. */
const liveFolders = new Set<string>();
let exitHooked = false;

function removeLiveFolders(): void {
  for (const directory of liveFolders) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort: the next start removes what is left.
    }
  }
  liveFolders.clear();
}

/**
 * Makes a private folder (0700) for one turn's files under `turnFoldersRoot()`. When that root is
 * not a plain folder this user owns (another user made it first on a shared temp), the folder is
 * made straight in the temp folder instead, as before. `cleanup` is safe to call twice.
 */
export async function makeTurnFolder(): Promise<{
  directory: string;
  cleanup: () => Promise<void>;
}> {
  const root = turnFoldersRoot();
  let parent = tmpdir();
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root);
    const uid = process.getuid?.();
    if (info.isDirectory() && !info.isSymbolicLink() && (uid === undefined || info.uid === uid)) {
      await chmod(root, 0o700);
      parent = root;
    }
  } catch {
    // The temp folder itself still works.
  }
  const directory = await mkdtemp(join(parent, parent === root ? `${process.pid}-` : 'twring-'));
  await chmod(directory, 0o700);
  liveFolders.add(directory);
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', removeLiveFolders);
  }
  const cleanup = async () => {
    liveFolders.delete(directory);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
  return { directory, cleanup };
}

function running(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes the turn folders a copy that is no longer running left behind (killed mid-turn, power
 * lost). Run when the connector starts. Folders of a copy still running are kept. Resolves how
 * many were removed; never throws.
 */
export async function sweepTurnFolders(): Promise<number> {
  const root = turnFoldersRoot();
  const children = await readdir(root).catch(() => [] as string[]);
  let removed = 0;
  for (const child of children) {
    const pid = Number(/^(\d+)-/u.exec(child)?.[1]);
    if (Number.isInteger(pid) && pid > 0 && running(pid)) continue;
    await rm(join(root, child), { recursive: true, force: true }).then(
      () => removed++,
      () => undefined,
    );
  }
  return removed;
}

/**
 * A name not in `used` (lower case): `2-report.pdf`, `3-report.pdf`, ... The counter goes before
 * the stem and the stem is cut, so the extension stays and the name never ends in a dot or space
 * (Windows drops those, so the path would not be the name on disk).
 */
export function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  const ext = /\.[A-Za-z0-9]{1,5}$/u.exec(base)?.[0] ?? '';
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 2; ; n++) {
    const prefix = `${n}-`;
    const room = Math.max(1, MAX_FILE_NAME_CHARS - prefix.length - ext.length);
    const kept = Array.from(stem)
      .slice(0, room)
      .join('')
      .replace(/[. ]+$/u, '');
    const name = `${prefix}${kept === '' ? 'file' : kept}${ext}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export async function downloadTurnFiles(
  attachments: readonly TurnAttachment[],
  options: { server: string | URL; turnId: string; signal: AbortSignal; fetch?: typeof fetch },
): Promise<{ files: LocalFile[]; cleanup(): Promise<void> }> {
  const files: LocalFile[] = [];
  const used = new Set<string>();
  const { directory, cleanup } = await makeTurnFolder();
  let origin: string;
  try {
    origin = new URL(options.server).origin;
  } catch {
    return { files, cleanup };
  }
  for (const attachment of attachments) {
    if (options.signal.aborted) break;
    let url: URL;
    try {
      url = new URL(attachment.url);
    } catch {
      continue;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      continue;
    const timeout = AbortSignal.timeout(60_000);
    const signal = AbortSignal.any([options.signal, timeout]);
    let response: Response | undefined;
    try {
      response = await (options.fetch ?? fetch)(url, { signal, redirect: 'error' });
      if (
        response.status !== 200 ||
        response.body === null ||
        attachment.size_bytes > MAX_FILE_BYTES
      )
        continue;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          const chunk: Uint8Array = item.value as Uint8Array;
          size += chunk.byteLength;
          if (size > MAX_FILE_BYTES || size > attachment.size_bytes) break;
          chunks.push(chunk);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (signal.aborted || size !== attachment.size_bytes) continue;
      const base = cleanName(attachment.name);
      const name = uniqueName(base, used);
      const path = join(directory, name);
      await writeFile(path, Buffer.concat(chunks, size), { flag: 'wx', mode: 0o600 });
      await chmod(path, 0o600);
      used.add(name.toLowerCase());
      files.push({ path, name, mimeType: attachment.mime_type, sizeBytes: size });
    } catch {
      if (options.signal.aborted) break;
    } finally {
      await response?.body?.cancel().catch(() => undefined);
    }
  }
  return { files, cleanup };
}

/** Windows refuses these names whatever the extension (CON.txt included). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function cleanName(value: string): string {
  // Path separators, control characters, and the characters Windows refuses in a file name.
  // eslint-disable-next-line no-control-regex -- attachment names may contain control characters
  const replaced = value.replace(/[\\/<>:"|?*\x00-\x1f\x7f-\x9f]/gu, '_');
  const name = Array.from(replaced)
    .slice(0, MAX_FILE_NAME_CHARS)
    .join('')
    .trim()
    // Windows drops trailing dots and spaces, which would change the name on disk.
    .replace(/[. ]+$/u, '');
  if (name === '' || name === '.' || name === '..') return 'file';
  return WINDOWS_RESERVED.test(name) ? `_${name}` : name;
}

const FILE_LABELS: Record<FileMimeType, string> = {
  'image/jpeg': 'JPEG image',
  'image/png': 'PNG image',
  'image/webp': 'WebP image',
  'application/pdf': 'PDF',
  'text/plain': 'text',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'application/json': 'JSON',
};

const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * The line an agent reads for a file, the same words the gateway puts in an ordinary turn
 * (`threads/service.ts`). A file that could not be opened has no type or size to give.
 */
export function attachedLine(
  name: string,
  file?: { mimeType: FileMimeType; sizeBytes: number },
): string {
  return file === undefined
    ? `[Attached: ${name} (could not be opened)]`
    : `[Attached: ${name} (${FILE_LABELS[file.mimeType]}, ${fileSize(file.sizeBytes)})]`;
}

export function withFilePaths(text: string, files: readonly LocalFile[]): string {
  return files.length === 0
    ? text
    : `${text}\n${files.map((file) => `Saved on this computer: ${file.path}`).join('\n')}`;
}
