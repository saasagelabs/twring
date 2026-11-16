import {
  languageSettingsSchema,
  type ErrorCode,
  type ErrorResponse,
  type LanguageSettings,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter, rateKey } from '../rate-limit';

import type { LanguageRepository } from './store';

export interface LanguageRoutesOptions {
  store: LanguageRepository;
  userFor?: UserResolver;
  /** Writes per client per minute. */
  writeRatePerMinute: number;
  /** Reads per client per minute. Unlimited when unset. */
  readRatePerMinute?: number;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

/** `GET` / `PUT /v1/me/language`: the language the person speaks (ADR-036). */
export function registerLanguageRoutes(app: FastifyInstance, options: LanguageRoutesOptions): void {
  const userFor = options.userFor ?? devUserResolver;
  const writeLimiter = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const readLimiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  const tooMany = (reply: FastifyReply) =>
    sendError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');

  app.get('/v1/me/language', async (request, reply): Promise<LanguageSettings | FastifyReply> => {
    if (readLimiter !== undefined && !readLimiter.tryAcquire(rateKey(request, userFor)))
      return tooMany(reply);
    return { language: await options.store.get(userFor(request)) };
  });

  app.put('/v1/me/language', async (request, reply): Promise<LanguageSettings | FastifyReply> => {
    if (!writeLimiter.tryAcquire(rateKey(request, userFor))) return tooMany(reply);
    const parsed = languageSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'Choose one of the listed languages.');
    }
    return { language: await options.store.put(userFor(request), parsed.data.language) };
  });
}
