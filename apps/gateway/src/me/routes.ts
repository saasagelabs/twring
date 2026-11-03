import {
  appFeedbackRequestSchema,
  appleRevokeRequestSchema,
  type DeleteMyDataResponse,
  type ErrorCode,
  type ErrorResponse,
} from '@twring/contracts';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';

import type { AppleRevokeOutcome } from '../apple-signin';
import { devUserResolver, type ProfileResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import type { Stores } from '../store/repositories';
import type { FeedbackStore } from '../calls/feedback-store';
import { newNoteId, type NoteStore } from './notes';
import type { UserDeletions } from './user-deletions';

export interface MeRoutesOptions {
  /** Undefined when saved agents are not configured (development without a key): 503. */
  stores: Stores | undefined;
  feedback?: FeedbackStore;
  /** Notes from Settings (Send feedback); undefined: the route answers 503. */
  notes?: NoteStore;
  /** The signed-in person's email, kept with a note so the owner can reply. */
  profileFor?: ProfileResolver;
  /** Live calls, so the user's running calls end before their agents and secrets go. */
  liveCalls?: { endCallsForUser(userId: string): Promise<number> };
  userFor?: UserResolver;
  deleteRatePerMinute: number;
  /** Paired computers (ADR-023): revoked along with everything else. */
  connectors?: { revokeAllForUser(userId: string): Promise<number> };
  connectedApps?: { deleteAllForUser(userId: string): Promise<void> };
  threads?: { deleteAllForUser(userId: string): Promise<number>; closeUser(userId: string): void };
  /** Agent photos, encrypted on disk. */
  avatars?: { deleteAllForUser(userId: string): Promise<void> };
  /** Rings (ADR-024): invites, push-registered phones, and ring settings go too. */
  ring?: {
    deleteAllForUser(
      userId: string,
    ): Promise<{ ringInvites: number; devices: number; settings: number }>;
  };
  /** Sign in with Apple revocation (S3); undefined when no key is configured: 503. */
  appleRevoker?: { revokeCode(code: string): Promise<AppleRevokeOutcome> };
  /** Marks Delete my data as running, so a slow save (a speech key) cannot re-add data. */
  deletions?: UserDeletions;
  /** Self-hosted: the person and their paired phones go last, so their token stops working. */
  selfhost?: { deletePerson(userId: string): Promise<void> };
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

/**
 * The calling user's own data (SECURITY §20). `DELETE /v1/me/data` removes their saved agents,
 * sealed credentials, and call history, after ending any call still running, and reports counts.
 * Twring keeps chat messages, which are removed here; call audio and transcripts are not kept.
 */
export function registerMeRoutes(app: FastifyInstance, options: MeRoutesOptions): void {
  const { stores } = options;
  const userFor = options.userFor ?? devUserResolver;
  const limiter = new FixedWindowLimiter(options.deleteRatePerMinute, 60_000);
  const revokeLimiter = new FixedWindowLimiter(options.deleteRatePerMinute, 60_000);
  const noteLimiter = new FixedWindowLimiter(5, 60 * 60_000);

  /** A note from Settings, at any time: kept with the account's email so the owner can reply. */
  app.post('/v1/me/feedback', async (request, reply) => {
    const userId = userFor(request);
    const parsed = appFeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'Write a note first.');
    if (options.notes === undefined) {
      return sendError(reply, 503, 'service_unavailable', "Couldn't send it. Try again later.");
    }
    if (!noteLimiter.tryAcquire(userId)) {
      return sendError(reply, 429, 'rate_limited', 'Thanks! Send more in a little while.');
    }
    const email = options.profileFor?.(request).email;
    const appVersion = request.headers['x-app-version'];
    await options.notes.add({
      id: newNoteId(),
      user_id: userId,
      ...(email && { email }),
      note: parsed.data.note,
      ...(typeof appVersion === 'string' &&
        appVersion.length <= 100 && { app_version: appVersion }),
      created_at: new Date().toISOString(),
    });
    request.log.info({ event: 'app_feedback_received' }, 'app feedback received');
    return { ok: true as const };
  });

  /**
   * `POST /v1/me/apple-revoke`: before an Apple account is
   * deleted, ends Twring's Sign in with Apple with a fresh code from the phone. The phone deletes
   * the account even when this fails; the failure is logged.
   */
  app.post('/v1/me/apple-revoke', { bodyLimit: 4096 }, async (request, reply) => {
    const revoker = options.appleRevoker;
    if (revoker === undefined) {
      return sendError(
        reply,
        503,
        'service_unavailable',
        'Sign in with Apple is not configured on this server.',
      );
    }
    if (!revokeLimiter.tryAcquire(rateKey(request, userFor))) {
      return sendError(
        reply,
        429,
        'rate_limited',
        'Too many requests. Wait a minute and try again.',
      );
    }
    const parsed = appleRevokeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_request', 'Send the authorization code from Apple.');
    }
    try {
      const outcome = await revoker.revokeCode(parsed.data.authorization_code);
      request.log.info({ event: 'apple_signin_revoked', outcome }, 'apple sign-in revoke');
      if (outcome === 'invalid_code') {
        return sendError(reply, 400, 'invalid_request', "Apple's confirmation expired. Try again.");
      }
      return reply.code(204).send();
    } catch (error) {
      const step = error instanceof Error && 'step' in error ? error.step : undefined;
      const status = error instanceof Error && 'status' in error ? error.status : undefined;
      request.log.warn(
        { event: 'apple_revoke_failed', step, status },
        'apple sign-in revoke failed',
      );
      return sendError(
        reply,
        502,
        'apple_revoke_failed',
        "Apple didn't confirm ending Sign in with Apple. Try again later.",
      );
    }
  });

  app.delete(
    '/v1/me/data',
    async (request, reply): Promise<DeleteMyDataResponse | FastifyReply> => {
      if (stores === undefined) {
        return sendError(
          reply,
          503,
          'service_unavailable',
          'Saved agents are not configured on this server.',
        );
      }
      if (!limiter.tryAcquire(rateKey(request, userFor))) {
        return sendError(
          reply,
          429,
          'rate_limited',
          'Too many requests. Wait a minute and try again.',
        );
      }
      return createUserDataDeleter({ ...options, stores })(userFor(request), request.log);
    },
  );
}

