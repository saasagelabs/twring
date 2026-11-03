import {
  AUDIO_EXPIRED_MESSAGE,
  AUDIO_LIMIT_REACHED_MESSAGE,
  AUDIO_PAUSED_MESSAGE,
  AUDIO_UNAVAILABLE_MESSAGE,
  AUDIO_UNREACHABLE_MESSAGE,
  type ConnectorEndpoint,
  callIdSchema,
  callFeedbackRequestSchema,
  createCallRequestSchema,
  type CallSummary,
  type CreateCallResponse,
  type ErrorCode,
  type ErrorResponse,
} from '@twring/contracts';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import { toSafeError } from '../redact';
import type { CallHistoryRepository } from '../store/repositories';
import { StoreCorruptError } from '../store/collection';
import {
  SpeechKeyUnreadableError,
  type ResolvedSpeech,
  type SpeechResolver,
} from '../voice/speech-resolver';
import type { FeedbackStore } from './feedback-store';
import type { RefusalCounter } from './refusal-counter';

import type { Admission, DailyLimits } from './daily-limits';
import {
  agentOwner,
  CallCreateError,
  type CallRegistry,
  type SavedAgentCall,
  type SavedAgentExtras,
} from './registry';

export interface CallRoutesOptions {
  /** Undefined when LiveKit is not configured (development only): call routes answer 503. */
  registry: CallRegistry | undefined;
  feedback?: FeedbackStore;
  /** Counts calls refused before they start, for the daily report. */
  refusals?: Pick<RefusalCounter, 'count'>;
  /** Finds a finished call for feedback once the registry has dropped it (restart, pruning). */
  history?: Pick<CallHistoryRepository, 'list'>;
  createRatePerMinute: number;
  /** Call status reads per client per minute. Unlimited when unset. */
  readRatePerMinute?: number;
  /**
   * Looks up the acting user's saved agent for `agent_id`. Undefined when saved agents are not
   * configured; resolves undefined when there is no such agent for this user.
   */
  resolveAgent?: (
    request: FastifyRequest,
    agentId: string,
    extras?: SavedAgentExtras,
  ) => Promise<SavedAgentCall | undefined>;
  /** Resolves the acting user; calls belong to whoever created them. */
  userFor?: UserResolver;
  /**
   * Whether a call without `agent_id` (the development test line) may start. False in
   * production, where every call goes to a saved agent.
   */
  allowTestLine?: boolean;
  /** Per-user daily allowance; unlimited when absent. */
  dailyLimits?: DailyLimits;
  /**
   * Where a `cord-connector` agent's computer stands right now (ADR-023). Checked before the
   * daily allowance, so a call to an offline computer is refused without being counted.
   */
  /** `scoped`: someone other than the owner, who needs a computer that keeps sessions apart. */
  connectorStatus?: (
    userId: string,
    endpoint: ConnectorEndpoint,
    scoped?: boolean,
  ) => Promise<ConnectorCallStatus>;
  /**
   * Picks the speech keys for the caller's call (their own or Twring's). Checked before the daily
   * allowance, so an unreadable saved key is refused without being counted.
   */
  speech?: SpeechResolver;
  /** Reports a server fault to the operator (Sentry), as the app's 500 path does. */
  onError?: (error: Error, context: { requestId: string }) => void;
}

const SPEECH_PROVIDER_NAMES = { deepgram: 'Deepgram', cartesia: 'Cartesia', xai: 'xAI' } as const;

/** Whether a call to an agent on the user's computer can start. */
export type ConnectorCallStatus = 'online' | 'offline' | 'removed' | 'agent_missing' | 'outdated';

/**
 * Refusals for a connector agent whose computer cannot take the call. All 409: the request was
 * fine, but the computer's current state conflicts with it (and changes when the user acts).
 */
const CONNECTOR_REFUSALS: Record<Exclude<ConnectorCallStatus, 'online'>, [ErrorCode, string]> = {
  offline: [
    'agent_offline',
    "Your computer is offline. Make sure it's on and online, then call again.",
  ],
  removed: ['connector_invalid', 'Computer removed. Pair it again.'],
  agent_missing: ['agent_not_on_computer', "This agent isn't set up on your computer anymore."],
  outdated: [
    'computer_link_outdated',
    "This agent's computer link needs an update. Ask your admin to run the Twring update on that computer.",
  ],
};

export const CALL_IN_PROGRESS_MESSAGE = "You're already on a call. End it first.";

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

