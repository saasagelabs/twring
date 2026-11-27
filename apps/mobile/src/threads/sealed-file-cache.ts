import {
  base64urlDecode,
  fileAad,
  MAX_FILE_BYTES,
  openFile,
  SEALED_FILE_OVERHEAD,
  type SealedPayload,
} from '@twring/contracts';

/**
 * Opened copies of private chats' files (ADR-045), under the app's cache folder: one file per
 * server file id, plaintext, so a photo is decrypted once and the OS can clear it any time.
 * The sender's own copy goes in by id; a file from the other side is downloaded as an opaque
 * blob, opened with the key inside the sealed message and kept here.
 */
const CACHE_FOLDER = 'sealed-files';
/** Named copies made for the share sheet, each in its own folder under this one. */
export const SHARE_FOLDER = 'sealed-share';

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

/** Bumped by a clear: a download that began before it must not write anything after it. */
let generation = 0;
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
  const work: Promise<{ uri: string } | { error: 'couldnt_open' }> = openOnce(
    agentId,
    file,
    ids,
    deps,
  )
    .catch((): { error: 'couldnt_open' } => ({ error: 'couldnt_open' }))
    .finally(() => {
      if (inFlight.get(file.file_id) === work) inFlight.delete(file.file_id);
    });
  inFlight.set(file.file_id, work);
  return work;
}

const FILE_ID = /^fil_[a-z2-7]{20}$/;

async function openOnce(
  agentId: string,
  file: SealedFileRef,
  ids: { accountId: string; agentId: string },
  given: SealedFileDeps | undefined,
): Promise<{ uri: string } | { error: 'couldnt_open' }> {
  // A name from the server never reaches a path unless it is exactly a file id.
  if (!FILE_ID.test(file.file_id)) return { error: 'couldnt_open' };
  // No file over the cap is ever sealed, so none is downloaded (R4-4).
  if (!Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES)
    return { error: 'couldnt_open' };
  await sweepShareCopiesOnce();
  const started = generation;
  const { Directory, File, Paths } = await import('expo-file-system');
  const folder = new Directory(Paths.cache, CACHE_FOLDER);
  const name = cacheName(file.file_id);
  const target = new File(folder, name);
  if (target.exists) {
    // A copy cut short by a crash or a full disk is not trusted: open it again.
    if (target.size === file.size) return { uri: target.uri };
    target.delete();
  }
  // Outside the folder, so a clear that runs meanwhile has nothing to recreate.
  const tempName = `sealed-${name}.download`;
  const partName = `${name}.part`;
  const temp = new File(Paths.cache, tempName);
  const part = new File(folder, partName);
  try {
    const deps = given ?? (await defaultDeps());
    const source = await deps.source(agentId, file.file_id);
    await File.downloadFileAsync(source.uri, temp, {
      ...(source.headers && { headers: source.headers }),
      idempotent: true,
    });
    // A blob of any other size cannot open, so it is never read into memory (R4-4).
    if (temp.size !== file.size + SEALED_FILE_OVERHEAD) return { error: 'couldnt_open' };
    const blob = new Uint8Array(await temp.arrayBuffer());
    const plain = openFile(base64urlDecode(file.key), blob, fileAad(ids));
    if (plain.length !== file.size || started !== generation) return { error: 'couldnt_open' };
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    part.write(plain);
    // Moved into place whole: the name only ever holds a complete file.
    await part.move(target);
    return { uri: target.uri };
  } finally {
    // Named again, not `temp` and `part`: a moved File points at its new place, so after the
    // move `part` is the cached copy itself and deleting it would empty the cache.
    for (const leftover of [new File(Paths.cache, tempName), new File(folder, partName)]) {
      try {
        if (leftover.exists) leftover.delete();
      } catch {
        /* already gone */
      }
    }
  }
}

let sweptThisProcess = false;

/**
 * Deletes every share copy. A copy outlives its share (a slow receiver may still be reading it),
 * so the next share, a clear and the first open or share of a process remove them.
 */
export async function removeShareCopies(): Promise<void> {
  sweptThisProcess = true;
  try {
    const { Directory, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.cache, SHARE_FOLDER);
    if (folder.exists) folder.delete();
  } catch {
    /* the OS clears the cache anyway */
  }
}

/** Chat exports (opened plaintext) written for the share sheet; a killed sheet leaves one. */
export const CHAT_EXPORT_FOLDER = 'chat-export';

async function removeChatExports(): Promise<void> {
  try {
    const { Directory, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.cache, CHAT_EXPORT_FOLDER);
    if (folder.exists) folder.delete();
  } catch {
    /* the OS clears the cache anyway */
  }
}

/** Start-up cleanup: the app start, or else the first open or share of the process. */
export async function sweepShareCopiesOnce(): Promise<void> {
  if (sweptThisProcess) return;
  await removeShareCopies();
  await removeChatExports();
}

/** Sign-out, removing this phone and clearing a chat: no opened file stays behind. */
export async function clearSealedFiles(): Promise<void> {
  generation += 1;
  inFlight.clear();
  await removeShareCopies();
  await removeChatExports();
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
