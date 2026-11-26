import {
  fileUploadQuerySchema,
  MAX_FILE_BYTES,
  SEALED_FILE_OVERHEAD,
  type ErrorCode,
} from '@twring/contracts';
import type { FastifyReply } from 'fastify';

import type { FileRow } from '../threads/store';

/** Refusal for a sealed blob of the wrong size, or undefined when it is in range (ADR-045). */
export function sealedSizeRefusal(
  body: unknown,
): { status: number; code: ErrorCode; message: string } | undefined {
  if (!Buffer.isBuffer(body) || body.length <= SEALED_FILE_OVERHEAD)
    return { status: 400, code: 'bad_request', message: 'File is empty.' };
  if (body.length > MAX_FILE_BYTES + SEALED_FILE_OVERHEAD)
    return { status: 413, code: 'file_too_large', message: 'The file is too large.' };
  return undefined;
}

/**
 * Splits the `sealed` flag off an upload query. A sealed upload needs only `client_id`: its name
 * and content type are ignored, so the server never learns them. Undefined: the query is invalid.
 */
export function parseUploadQuery(
  raw: Record<string, unknown>,
): { sealed: boolean; client_id: string; name: string } | undefined {
  const { sealed: flag, ...rest } = raw;
  if (flag !== undefined && flag !== '1') return undefined;
  if (flag === '1') {
    const clientId = fileUploadQuerySchema.shape.client_id.safeParse(rest.client_id);
    return clientId.success
      ? { sealed: true, client_id: clientId.data, name: 'sealed.bin' }
      : undefined;
  }
  const plain = fileUploadQuerySchema.safeParse(rest);
  return plain.success ? { sealed: false, ...plain.data } : undefined;
}

/** What a sealed upload answers: the id and size only, never a name or type (ADR-045). */
export const sealedUploadBody = (file: FileRow) => ({
  file: { id: file.id, size_bytes: file.size_bytes },
});

/** A sealed blob goes out as opaque bytes: it is not a document any client may open as one. */
export function sendSealedBytes(reply: FastifyReply, bytes: Buffer): FastifyReply {
  return reply
    .headers({
      'content-type': 'application/octet-stream',
      'content-length': bytes.length,
      'content-disposition': 'attachment; filename="sealed.bin"',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    })
    .send(bytes);
}
