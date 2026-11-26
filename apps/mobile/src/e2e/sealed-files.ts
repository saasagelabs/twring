import { MAX_FILE_NAME_CHARS, type SealedPayload } from '@twring/contracts';

export type SealedFileEntry = NonNullable<SealedPayload['files']>[number];

/** Photos the chat draws (the same types the app lets a person send). */
const PHOTO_MIMES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Documents the phone offers to share once opened. Anything else is shown by name only. */
const DOCUMENT_MIMES: ReadonlySet<string> = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export const isSealedPhoto = (mime: string): boolean => PHOTO_MIMES.has(mime);
export const isSealedDocument = (mime: string): boolean => DOCUMENT_MIMES.has(mime);

/**
 * A name from the computer, safe to draw: control characters (and bidi overrides) removed, cut to
 * MAX_FILE_NAME_CHARS without splitting a character. The text is the other side's, so it is data.
 */
function hidden(code: number): boolean {
  return (
    code < 32 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function displayFileName(name: string): string {
  const cleaned = [...name].filter((c) => !hidden(c.codePointAt(0) ?? 0)).join('');
  return [...cleaned].slice(0, MAX_FILE_NAME_CHARS).join('').trim();
}

/** How an export or a quote lists a file: `[Photo: name]` or `[File: name]`. */
export function fileMarker(file: Pick<SealedFileEntry, 'name' | 'mime'>): string {
  return `[${isSealedPhoto(file.mime) ? 'Photo' : 'File'}: ${displayFileName(file.name)}]`;
}