const CREATE_ERRORS: Record<CallCreateError['reason'], [number, ErrorCode, string]> = {
  disabled: [503, 'service_unavailable', 'Calls are unavailable right now. Try again later.'],
  updating: [503, 'service_unavailable', 'Twring is updating. Call again in a minute.'],
  capacity: [503, 'capacity_exceeded', 'All call lines are busy. Try again in a minute.'],
  provider: [503, 'service_unavailable', 'We could not start the call. Try again.'],
  in_progress: [409, 'call_in_progress', CALL_IN_PROGRESS_MESSAGE],
  audio_unavailable: [503, 'audio_unavailable', AUDIO_UNAVAILABLE_MESSAGE],
  audio_unreachable: [503, 'audio_unreachable', AUDIO_UNREACHABLE_MESSAGE],
  audio_paused: [403, 'audio_paused', AUDIO_PAUSED_MESSAGE],
  audio_expired: [403, 'audio_expired', AUDIO_EXPIRED_MESSAGE],
  audio_limit_reached: [429, 'audio_limit_reached', AUDIO_LIMIT_REACHED_MESSAGE],
};

/**
 * Call API (BACKEND_SPEC §3). Creation is bounded by the kill switch, a per-client rate limit, and
 * the concurrency cap. A call belongs to the user who created it: another user gets the same 404
 * as for an unknown call id.
 */
/**
 * Starts a call for the acting user, with every rule `POST /v1/calls` applies (rate limit, one call
 * at a time, the computer online, the daily allowance). An answered ring (ADR-024) starts its call
 * through this too, with `extras`. Resolves the 201 body, or sends the refusal, tells
 * `onRefused` its code, and resolves undefined. It never resolves the sent reply: FastifyReply is a thenable, so an async function
 * returning it resolves to undefined anyway, and a caller inspecting the result would throw after
 * the response went out.
 */
export type CallStarter = (
  request: FastifyRequest,
  reply: FastifyReply,
  agentId: string | undefined,
  extras?: SavedAgentExtras,
  onRefused?: (code: ErrorCode) => void,
) => Promise<CreateCallResponse | undefined>;

