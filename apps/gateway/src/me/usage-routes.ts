import type { ErrorResponse, MeUsageResponse } from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import type { DailyLimits } from '../calls/daily-limits';
import { FixedWindowLimiter, rateKey } from '../rate-limit';

export interface UsageRoutesOptions {
  dailyLimits: DailyLimits;
  userFor?: UserResolver;
  readRatePerMinute?: number;
}

/** `GET /v1/me/usage`: today's calling (UTC day) against the daily allowance. */
export function registerUsageRoutes(app: FastifyInstance, options: UsageRoutesOptions): void {
  const userFor = options.userFor ?? devUserResolver;
  const limiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);

  app.get('/v1/me/usage', async (request, reply): Promise<MeUsageResponse | FastifyReply> => {
    if (limiter !== undefined && !limiter.tryAcquire(rateKey(request, userFor))) {
      const body: ErrorResponse = {
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Wait a minute and try again.',
          request_id: request.id,
        },
      };
      return reply.code(429).send(body);
    }
    return options.dailyLimits.usage(userFor(request));
  });
}
