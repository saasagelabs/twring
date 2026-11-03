import { accessResponseSchema, inviteRedeemRequestSchema, type ErrorCode } from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { ProfileResolver, UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { addToWaitlist, type WaitlistRoutesOptions } from '../waitlist/routes';
import type { InviteService } from './invites';

export interface InviteRoutesOptions {
  service: InviteService;
  profileFor: ProfileResolver;
  userFor: UserResolver;
  waitlist?: Pick<WaitlistRoutesOptions, 'records' | 'now' | 'onNewSignup'>;
  userLimiter?: FixedWindowLimiter;
  ipLimiter?: FixedWindowLimiter;
}

function error(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.code(status).send({ error: { code, message, request_id: reply.request.id } });
}

export function registerInviteRoutes(app: FastifyInstance, options: InviteRoutesOptions): void {
  const checked = new Set<string>();
  const userLimiter = options.userLimiter ?? new FixedWindowLimiter(5, 60 * 60_000);
  const ipLimiter = options.ipLimiter ?? new FixedWindowLimiter(20, 60 * 60_000);

  app.get('/v1/me/access', async (request, reply) => {
    const email = options.profileFor(request).email?.trim().toLowerCase();
    let member = await options.service.isMember(email);
    if (!member && email) {
      // Automatic places (AUTO_ADMIT_PER_DAY): a newcomer gets in without waiting for the owner.
      const admitted = await options.service.admit(email, options.userFor(request));
      if (admitted === 'admitted' || admitted === 'member') {
        member = true;
        if (admitted === 'admitted') {
          request.log.info({ event: 'access_auto_admitted' });
          // Someone who waited on the list (a full day earlier) is no longer waiting. Being let
          // in must not depend on this bookkeeping.
          try {
            await options.waitlist?.records.update((items) => ({
              items: items.map((r) =>
                r.email === email && r.invited_at === undefined
                  ? { ...r, invited_at: new Date().toISOString() }
                  : r,
              ),
              result: undefined,
            }));
          } catch {
            request.log.warn({ event: 'access_waitlist_mark_failed' }, 'could not mark waitlist');
          }
        }
      }
    }
    if (!member && email && options.waitlist && !checked.has(email)) {
      // Reserve before the await so concurrent launches submit just once per process.
      checked.add(email);
      try {
        await addToWaitlist(options.waitlist, email, 'app');
      } catch {
        // The access answer must not depend on the waitlist: retry on the next launch.
        checked.delete(email);
        request.log.warn({ event: 'access_waitlist_failed' }, 'could not add account to waitlist');
      }
    }
    return reply.send(accessResponseSchema.parse({ member, ...(email && { email }) }));
  });

  app.post('/v1/me/invite', async (request, reply) => {
    const userId = options.userFor(request);
    if (!userLimiter.tryAcquire(userId) || !ipLimiter.tryAcquire(request.ip))
      return error(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
    const parsed = inviteRedeemRequestSchema.safeParse(request.body);
    if (!parsed.success) return error(reply, 400, 'bad_request', 'The request was not valid.');
    const email = options.profileFor(request).email?.trim().toLowerCase();
    if (!email) return error(reply, 400, 'bad_request', 'The account has no email address.');
    const result = await options.service.redeem(email, parsed.data.code, userId);
    if (result === 'invalid') {
      request.log.info({ event: 'invite_rejected' });
      return error(
        reply,
        400,
        'invite_invalid',
        "That code isn't valid. Check it, or ask for a new one.",
      );
    }
    if (result === 'redeemed') request.log.info({ event: 'invite_redeemed' });
    return reply.send(accessResponseSchema.parse({ member: true, email }));
  });
}