export function registerCallRoutes(app: FastifyInstance, options: CallRoutesOptions): CallStarter {
  const { registry, dailyLimits } = options;
  const userFor = options.userFor ?? devUserResolver;
  const allowTestLine = options.allowTestLine ?? true;
  const limiter = new FixedWindowLimiter(options.createRatePerMinute, 60_000);
  const readLimiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  const feedbackLimiter = new FixedWindowLimiter(30, 60_000);
  const readLimited = (request: FastifyRequest, reply: FastifyReply) =>
    readLimiter !== undefined &&
    !readLimiter.tryAcquire(rateKey(request, userFor)) &&
    sendError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');

  app.post('/v1/calls', async (request, reply): Promise<CreateCallResponse | FastifyReply> => {
    if (registry === undefined) {
      return sendError(
        reply,
        503,
        'service_unavailable',
        'Calling is not configured on this server.',
      );
    }
    const parsed = createCallRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'The request was not valid.');
    }
    const agentId = parsed.data.agent_id;
    if (agentId === undefined && !allowTestLine) {
      return sendError(reply, 400, 'bad_request', 'Choose an agent to call.');
    }
    return (await start(request, reply, agentId)) ?? reply;
  });

  /** The code each refused start sent, so `start` can tell its caller why. */
  const refusals = new WeakMap<FastifyReply, ErrorCode>();

  /** Sends one of `attempt`'s refusals; resolves undefined, never the reply (see CallStarter). */
  const refuse = (
    reply: FastifyReply,
    status: number,
    code: ErrorCode,
    message: string,
  ): undefined => {
    refusals.set(reply, code);
    sendError(reply, status, code, message);
    return undefined;
  };

  const start: CallStarter = async (request, reply, agentId, extras, onRefused) => {
    const created = await attempt(request, reply, agentId, extras);
    const refused = refusals.get(reply);
    if (created === undefined && refused !== undefined) {
      onRefused?.(refused);
      // The daily report counts refused calls; a failed count must not change the answer.
      await options.refusals?.count(refused).catch((error: unknown) => {
        request.log.warn(
          { event: 'refusal_count_failed', err: toSafeError(error) },
          'refused call not counted for the daily report',
        );
      });
    }
    return created;
  };

  const attempt: CallStarter = async (request, reply, agentId, extras) => {
    if (registry === undefined) {
      return refuse(reply, 503, 'service_unavailable', 'Calling is not configured on this server.');
    }
    if (!limiter.tryAcquire(rateKey(request, userFor))) {
      return refuse(
        reply,
        429,
        'rate_limited',
        'Too many calls started. Wait a minute and try again.',
      );
    }
    const userId = userFor(request);
    // One call at a time: refused before anything is looked up or counted. `create` checks again
    // atomically, which settles two starts that race past this point.
    if (registry.hasLiveCall(userId)) {
      return refuse(reply, 409, 'call_in_progress', CALL_IN_PROGRESS_MESSAGE);
    }
    const erasures = registry.erasureCount(userId);
    let agent: SavedAgentCall | undefined;
    if (agentId !== undefined) {
      if (options.resolveAgent === undefined) {
        return refuse(
          reply,
          503,
          'service_unavailable',
          'Saved agents are not configured on this server.',
        );
      }
      agent = await options.resolveAgent(request, agentId, extras);
      if (agent === undefined || registry.erasureCount(userId) !== erasures) {
        return refuse(reply, 404, 'not_found', 'No such agent.');
      }
      if (agent.protocol === 'mcp-app')
        return refuse(
          reply,
          400,
          'not_supported',
          `${agent.agentName} can't take calls. It reaches you with rings and messages.`,
        );
      // An offline computer must not cost a daily call: checked before the allowance.
      if (agent.connector !== undefined && options.connectorStatus !== undefined) {
        // A shared server agent's computer is its owner's.
        const status = await options.connectorStatus(
          agentOwner(agent),
          agent.connector,
          agent.sessionScope !== undefined,
        );
        if (status !== 'online') {
          const [code, message] = CONNECTOR_REFUSALS[status];
          return refuse(reply, 409, code, message);
        }
      }
    }
    let speech: ResolvedSpeech | undefined;
    if (options.speech !== undefined) {
      try {
        speech = await options.speech.resolve(userId);
      } catch (error) {
        if (error instanceof StoreCorruptError) {
          // Fail closed: without the store nobody can tell whose key is their own.
          // Error level and onError so the operator alert and Sentry fire; no path, no key.
          const safeError = new Error('speech key store unreadable');
          safeError.name = 'SpeechKeysUnavailable';
          request.log.error({ event: 'speech_keys_unavailable' }, 'speech key store unreadable');
          options.onError?.(safeError, { requestId: request.id });
          return refuse(
            reply,
            503,
            'service_unavailable',
            'Calls are briefly unavailable. Try again in a moment.',
          );
        }
        if (!(error instanceof SpeechKeyUnreadableError)) throw error;
        request.log.warn(
          { event: 'speech_key_unreadable', provider: error.provider },
          'saved speech key could not be read',
        );
        return refuse(
          reply,
          409,
          'speech_key_unreadable',
          `Couldn't read your saved ${SPEECH_PROVIDER_NAMES[error.provider]} key. Add it again in Settings.`,
        );
      }
    }
    let admission: Admission | undefined;
    try {
      admission = await options.dailyLimits?.admit(userId);
    } catch (error) {
      // The allowance is a cost guard, not a gate on calling: a damaged or unreadable usage
      // file must not stop every call. Logged so the operator can repair it.
      request.log.warn(
        { event: 'daily_limit_unavailable', err: toSafeError(error) },
        'daily allowance could not be checked; call admitted',
      );
    }
    // The user's data was deleted while the agent was looked up or the allowance checked: that
    // agent is gone, and a call to it would outlive the deletion (and leave history after it).
    // Checked right before create, which registers the call synchronously, so a later deletion
    // ends it instead.
    if (agent !== undefined && registry.erasureCount(userId) !== erasures) {
      if (admission?.admitted) {
        await options.dailyLimits?.refund(userId, admission.day).catch(() => undefined);
      }
      return refuse(reply, 404, 'not_found', 'No such agent.');
    }
    if (admission?.admitted === false && admission.service === true) {
      const body: ErrorResponse = {
        error: {
          code: 'service_busy',
          message: 'Twring is very busy today. Try again after midnight UTC.',
          request_id: request.id,
          resets_at: admission.resetsAt.toISOString(),
        },
      };
      refusals.set(reply, 'service_busy');
      void reply.code(503).send(body);
      return undefined;
    }
    if (admission?.admitted === false) {
      const body: ErrorResponse = {
        error: {
          code: 'daily_limit_reached',
          message: "You've used today's calling time. It resets at midnight UTC.",
          request_id: request.id,
          resets_at: admission.resetsAt.toISOString(),
        },
      };
      refusals.set(reply, 'daily_limit_reached');
      void reply.code(429).send(body);
      return undefined;
    }
    const admittedDay = admission?.admitted === true ? admission.day : undefined;
    try {
      const created = await registry.create(agent, userId, {
        ...(admission?.remainingSeconds !== undefined && {
          dailySecondsLeft: admission.remainingSeconds,
        }),
        ...(admittedDay !== undefined &&
          dailyLimits !== undefined && {
            refund: () => dailyLimits.refund(userId, admittedDay),
          }),
        ...(speech !== undefined && { speech }),
      });
      void reply.code(201);
      return created;
    } catch (error) {
      if (admission?.admitted) {
        await options.dailyLimits?.refund(userId, admission.day).catch(() => undefined);
      }
      if (error instanceof CallCreateError) {
        const [status, code, message] = CREATE_ERRORS[error.reason];
        return refuse(reply, status, code, message);
      }
      throw error;
    }
  };

  app.get<{ Params: { callId: string } }>(
    '/v1/calls/:callId',
    (request, reply): CallSummary | FastifyReply => {
      const rateLimited = readLimited(request, reply);
      if (rateLimited) return rateLimited;
      const summary =
        parseCallId(request.params.callId) &&
        registry?.getFor(userFor(request), request.params.callId);
      return summary || sendError(reply, 404, 'not_found', 'No such call.');
    },
  );

  app.post<{ Params: { callId: string } }>(
    '/v1/calls/:callId/end',
    async (request, reply): Promise<CallSummary | FastifyReply> => {
      // Never rate-limited: a hang-up must always work, and it is cheap and idempotent.
      const summary =
        parseCallId(request.params.callId) &&
        (await registry?.endFor(userFor(request), request.params.callId));
      return summary || sendError(reply, 404, 'not_found', 'No such call.');
    },
  );
  app.post<{ Params: { callId: string } }>('/v1/calls/:callId/feedback', async (request, reply) => {
    const userId = userFor(request);
    const callId = request.params.callId;
    let target = parseCallId(callId) ? registry?.feedbackTargetFor(userId, callId) : undefined;
    if (target === undefined && parseCallId(callId)) {
      const item = (await options.history?.list(userId, 50))?.find((c) => c.call_id === callId);
      if (item !== undefined) target = { agentId: item.agent_id };
    }
    if (!target) return sendError(reply, 404, 'not_found', 'No such call.');
    if (!feedbackLimiter.tryAcquire(userId))
      return sendError(
        reply,
        429,
        'rate_limited',
        'Too many requests. Wait a minute and try again.',
      );
    const parsed = callFeedbackRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, 'bad_request', 'The request was not valid.');
    if (options.feedback === undefined)
      return sendError(reply, 503, 'service_unavailable', 'Feedback is unavailable right now.');
    const appVersion = request.headers['x-app-version'];
    await options.feedback.upsert({
      call_id: request.params.callId,
      user_id: userId,
      agent_id: target.agentId,
      ...(target.protocol && { protocol: target.protocol }),
      ...parsed.data,
      ...(typeof appVersion === 'string' &&
        appVersion.length <= 100 && { app_version: appVersion }),
      created_at: new Date().toISOString(),
    });
    return { ok: true as const };
  });
  app.post<{ Params: { callId: string; approvalId: string } }>(
    '/v1/calls/:callId/approvals/:approvalId',
    (request, reply): FastifyReply => {
      const body = z.object({ decision: z.enum(['approve', 'deny']) }).safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'bad_request', 'The request was not valid.');
      if (!parseCallId(request.params.callId))
        return sendError(reply, 404, 'not_found', 'No such approval.');
      const result =
        registry?.decideApprovalFor(
          userFor(request),
          request.params.callId,
          request.params.approvalId,
          body.data.decision,
        ) ?? 'unknown';
      if (result === 'unknown') return sendError(reply, 404, 'not_found', 'No such approval.');
      if (result === 'decided')
        return sendError(reply, 409, 'approval_already_decided', 'Approval already decided.');
      return reply.code(204).send();
    },
  );
  return start;
}

function parseCallId(value: string): boolean {
  return callIdSchema.safeParse(value).success;
}
