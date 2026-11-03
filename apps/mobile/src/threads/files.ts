import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_FILE_BYTES, type Attachment } from '@twring/contracts';

export interface PreparedFile {
  clientId: string;
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  uploaded?: Attachment;
}

export const DOCUMENT_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;

export function typeLabel(type: string): string {
  return (
    (
      {
        'image/jpeg': 'JPEG image',
        'image/png': 'PNG image',
        'image/webp': 'WebP image',
        'application/pdf': 'PDF',
        'text/plain': 'Text file',
        'text/markdown': 'Markdown file',
        'text/csv': 'CSV file',
        'application/json': 'JSON file',
      } as Record<string, string>
    )[type] ?? 'File'
  );
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileCheck(
  file: { mimeType: string; sizeBytes: number },
  count: number,
): 'file_too_large' | 'unsupported_file_type' | 'too_many_files' | undefined {
  if (count >= MAX_ATTACHMENTS_PER_MESSAGE) return 'too_many_files';
  if (file.sizeBytes < 1) return 'unsupported_file_type';
  if (file.sizeBytes > MAX_FILE_BYTES) return 'file_too_large';
  if (
    !DOCUMENT_TYPES.includes(file.mimeType as (typeof DOCUMENT_TYPES)[number]) &&
    file.mimeType !== 'image/jpeg'
  )
    return 'unsupported_file_type';
  return undefined;
}

export function filesPreview(files: readonly Attachment[]): string {
  if (files.length === 1)
    return files[0].mime_type.startsWith('image/') ? 'Photo' : `File: ${files[0].name}`;
  return files.every((file) => file.mime_type.startsWith('image/'))
    ? `${files.length} photos`
    : `${files.length} files`;
}
