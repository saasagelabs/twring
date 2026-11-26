import * as Sharing from 'expo-sharing';

import { displayFileName } from '../e2e/sealed-files';

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
 * made for the share sheet and always removed afterwards (also on error or cancel).
 */
export async function shareSealedFile(
  uri: string,
  file: { name: string; mime: string },
): Promise<void> {
  const { Directory, File, Paths } = await import('expo-file-system');
  const folder = new Directory(Paths.cache, `sealed-share-${Date.now().toString(36)}`);
  try {
    folder.create({ intermediates: true, idempotent: true });
    const copy = new File(folder, shareName(file.name, file.mime));
    await new File(uri).copy(copy);
    await Sharing.shareAsync(copy.uri, {
      mimeType: file.mime,
      dialogTitle: displayFileName(file.name),
    });
  } finally {
    try {
      if (folder.exists) folder.delete();
    } catch {
      /* the cache is cleared by the OS anyway */
    }
  }
}
