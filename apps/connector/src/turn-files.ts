import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  type FileMimeType,
  type TurnAttachment,
} from '@twring/contracts';

export type LocalFile = { path: string; name: string; mimeType: FileMimeType; sizeBytes: number };

export async function downloadTurnFiles(
  attachments: readonly TurnAttachment[],
  options: { server: string | URL; turnId: string; signal: AbortSignal; fetch?: typeof fetch },
): Promise<{ files: LocalFile[]; cleanup(): Promise<void> }> {
  const files: LocalFile[] = [];
  const used = new Set<string>();
  const directory = await mkdtemp(join(tmpdir(), 'twring-'));
  await chmod(directory, 0o700);
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
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
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n++) {
        const prefix = `${n}-`;
        name =
          prefix +
          Array.from(base)
            .slice(0, MAX_FILE_NAME_CHARS - prefix.length)
            .join('');
      }
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

function cleanName(value: string): string {
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

export function withFilePaths(text: string, files: readonly LocalFile[]): string {
  return files.length === 0
    ? text
    : `${text}\n${files.map((file) => `Saved on this computer: ${file.path}`).join('\n')}`;
}
