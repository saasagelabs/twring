import { base64urlDecode, fileAad, openFile, type SealedPayload } from '@twring/contracts';

/**
 * Opened copies of private chats' files (ADR-045), under the app's cache folder: one file per
 * server file id, plaintext, so a photo is decrypted once and the OS can clear it any time.
 * The sender's own copy goes in by id; a file from the other side is downloaded as an opaque
 * blob, opened with the key inside the sealed message and kept here.
 */
const CACHE_FOLDER = 'sealed-files';

/** The phone's reading and copying of local files, replaceable in tests. */
export interface SealedFiles {
  /** The file's bytes (a pick, a resized photo or a kept copy). */
  read(uri: string): Promise<Uint8Array>;
  /** Keeps a copy of a file this phone just sent under its server id, so it never downloads it. */
  cacheOwn(fileId: string, localUri: string): Promise<void>;
}

/** Server ids are already safe, but a name never leaves the folder whatever the id holds. */
function cacheName(fileId: string): string {
  return fileId.replace(/[^A-Za-z0-9_-]/g, '_');
}

export async function readLocalBytes(uri: string): Promise<Uint8Array> {
  const { File } = await import('expo-file-system');
  return new Uint8Array(await new File(uri).arrayBuffer());
}

/** Copies a sent file into the cache under its server id. Nothing here is a reason to fail a send. */
export async function cacheOwnFile(fileId: string, localUri: string): Promise<void> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const folder = new Directory(Paths.cache, CACHE_FOLDER);
  if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
  await new File(localUri).copy(new File(folder, cacheName(fileId)), { overwrite: true });
}

export type SealedFileRef = NonNullable<SealedPayload['files']>[number];

/** Where a blob is read from: the signed-in app's file route (`TwringApi.fileSource`). */
export interface SealedFileDeps {
  source(
    agentId: string,
    fileId: string,
  ): Promise<{ uri: string; headers?: Record<string, string> }>;
}

async function defaultDeps(): Promise<SealedFileDeps> {
  const { twringApi } = await import('@/api');
  return {
    source: (agentId, fileId) => {
      const api = twringApi();
      if (!api?.fileSource) return Promise.reject(new Error('File source unavailable'));
      return api.fileSource(agentId, fileId);
    },
  };
}

const inFlight = new Map<string, Promise<{ uri: string } | { error: 'couldnt_open' }>>();

/**
 * The opened copy of a private chat's file: from the cache, else downloaded, opened, size-checked
 * and cached. A swapped, cut or damaged blob, a wrong size or a failed download is `couldnt_open`
 * (never other bytes, never a throw). Bubbles of one file share one download.
 */
export function openSealedFile(
  agentId: string,
  file: SealedFileRef,
  ids: { accountId: string; agentId: string },
  deps?: SealedFileDeps,
): Promise<{ uri: string } | { error: 'couldnt_open' }> {
  const found = inFlight.get(file.file_id);
  if (found) return found;
  const work = openOnce(agentId, file, ids, deps)
    .catch((): { error: 'couldnt_open' } => ({ error: 'couldnt_open' }))
    .finally(() => inFlight.delete(file.file_id));
  inFlight.set(file.file_id, work);
  return work;
}

async function openOnce(
  agentId: string,
  file: SealedFileRef,
  ids: { accountId: string; agentId: string },
  given: SealedFileDeps | undefined,
): Promise<{ uri: string } | { error: 'couldnt_open' }> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const folder = new Directory(Paths.cache, CACHE_FOLDER);
  const target = new File(folder, cacheName(file.file_id));
  if (target.exists) return { uri: target.uri };
  const temp = new File(folder, `${cacheName(file.file_id)}.download`);
  try {
    const deps = given ?? (await defaultDeps());
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    const source = await deps.source(agentId, file.file_id);
    await File.downloadFileAsync(source.uri, temp, {
      ...(source.headers && { headers: source.headers }),
      idempotent: true,
    });
    const blob = new Uint8Array(await temp.arrayBuffer());
    const plain = openFile(base64urlDecode(file.key), blob, fileAad(ids));
    if (plain.length !== file.size) return { error: 'couldnt_open' };
    target.write(plain);
    return { uri: target.uri };
  } finally {
    try {
      if (temp.exists) temp.delete();
    } catch {
      /* already gone */
    }
  }
}

/** Sign-out, removing this phone and clearing a chat: no opened file stays behind. */
export async function clearSealedFiles(): Promise<void> {
  try {
    const { Directory, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.cache, CACHE_FOLDER);
    if (folder.exists) folder.delete();
  } catch {
    /* the OS clears the cache anyway */
  }
}

export const deviceSealedFiles: SealedFiles = {
  read: readLocalBytes,
  cacheOwn: cacheOwnFile,
};
