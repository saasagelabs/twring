import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  MAX_FILE_BYTES,
  errorResponseSchema,
  fileMimeTypeSchema,
  fileUploadResponseSchema,
  type FileMimeType,
} from '@twring/contracts';

import { apiUrl, checkServerUrl } from './config';

const TYPES: Record<string, FileMimeType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
};

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface UploadFileOptions {
  server: string | URL;
  token: string;
  localAgent: string;
  /** The person's session on a shared server agent, so the file reaches them, not the owner. */
  sessionScope?: string | undefined;
  path?: string;
  bytes?: Uint8Array;
  name: string;
  mimeType?: string;
  clientId: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const ERROR_MESSAGES: Record<string, string> = {
  file_too_large: 'The file is too large (maximum 10 MB).',
  unsupported_file_type: 'Twring can send photos, PDFs and text files.',
  storage_full: "Storage is full: the owner's file space is used up.",
  files_daily_limit: "The owner's daily file limit has been reached (100 files).",
  rate_limited: 'Too many requests. Try again later.',
};

/** Uploads one file with an idempotent client id. Never includes a name or path in errors. */
export async function uploadFile(options: UploadFileOptions): Promise<string> {
  if ((options.path === undefined) === (options.bytes === undefined))
    throw new UploadError('invalid_file', 'Choose one file to send.');
  const mimeType = options.mimeType ?? TYPES[extname(options.name).toLowerCase()];
  const parsedType = fileMimeTypeSchema.safeParse(mimeType);
  if (!parsedType.success)
    throw new UploadError('unsupported_file_type', ERROR_MESSAGES.unsupported_file_type!);

  let bytes: Uint8Array;
  try {
    if (options.path !== undefined) {
      if ((await stat(options.path)).size > MAX_FILE_BYTES)
        throw new UploadError('file_too_large', ERROR_MESSAGES.file_too_large!);
      bytes = await readFile(options.path);
    } else {
      bytes = options.bytes!;
    }
  } catch (error) {
    if (error instanceof UploadError) throw error;
    throw new UploadError('file_unreadable', 'Could not read the file.');
  }
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new UploadError('file_too_large', ERROR_MESSAGES.file_too_large!);
  if (bytes.byteLength === 0) throw new UploadError('empty_file', 'The file is empty.');

  const server = checkServerUrl(options.server.toString());
  const url = new URL(apiUrl(server, '/v1/connectors/files'));
  url.searchParams.set('local_agent', options.localAgent);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('name', options.name);
  if (options.sessionScope !== undefined)
    url.searchParams.set('session_scope', options.sessionScope);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url.toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': parsedType.data },
      body: Buffer.from(bytes),
      redirect: 'error',
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(60_000)
          : AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
    });
  } catch {
    throw new UploadError(
      options.signal?.aborted ? 'cancelled' : 'upload_failed',
      options.signal?.aborted ? 'File sending cancelled.' : 'Could not send the file.',
    );
  }
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(await response.json().catch(() => undefined));
    const code = parsed.success ? parsed.data.error.code : `http_${response.status}`;
    throw new UploadError(code, ERROR_MESSAGES[code] ?? 'Could not send the file.');
  }
  const body = fileUploadResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!body.success)
    throw new UploadError('invalid_response', 'The server returned an invalid file response.');
  return body.data.file.id;
}
