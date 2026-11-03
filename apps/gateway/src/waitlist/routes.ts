import { WAITLIST_MAX_ENTRIES, waitlistRequestSchema, type ErrorCode } from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { FixedWindowLimiter } from '../rate-limit';
import type { Collection } from '../store/collection';
import type { NewSignup } from './notify';

export const waitlistRecordSchema = z.object({
  email: z.email(),
  created_at: z.iso.datetime(),
  source: z.enum(['landing', 'beta', 'app']),
  /** The owner was told about this request (one combined email, invite-flow.ts). */
  notified_at: z.iso.datetime().optional(),
  /** Their invite was emailed (or they were already in). */
  invited_at: z.iso.datetime().optional(),
  invite_attempts: z.number().int().min(0).optional(),
  /** Gave up emailing them after repeated failures. */
  invite_failed_at: z.iso.datetime().optional(),
  /** The owner was told about that failure. */
  invite_failure_reported_at: z.iso.datetime().optional(),
});
export type WaitlistRecord = z.infer<typeof waitlistRecordSchema>;

export interface WaitlistRoutesOptions {
  records: Collection<WaitlistRecord>;
  allowedOrigins: readonly string[];
  limiter?: FixedWindowLimiter;
  now?: () => Date;
  onNewSignup?: (signup: NewSignup) => Promise<void>;
}

export async function addToWaitlist(
  options: Pick<WaitlistRoutesOptions, 'records' | 'now' | 'onNewSignup'>,
  email: string,
  source: WaitlistRecord['source'],
): Promise<{ full: boolean; added: boolean }> {
  const normalized = email.trim().toLowerCase();
  const result = await options.records.update((items) => {
    if (items.some((item) => item.email === normalized))
      return { items, result: { full: false, added: false, total: items.length, createdAt: '' } };
    if (items.length >= WAITLIST_MAX_ENTRIES)
      return { items, result: { full: true, added: false, total: items.length, createdAt: '' } };
    const record: WaitlistRecord = {
      email: normalized,
      created_at: (options.now?.() ?? new Date()).toISOString(),
      source,
    };
    return {
      items: [...items, record],
      result: { full: false, added: true, total: items.length + 1, createdAt: record.created_at },
    };
  });
  if (result.added)
    void options
      .onNewSignup?.({
        email: normalized,
        source,
        createdAt: result.createdAt,
        total: result.total,
      })
      .catch(() => undefined);
  return result;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, request_id: reply.request.id } });
}

export function registerWaitlistRoutes(app: FastifyInstance, options: WaitlistRoutesOptions): void {
  const origins = new Set(options.allowedOrigins);
  const limiter = options.limiter ?? new FixedWindowLimiter(5, 60 * 60_000);

  const setCors = (reply: FastifyReply, origin: string | undefined): void => {
    void reply.header('vary', 'Origin');
    if (origin !== undefined && origins.has(origin)) {
      void reply.header('access-control-allow-origin', origin);
    }
  };

  app.options('/v1/waitlist', (request, reply) => {
    setCors(reply, request.headers.origin);
    void reply.header('access-control-allow-methods', 'POST');
    void reply.header('access-control-allow-headers', 'content-type');
    void reply.header('access-control-max-age', '600');
    return reply.code(204).send();
  });

  app.post(
    '/v1/waitlist',
    {
      bodyLimit: 2 * 1024,
      onRequest(request, reply, done) {
        const origin = request.headers.origin;
        setCors(reply, origin);
        if (origin !== undefined && !origins.has(origin)) {
          void sendError(reply, 403, 'origin_not_allowed', 'This origin is not allowed.');
          return;
        }
        done();
      },
      errorHandler(error, _request, reply) {
        if (error.statusCode === 413) {
          void sendError(reply, 413, 'bad_request', 'The request was not valid.');
          return;
        }
        if (error.statusCode === 400) {
          void sendError(reply, 400, 'invalid_email', 'Enter a valid email address.');
          return;
        }
        throw error;
      },
    },
    async (request, reply) => {
      if (!limiter.tryAcquire(request.ip)) {
        return sendError(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
      }
      const parsed = waitlistRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'invalid_email', 'Enter a valid email address.');
      }

      const email = parsed.data.email.toLowerCase();
      const result = await addToWaitlist(options, email, parsed.data.source ?? 'landing');
      if (result.full) {
        return sendError(reply, 503, 'waitlist_full', 'The beta waitlist is full.');
      }
      request.log.info({ event: 'waitlist_joined', new: result.added });
      return reply.code(202).send({ status: 'ok' });
    },
  );
}