/** Deletes everything one person has, as Delete my data does. */
export type UserDataDeleter = (
  userId: string,
  log: FastifyBaseLogger,
) => Promise<DeleteMyDataResponse>;

/**
 * The Delete my data sequence, shared by `DELETE /v1/me/data` and a self-hosted admin purging a
 * person, so both run exactly the same steps.
 */
export function createUserDataDeleter(
  options: Omit<MeRoutesOptions, 'stores'> & { stores: Stores },
): UserDataDeleter {
  const { stores } = options;
  return async (userId, log) => {
    options.deletions?.begin(userId);
    try {
      return await deleteAll(userId, log);
    } finally {
      options.deletions?.end(userId);
    }
  };

  async function deleteAll(userId: string, log: FastifyBaseLogger): Promise<DeleteMyDataResponse> {
    // Calls first: a running call must not read an agent or credential while they are deleted.
    const liveCallsEnded = (await options.liveCalls?.endCallsForUser(userId)) ?? 0;
    // Connectors next: no computer may keep a socket, or pair, for a user being deleted.
    const connectors = await options.connectors?.revokeAllForUser(userId);
    await options.connectedApps?.deleteAllForUser(userId);
    const messages = await options.threads?.deleteAllForUser(userId);
    options.threads?.closeUser(userId);
    // Rings before history: a ring missed now would otherwise leave a voicemail entry behind.
    const ring = await options.ring?.deleteAllForUser(userId);
    // Credentials before agents, as for a single delete: never a secret without its agent.
    let credentials = await stores.credentials.deleteAllForUser(userId);
    const agents = await stores.agents.deleteAllForUser(userId);
    // An agent created meanwhile may have sealed its secret after the first sweep; its profile
    // is gone now, so its secret must go too. (A secret sealed later still is removed by the
    // create itself, which re-checks its agent.)
    credentials += await stores.credentials.deleteAllForUser(userId);
    await options.avatars?.deleteAllForUser(userId);
    // A call that ended above records its history as it finishes; delete after that landed.
    const callHistory = await stores.history.deleteAllForUser(userId);
    const speechKeys = await stores.speechKeys.deleteAllForUser(userId);
    await options.feedback?.deleteAllForUser(userId);
    await options.notes?.deleteAllForUser(userId);
    await options.selfhost?.deletePerson(userId);
    log.info(
      {
        event: 'user_data_deleted',
        agents,
        credentials,
        call_history: callHistory,
        connectors: connectors ?? 0,
        speech_keys: speechKeys,
      },
      'user data deleted',
    );
    return {
      deleted: {
        agents,
        credentials,
        call_history: callHistory,
        speech_keys: speechKeys,
        ...(connectors !== undefined && { connectors }),
        ...(messages !== undefined && { messages }),
        ...(ring !== undefined && { devices: ring.devices, ring_invites: ring.ringInvites }),
      },
      live_calls_ended: liveCallsEnded,
    };
  }
}
