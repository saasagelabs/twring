import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  base64urlDecode,
  fileAad,
  fileIdSchema,
  fileMimeTypeSchema,
  MAX_FILE_BYTES,
  MAX_FILE_NAME_CHARS,
  openFile,
  SEALED_FILE_OVERHEAD,
  type FileMimeType,
  type SealedPayload,
} from '@twring/contracts';

import { apiUrl, checkServerUrl } from './config';
import { attachedLine, cleanName, type LocalFile } from './turn-files';

/** One file row of a sealed message, as the phone sealed it. */
export type SealedFileRef = NonNullable<SealedPayload['files']>[number];

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** The extension a file gets on disk, from its allowed type (never from the sender's name). */
const EXTENSIONS: Record<FileMimeType, readonly string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'text/markdown': ['.md'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
};

export interface DownloadSealedFileOptions {
  server: string | URL;
  token: string;
  fileId: string;
  localAgent: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Reads one sealed blob from the gateway with this computer's token. Stops reading the moment the
 * blob passes the most a sealed file can be, so a hostile or broken server cannot fill memory.
 * Errors carry no file id, name or server text.
 */
export async function downloadSealedFile(options: DownloadSealedFileOptions): Promise<Uint8Array> {
  // The id goes into the URL path: only a real file id is requested.
  if (!fileIdSchema.safeParse(options.fileId).success) throw new Error('bad_file_id');
  const cap = MAX_FILE_BYTES + SEALED_FILE_OVERHEAD;
  const server = checkServerUrl(options.server.toString());
  const url = new URL(apiUrl(server, `/v1/connectors/files/${encodeURIComponent(options.fileId)}`));
  url.searchParams.set('local_agent', options.localAgent);
  const response = await (options.fetch ?? fetch)(url.toString(), {
    headers: { authorization: `Bearer ${options.token}` },
    redirect: 'error',
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  try {
    if (response.status !== 200 || response.body === null) throw new Error('not_available');
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > cap) throw new Error('too_large');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        const chunk = item.value as Uint8Array;
        size += chunk.byteLength;
        if (size > cap) throw new Error('too_large');
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new Uint8Array(Buffer.concat(chunks, size));
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export interface OpenSealedFilesContext {
  /** The AAD's account binding: this computer's connector id. */
  accountId: string;
  agentId: string;
  server: string | URL;
  token: string;
  signal: AbortSignal;
}

export interface OpenedSealedFiles {
  files: LocalFile[];
  /** The safe names of the files that could not be opened, in message order. */
  failed: string[];
  /** One `[Attached: ...]` line per file, in message order (opened ones with type and size). */
  lines: string[];
  cleanup: () => Promise<void>;
}

/** A name that is safe on disk and in a prompt, ending in an extension its type allows. */
function safeName(name: string, mime: FileMimeType): string {
  const extensions = EXTENSIONS[mime];
  const clean = cleanName(name);
  const own = extensions.find((ext) => clean.toLowerCase().endsWith(ext));
  const ext = own ?? extensions[0]!;
  const stem =
    own === undefined ? clean.replace(/\.[A-Za-z0-9]{1,5}$/u, '') : clean.slice(0, -ext.length);
  const room = Math.max(1, MAX_FILE_NAME_CHARS - ext.length);
  const kept = Array.from(stem === '' ? 'file' : stem)
    .slice(0, room)
    .join('');
  return `${kept}${own === undefined ? ext : clean.slice(-ext.length)}`;
}

/**
 * Downloads, opens and writes the files of one private message into a private temp folder (0700,
 * files 0600). A file that cannot be opened for any reason (a refused row, a download that failed,
 * a blob that was swapped, cut or flipped, a length that is not the size the phone sealed) is
 * listed in `failed` and never shown as other bytes; the rest still pass. `cleanup` removes the
 * folder and is safe to call twice.
 */
export async function openSealedFiles(
  refs: readonly SealedFileRef[],
  ctx: OpenSealedFilesContext,
  deps: { fetch?: typeof fetch } = {},
): Promise<OpenedSealedFiles> {
  const files: LocalFile[] = [];
  const failed: string[] = [];
  const lines: string[] = [];
  const used = new Set<string>();
  const directory = await mkdtemp(join(tmpdir(), 'twring-'));
  await chmod(directory, 0o700);
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };
  const aad = fileAad({ accountId: ctx.accountId, agentId: ctx.agentId });
  for (const ref of refs) {
    const mime = fileMimeTypeSchema.safeParse(ref.mime);
    const shown = cleanName(ref.name);
    const fail = (name = shown) => {
      failed.push(name);
      lines.push(attachedLine(name));
    };
    // Files are never empty; an unknown type is not something the phone may send.
    if (!mime.success || ref.size < 1 || ref.size > MAX_FILE_BYTES) {
      fail();
      continue;
    }
    const base = safeName(ref.name, mime.data);
    try {
      if (ctx.signal.aborted) throw new Error('stopped');
      const key = base64urlDecode(ref.key);
      const blob = await downloadSealedFile({
        server: ctx.server,
        token: ctx.token,
        fileId: ref.file_id,
        localAgent: ctx.agentId,
        signal: ctx.signal,
        ...(deps.fetch !== undefined && { fetch: deps.fetch }),
      });
      const bytes = openFile(key, blob, aad);
      if (bytes.length !== ref.size) throw new Error('size_mismatch');
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
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(path, 0o600);
      used.add(name.toLowerCase());
      files.push({ path, name, mimeType: mime.data, sizeBytes: bytes.length });
      lines.push(attachedLine(name, { mimeType: mime.data, sizeBytes: bytes.length }));
    } catch {
      fail(base);
    }
  }
  return { files, failed, lines, cleanup };
}
