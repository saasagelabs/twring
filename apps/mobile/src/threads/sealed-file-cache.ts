/**
 * Opened copies of private chats' files (ADR-045), under the app's cache folder: one file per
 * server file id, plaintext, so a photo is decrypted once and the OS can clear it any time.
 * This part holds what the sender needs (its own copy by id); opening other people's files is
 * added with the viewer.
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

export const deviceSealedFiles: SealedFiles = {
  read: readLocalBytes,
  cacheOwn: cacheOwnFile,
};
