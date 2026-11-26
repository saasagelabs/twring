import * as Sharing from 'expo-sharing';

import { displayFileName } from '../e2e/sealed-files';
import { removeShareCopies, SHARE_FOLDER } from './sealed-file-cache';

/** Extensions for the types a private chat shows, so the receiving app sees a real file name. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
};

/** The name a shared copy gets: cleaned, no path characters, with an extension from the type. */
export function shareName(name: string, mime: string): string {
  const safe = [...displayFileName(name)]
    .map((character) => (character === '/' || character === '\\' ? '_' : character))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  const base = safe || 'file';
  const extension = EXTENSIONS[mime];
  if (extension === undefined || /\.[A-Za-z0-9]{1,8}$/.test(base)) return base;
  return `${base}.${extension}`;
}

/**
 * Shares an opened file under its own name: the cache is keyed by file id, so a named copy is
 * made for the share sheet. The copy stays after the share (on Android the sheet can resolve
 * before a slow receiver has read it); earlier copies go first, and a clear or the next start
 * removes the rest.
 */
export async function shareSealedFile(
  uri: string,
  file: { name: string; mime: string },
): Promise<void> {
  await removeShareCopies();
  const { Directory, File, Paths } = await import('expo-file-system');
  const random = Math.random().toString(36).slice(2, 10);
  const folder = new Directory(
    new Directory(Paths.cache, SHARE_FOLDER),
    `${Date.now().toString(36)}-${random}`,
  );
  folder.create({ intermediates: true, idempotent: true });
  const copy = new File(folder, shareName(file.name, file.mime));
  await new File(uri).copy(copy);
  await Sharing.shareAsync(copy.uri, {
    mimeType: file.mime,
    dialogTitle: displayFileName(file.name),
  });
}
