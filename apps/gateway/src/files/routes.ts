import {
  fileIdSchema,
  fileUploadQuerySchema,
  fileUploadResponseSchema,
  MAX_FILE_BYTES,
  type Attachment,
  type ErrorCode,
  type ErrorResponse,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import type { AgentRepository } from '../store/repositories';
import { FileStoreError } from '../threads/store';
import { sniffFile } from './sniff';
import type { FileService } from './service';

export interface FileRoutesOptions {
  service: FileService;
  agents: Pick<AgentRepository, 'get'>;
  userFor?: UserResolver;
  readRatePerMinute: number;
  uploadRatePerMinute?: number;
}

function error(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

/** RFC 5987 value: encodeURIComponent leaves ' ( ) * as they are, which the header does not allow. */
const rfc5987 = (name: string) =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function sendBytes(reply: FastifyReply, bytes: Buffer, file: Attachment): FastifyReply {
  const fallback = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const type =
    file.mime_type.startsWith('text/') || file.mime_type === 'application/json'
      ? `${file.mime_type}; charset=utf-8`
      : file.mime_type;
  return reply
    .headers({
      'content-type': type,
      'content-length': bytes.length,
      'content-disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(file.name)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=300',
    })
    .send(bytes);
}

export function registerFileRoutes(app: FastifyInstance, options: FileRoutesOptions): void {
  const userFor = options.userFor ?? devUserResolver;
  const uploads = new FixedWindowLimiter(options.uploadRatePerMinute ?? 30, 60_000);
  const reads = new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  app.register((filesApp, _opts, done) => {
    // Fastify's built-in text/plain and application/json parsers would otherwise turn a text or
    // JSON file into a string or object; every body must arrive as bytes.
    filesApp.removeAllContentTypeParsers();
    filesApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, next) =>
      next(null, body),
    );
    filesApp.addHook('onRequest', (request, _reply, next) => {
      if (request.headers['content-type']?.trim() === '')
        request.headers['content-type'] = 'application/octet-stream';
      next();
    });
    filesApp.post<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
      '/v1/agents/:agentId/files',
      { bodyLimit: MAX_FILE_BYTES + 1024 },
      async (request, reply) => {
        const userId = userFor(request);
        if (!(await options.agents.get(userId, request.params.agentId)))
          return error(reply, 404, 'not_found', 'No such agent.');
        const query = fileUploadQuerySchema.safeParse(request.query);
        if (!query.success) return error(reply, 400, 'bad_request', 'Invalid file request.');
        if (!uploads.tryAcquire(userId))
          return error(reply, 429, 'rate_limited', 'Too many uploads. Try again later.');
        if (!Buffer.isBuffer(request.body) || request.body.length === 0)
          return error(reply, 400, 'bad_request', 'File is empty.');
        if (request.body.length > MAX_FILE_BYTES)
          return error(reply, 413, 'file_too_large', 'The file is too large.');
        const type = sniffFile(request.body, request.headers['content-type'], query.data.name);
        if (!type)
          return error(reply, 415, 'unsupported_file_type', 'This file type is not supported.');
        try {
          const result = await options.service.upload({
            userId,
            agentId: request.params.agentId,
            clientId: query.data.client_id,
            name: query.data.name,
            mimeType: type.mimeType,
            bytes: request.body,
            ...('width' in type && { width: type.width }),
            ...('height' in type && { height: type.height }),
          });
          return reply.code(result.created ? 201 : 200).send(
            fileUploadResponseSchema.parse({
              file: options.service.store.attachment(result.file),
            }),
          );
        } catch (cause) {
          if (cause instanceof FileStoreError)
            return cause.code === 'storage_full'
              ? error(reply, 507, 'storage_full', 'Storage is full.')
              : cause.code === 'bad_attachment'
                ? error(reply, 400, 'bad_request', 'Invalid file request.')
                : error(reply, 429, 'files_daily_limit', 'Daily file limit reached.');
          throw cause;
        }
      },
    );
    done();
  });

  app.get<{ Params: { agentId: string; fileId: string } }>(
    '/v1/agents/:agentId/files/:fileId',
    async (request, reply) => {
      const userId = userFor(request);
      if (
        !fileIdSchema.safeParse(request.params.fileId).success ||
        !(await options.agents.get(userId, request.params.agentId))
      )
        return error(reply, 404, 'not_found', 'File not found.');
      if (!reads.tryAcquire(userId))
        return error(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
      const file = options.service.store.findFile(userId, request.params.fileId);
      if (!file || file.agentId !== request.params.agentId)
        return error(reply, 404, 'not_found', 'File not found.');
      try {
        return sendBytes(reply, await options.service.bytes(file), file);
      } catch {
        return error(reply, 404, 'not_found', 'File not found.');
      }
    },
  );

  app.get<{ Params: { fileId: string }; Querystring: Record<string, unknown> }>(
    '/v1/files/:fileId',
    async (request, reply) => {
      const { fileId } = request.params;
      const exp = request.query.exp;
      const sig = request.query.sig;
      if (
        !fileIdSchema.safeParse(fileId).success ||
        typeof exp !== 'string' ||
        typeof sig !== 'string' ||
        !options.service.verifyLink(fileId, exp, sig)
      )
        return error(reply, 404, 'not_found', 'File not found.');
      const owner = options.service.store.fileOwner(fileId);
      if (!owner?.attached) return error(reply, 404, 'not_found', 'File not found.');
      if (!reads.tryAcquire(owner.userId))
        return error(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
      const file = options.service.store.findFile(owner.userId, fileId);
      if (!file) return error(reply, 404, 'not_found', 'File not found.');
      try {
        return sendBytes(reply, await options.service.bytes(file), file);
      } catch {
        return error(reply, 404, 'not_found', 'File not found.');
      }
    },
  );
}
