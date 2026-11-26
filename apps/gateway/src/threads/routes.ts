import {
  type SpeakerLanguage,
  approvalDecisionRequestSchema,
  sealedApprovalDecisionRequestSchema,
  agentIdSchema,
  fileIdSchema,
  MAX_USER_MESSAGE_CHARS,
  mediaPageResponseSchema,
  mediaQuerySchema,
  messagePageResponseSchema,
  readMarkerRequestSchema,
  sendMessageRequestSchema,
  sendSealedMessageRequestSchema,
  setPrivateRequestSchema,
  CLIENT_FEATURES_HEADER,
  SEALED_CHAT_FEATURE,
  threadListResponseSchema,
  threadMessageIdSchema,
  threadMessageSchema,
  voiceNoteQuerySchema,
  type ThreadMessage,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { GatewayErrorCode } from '../e2e/guard';
import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { toSafeError } from '../redact';
import type { AgentRecord, AgentRepository } from '../store/repositories';
import { ThreadServiceError, type ThreadService } from './service';
import type { SqliteThreadStore } from './store';
import { quoteOf } from './quote';
import { StoreCorruptError } from '../store/collection';
import { isKeyRefusal, PrerecordedTranscriptionError } from '../voice/deepgram-prerecorded';
import {
  SpeechKeyRefusedError,
  speechKeyRefusal,
  type ProviderSpeech,
  type SpeechResolver,
} from '../voice/speech-resolver';

export interface ThreadRoutesOptions {
  service: ThreadService;
  store: SqliteThreadStore;
  agents: Pick<AgentRepository, 'get'>;
  /**
   * Self-hosted shared agents: true when this person may not message the agent until its
   * computer link is updated (it cannot keep their conversation apart from the owner's).
   */
  linkOutdated?: (userId: string, record: AgentRecord) => boolean;
  writeRatePerMinute: number;
  readRatePerMinute: number;
  messagesPerDay: number;
  userFor?: UserResolver;
  transcribeVoiceNote?: (
    audio: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
    keyterms?: readonly string[],
    /** The person's own key for this note; the server key when absent. */
    apiKey?: string,
    /** The language the person speaks (ADR-036); English when absent. */
    language?: SpeakerLanguage,
  ) => Promise<string>;
  /** A voice note heard by xAI: the person's own key when they chose it, or the server's own. */
  transcribeWithXai?: (
    apiKey: string,
    audio: Uint8Array,
    contentType: string,
    keyterms?: readonly string[],
    signal?: AbortSignal,
    language?: SpeakerLanguage,
  ) => Promise<string>;
  /** Whose Deepgram key a voice note uses (BYOK); absent means Twring's, as before. */
  speech?: SpeechResolver;
  /**
   * The person's language when there is no resolver (saved keys off): voice notes are heard in
   * it all the same (ADR-036). A failure reads as English.
   */
  languageFor?: (userId: string) => Promise<SpeakerLanguage>;
  /** Operator alert for a speech key store that cannot be read. */
  onError?: (error: Error, context: { requestId: string }) => void;
  /** The words a voice note to this agent should hear right, as its calls do. */
  wordsFor?: (userId: string, agentId: string) => Promise<readonly string[]>;
  filesEnabled?: boolean;
}

/** Media list cursor: the oldest item seen, as opaque base64url of `created_at|file id`. */
const mediaCursor = {
  encode: (createdAt: string, id: string) =>
    Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url'),
  decode: (cursor: string): { createdAt: string; id: string } | undefined => {
    const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    return rest.length === 0 &&
      z.iso.datetime().safeParse(createdAt).success &&
      fileIdSchema.safeParse(id).success
      ? { createdAt: createdAt!, id: id! }
      : undefined;
  },
};

const queryInteger = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe());
const pageQuery = z
  .object({
    before_seq: queryInteger.pipe(z.number().min(1)).optional(),
    after_rev: queryInteger.optional(),
    limit: queryInteger.pipe(z.number().min(1).max(100)).default(50),
  })
  .strict()
  .refine((q) => q.before_seq === undefined || q.after_rev === undefined);

function error(
  reply: FastifyReply,
  status: number,
  code: GatewayErrorCode,
  message: string,
): FastifyReply {
  const body = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

export function registerThreadRoutes(app: FastifyInstance, options: ThreadRoutesOptions): void {
  const userFor = options.userFor ?? devUserResolver;
  const reads = new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  const writes = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const daily = new Map<string, { day: string; count: number }>();
  const sends = new Map<string, Promise<{ message: ThreadMessage; created: boolean }>>();
  const limited = (reply: FastifyReply) =>
    error(reply, 429, 'rate_limited', 'Too many messages. Try again later.');
  const agentFor = async (userId: string, agentId: string) =>
    agentIdSchema.safeParse(agentId).success && (await options.agents.get(userId, agentId));
  /** The agent to write to, or the error already sent (404, or 409 for an outdated link). */
  const writable = async (
    userId: string,
    agentId: string,
    reply: FastifyReply,
  ): Promise<AgentRecord | undefined> => {
    const record = await agentFor(userId, agentId);
    if (!record) {
      error(reply, 404, 'not_found', 'No such agent.');
      return undefined;
    }
    if (options.linkOutdated?.(userId, record) === true) {
      error(
        reply,
        409,
        'computer_link_outdated',
        "This agent's computer link needs an update. Ask your admin to run the Twring update on that computer.",
      );
      return undefined;
    }
    return record;
  };
  const sendFailure = (reply: FastifyReply, cause: unknown): FastifyReply => {
    if (cause instanceof ThreadServiceError) {
      if (cause.code === 'queue_full')
        return error(
          reply,
          409,
          'thread_queue_full',
          'Your agent already has 5 messages waiting. Wait for them to go through.',
        );
      if (cause.code === 'agent_not_found') return error(reply, 404, 'not_found', 'No such agent.');
      if (cause.code === 'bad_attachment')
        return error(reply, 400, 'bad_request', "A file can't be found. Send it again.");
      if (cause.code === 'reply_to_not_found')
        return error(
          reply,
          400,
          'reply_to_not_found',
          'The message you replied to is gone. Send it without the reply.',
        );
      if (cause.code === 'private_thread')
        return error(
          reply,
          409,
          'private_thread',
          'This chat is private. Update Twring to send messages in it.',
        );
      if (cause.code === 'not_private')
        return error(reply, 409, 'not_private', 'This chat is not private.');
      if (cause.code === 'private_chats_off')
        return error(reply, 404, 'private_chats_off', 'Private chats are not available yet.');
      if (cause.code === 'private_unsupported')
        return error(
          reply,
          409,
          'private_unsupported',
          'This chat cannot be private yet. Update Twring on your phone and your computer.',
        );
    }
    const refusal = speechKeyRefusal(cause);
    if (refusal) return error(reply, refusal.status, refusal.code, refusal.message);
    if (cause instanceof PrerecordedTranscriptionError)
      return cause.code === 'empty'
        ? error(reply, 400, 'bad_request', "Couldn't hear anything in that voice note.")
        : error(
            reply,
            502,
            'service_unavailable',
            'Voice transcription is unavailable. Try again.',
          );
    throw cause;
  };

  /** Daily and per-minute counting shared by every way of sending; undefined when limited. */
  const countSend = (userId: string): { release(): void } | undefined => {
    const day = new Date().toISOString().slice(0, 10);
    const usage = daily.get(userId);
    const count = usage?.day === day ? usage.count : 0;
    if (count >= options.messagesPerDay || !writes.tryAcquire(userId)) return undefined;
    daily.set(userId, { day, count: count + 1 });
    return {
      release: () => {
        const current = daily.get(userId);
        if (current?.day === day) current.count--;
      },
    };
  };

  const sendSealed = async (
    userId: string,
    agentId: string,
    raw: object,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const body = sendSealedMessageRequestSchema.safeParse(raw);
    if (!body.success) return error(reply, 400, 'bad_request', 'Invalid message.');
    const counted = countSend(userId);
    if (!counted) return limited(reply);
    try {
      const result = await options.service.sendSealed(userId, agentId, {
        clientId: body.data.client_id,
        sealed: body.data.sealed,
        ...(body.data.reply_to !== undefined && { replyTo: body.data.reply_to }),
        ...(body.data.attachment_ids !== undefined && { attachmentIds: body.data.attachment_ids }),
      });
      if (!result.created) counted.release();
      return reply
        .code(result.created ? 201 : 200)
        .send({ message: threadMessageSchema.parse(result.message) });
    } catch (cause) {
      counted.release();
      return sendFailure(reply, cause);
    }
  };

  // Makes a chat private (ADR-044). The app says it can seal; the server checks the computer.
  app.put<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/private',
    { bodyLimit: 1024 },
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await writable(userId, request.params.agentId, reply))) return reply;
      const body = setPrivateRequestSchema.safeParse(request.body);
      if (!body.success) return error(reply, 400, 'bad_request', 'Invalid request.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      if (!body.data.on)
        return error(
          reply,
          409,
          'private_is_one_way',
          'A private chat stays private. Start a new chat instead.',
        );
      const header = request.headers[CLIENT_FEATURES_HEADER];
      const appSupports =
        typeof header === 'string' &&
        header.length <= 256 &&
        header
          .split(',')
          .map((feature) => feature.trim())
          .includes(SEALED_CHAT_FEATURE);
      try {
        await options.service.setPrivate(userId, request.params.agentId, appSupports);
      } catch (cause) {
        return sendFailure(reply, cause);
      }
      return { private: true };
    },
  );

  app.get('/v1/threads', async (request, reply) => {
    const userId = userFor(request);
    if (!reads.tryAcquire(userId)) return limited(reply);
    const threads = await options.store.listThreads(userId);
    const existing = await Promise.all(
      threads.map(async (thread) =>
        (await options.agents.get(userId, thread.agent_id)) ? thread : undefined,
      ),
    );
    return threadListResponseSchema.parse({
      threads: existing.filter((v) => v !== undefined),
      files: options.filesEnabled === true,
    });
  });

  app.get<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
    '/v1/agents/:agentId/messages',
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await agentFor(userId, request.params.agentId)))
        return error(reply, 404, 'not_found', 'No such agent.');
      const query = pageQuery.safeParse(request.query);
      if (!query.success) return error(reply, 400, 'bad_request', 'Invalid message query.');
      if (!reads.tryAcquire(userId)) return limited(reply);
      const page = await options.store.listMessages(userId, request.params.agentId, {
        limit: query.data.limit,
        ...(query.data.before_seq !== undefined && { beforeSeq: query.data.before_seq }),
        ...(query.data.after_rev !== undefined && { afterRev: query.data.after_rev }),
      });
      return messagePageResponseSchema.parse({ messages: page.messages, has_more: page.hasMore });
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/messages',
    // Room for a sealed body (ADR-044); a plain text message keeps its 16 KB limit below.
    { bodyLimit: SEALED_BODY_LIMIT },
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await writable(userId, request.params.agentId, reply))) return reply;
      const raw = request.body;
      if (typeof raw === 'object' && raw !== null && 'sealed' in raw)
        return sendSealed(userId, request.params.agentId, raw, reply);
      if (Number(request.headers['content-length'] ?? 0) > TEXT_BODY_LIMIT)
        return error(reply, 413, 'bad_request', 'Message too large.');
      const body = sendMessageRequestSchema.safeParse(request.body);
      if (!body.success) return error(reply, 400, 'bad_request', 'Invalid message.');
      if (body.data.attachment_ids && !options.filesEnabled)
        return error(reply, 400, 'bad_request', 'Files are unavailable.');
      const prior = await options.store.findUserMessageByClientId(
        userId,
        request.params.agentId,
        body.data.client_id,
      );
      if (prior) return reply.code(200).send({ message: threadMessageSchema.parse(prior) });
      const sendKey = `${userId}\0${request.params.agentId}\0${body.data.client_id}`;
      const pending = sends.get(sendKey);
      if (pending) {
        try {
          const result = await pending;
          return reply.code(200).send({ message: threadMessageSchema.parse(result.message) });
        } catch (cause) {
          return sendFailure(reply, cause);
        }
      }
      const day = new Date().toISOString().slice(0, 10);
      const usage = daily.get(userId);
      const count = usage?.day === day ? usage.count : 0;
      if (count >= options.messagesPerDay || !writes.tryAcquire(userId)) return limited(reply);
      daily.set(userId, { day, count: count + 1 });
      const release = () => {
        const current = daily.get(userId);
        if (current?.day === day) current.count--;
      };
      const work = options.service.send(userId, request.params.agentId, {
        clientId: body.data.client_id,
        text: body.data.text,
        attachmentIds: body.data.attachment_ids,
        ...(body.data.reply_to !== undefined && { replyTo: body.data.reply_to }),
      });
      sends.set(sendKey, work);
      try {
        const result = await work;
        if (!result.created) release();
        return reply
          .code(result.created ? 201 : 200)
          .send({ message: threadMessageSchema.parse(result.message) });
      } catch (cause) {
        release();
        return sendFailure(reply, cause);
      } finally {
        if (sends.get(sendKey) === work) sends.delete(sendKey);
      }
    },
  );

  app.register((voiceApp, _pluginOptions, done) => {
    // Every body arrives as bytes; the handler decides the audio type. React Native on Android
    // sends a file upload with an empty content type, whatever header the app set.
    voiceApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    // Fastify refuses an empty content type outright; treat it as generic bytes instead.
    voiceApp.addHook('onRequest', (request, _reply, next) => {
      if (request.headers['content-type']?.trim() === '')
        request.headers['content-type'] = 'application/octet-stream';
      next();
    });
    voiceApp.post<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
      '/v1/agents/:agentId/voice-notes',
      { bodyLimit: 2 * 1024 * 1024 },
      async (request, reply) => {
        const userId = userFor(request);
        const agentId = request.params.agentId;
        if (!(await writable(userId, agentId, reply))) return reply;
        const query = voiceNoteQuerySchema.safeParse(request.query);
        if (!query.success || query.data.duration_ms < 1_000 || query.data.duration_ms > 120_500)
          return error(reply, 400, 'bad_request', 'Invalid voice note duration.');
        const {
          client_id: clientId,
          duration_ms: durationMs,
          reply_to: replyTo,
          server_readable: consent,
        } = query.data;
        const prior = await options.store.findUserMessageByClientId(userId, agentId, clientId);
        if (prior) return reply.code(200).send({ message: threadMessageSchema.parse(prior) });
        // A private chat hears a voice note only with the person's consent (ADR-044), checked
        // before any audio leaves for transcription.
        const privateChat = await options.store.isPrivate(userId, agentId);
        if (privateChat && consent !== '1')
          return sendFailure(reply, new ThreadServiceError('private_thread'));
        const serverReadable = privateChat ? (true as const) : undefined;
        // Checked before transcription is paid for; the store checks again when it saves.
        if (replyTo !== undefined) {
          const answered = await options.store.findMessageById(userId, agentId, replyTo);
          if (!answered || (!quoteOf(answered) && answered.kind !== 'sealed'))
            return sendFailure(reply, new ThreadServiceError('reply_to_not_found'));
        }
        if (!Buffer.isBuffer(request.body) || request.body.length === 0)
          return error(reply, 400, 'bad_request', 'Invalid voice note.');
        const contentType = voiceNoteType(request.headers['content-type'], request.body);
        if (!contentType) return error(reply, 415, 'bad_request', 'Unsupported voice note format.');
        const transcribe = options.transcribeVoiceNote;
        if (!transcribe && !options.transcribeWithXai)
          return error(
            reply,
            502,
            'service_unavailable',
            'Voice transcription is unavailable. Try again.',
          );
        const sendKey = `${userId}\0${agentId}\0${clientId}`;
        const joinPending = async (
          pending: Promise<{ message: ThreadMessage; created: boolean }>,
        ) => {
          try {
            const result = await pending;
            return reply.code(200).send({ message: threadMessageSchema.parse(result.message) });
          } catch (cause) {
            return sendFailure(reply, cause);
          }
        };
        const pending = sends.get(sendKey);
        if (pending) return joinPending(pending);
        let deepgram: ProviderSpeech | undefined;
        let xai: ProviderSpeech | undefined;
        let language: SpeakerLanguage | undefined;
        if (options.speech !== undefined) {
          try {
            const resolved = await options.speech.resolve(userId);
            deepgram = resolved.deepgram;
            language = resolved.language;
            // xAI hears the note only when the person chose it and its key is here.
            if (resolved.listening === 'xai') xai = resolved.xai;
          } catch (cause) {
            if (cause instanceof StoreCorruptError) {
              // Fail closed, as calls do: nobody can tell whose key is their own. No path, no key.
              const safeError = new Error('speech key store unreadable');
              safeError.name = 'SpeechKeysUnavailable';
              request.log.error(
                { event: 'speech_keys_unavailable' },
                'speech key store unreadable',
              );
              options.onError?.(safeError, { requestId: request.id });
              return error(
                reply,
                503,
                'service_unavailable',
                'Voice is briefly unavailable. Try again in a moment.',
              );
            }
            return sendFailure(reply, cause);
          }
          // The same note may have started while its keys were looked up: join it, never resend.
          const started = sends.get(sendKey);
          if (started) return joinPending(started);
        } else if (options.languageFor !== undefined) {
          const chosen = await options.languageFor(userId).catch(() => 'en' as const);
          if (chosen !== 'en') language = chosen;
          const started = sends.get(sendKey);
          if (started) return joinPending(started);
        }
        const transcribeWithXai = options.transcribeWithXai;
        if (xai === undefined ? !transcribe : !transcribeWithXai)
          return error(
            reply,
            502,
            'service_unavailable',
            'Voice transcription is unavailable. Try again.',
          );
        const day = new Date().toISOString().slice(0, 10);
        const usage = daily.get(userId);
        const count = usage?.day === day ? usage.count : 0;
        if (count >= options.messagesPerDay || !writes.tryAcquire(userId)) return limited(reply);
        daily.set(userId, { day, count: count + 1 });
        let created = false;
        const work = (async () => {
          // A failed lookup only loses the hints, never the voice note.
          const words = await (options.wordsFor?.(userId, agentId) ?? Promise.resolve([])).catch(
            (error: unknown) => {
              request.log.warn(
                { event: 'voice_note_words_unavailable', err: toSafeError(error) },
                'voice note transcribed without the agent words',
              );
              return [];
            },
          );
          const audio = request.body as Buffer;
          const transcript = await (
            xai !== undefined
              ? language === undefined
                ? transcribeWithXai!(xai.apiKey, audio, contentType, words)
                : transcribeWithXai!(xai.apiKey, audio, contentType, words, undefined, language)
              : language === undefined
                ? transcribe!(
                    audio,
                    contentType,
                    undefined,
                    words,
                    ...(deepgram ? [deepgram.apiKey] : []),
                  )
                : transcribe!(audio, contentType, undefined, words, deepgram?.apiKey, language)
          ).catch((cause: unknown) => {
            const used = xai ?? deepgram;
            // The person's own key refused: stop here; it never moves to Twring's key.
            if (
              used?.source === 'own' &&
              cause instanceof PrerecordedTranscriptionError &&
              isKeyRefusal(cause.status)
            )
              throw new SpeechKeyRefusedError(xai !== undefined ? 'xai' : 'deepgram');
            throw cause;
          });
          const text = transcript.slice(0, MAX_USER_MESSAGE_CHARS);
          if (!text.trim()) throw new PrerecordedTranscriptionError('empty');
          return options.service.send(userId, agentId, {
            clientId,
            text,
            voice: { duration_s: Math.min(120, Math.round(durationMs / 1_000)) },
            ...(replyTo !== undefined && { replyTo }),
            ...(serverReadable && { serverReadable }),
          });
        })();
        sends.set(sendKey, work);
        try {
          const result = await work;
          created = result.created;
          return reply
            .code(created ? 201 : 200)
            .send({ message: threadMessageSchema.parse(result.message) });
        } catch (cause) {
          return sendFailure(reply, cause);
        } finally {
          if (!created) {
            const current = daily.get(userId);
            if (current?.day === day) current.count--;
          }
          if (sends.get(sendKey) === work) sends.delete(sendKey);
        }
      },
    );
    done();
  });

  app.post<{ Params: { agentId: string; messageId: string } }>(
    '/v1/agents/:agentId/messages/:messageId/stop',
    async (request, reply) => {
      const userId = userFor(request);
      if (
        !(await agentFor(userId, request.params.agentId)) ||
        !threadMessageIdSchema.safeParse(request.params.messageId).success
      )
        return error(reply, 404, 'not_found', 'No such message.');
      if (
        !(await options.store.findUserMessageById(
          userId,
          request.params.agentId,
          request.params.messageId,
        ))
      )
        return error(reply, 404, 'not_found', 'No such message.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      const message = await options.service.stop(userId, request.params.messageId);
      if (!message || message.agent_id !== request.params.agentId)
        return error(reply, 404, 'not_found', 'No such message.');
      return { message: threadMessageSchema.parse(message) };
    },
  );

  app.post<{ Params: { agentId: string; messageId: string } }>(
    '/v1/agents/:agentId/approvals/:messageId',
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const userId = userFor(request);
      if (
        !(await agentFor(userId, request.params.agentId)) ||
        !threadMessageIdSchema.safeParse(request.params.messageId).success
      )
        return error(reply, 404, 'not_found', 'No such approval.');
      // A private chat's approval is answered sealed (C3 #11); the server only relays it.
      const sealed = sealedApprovalDecisionRequestSchema.safeParse(request.body);
      const body = approvalDecisionRequestSchema.safeParse(request.body);
      if (!sealed.success && !body.success)
        return error(reply, 400, 'bad_request', 'Invalid decision.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      try {
        const message = sealed.success
          ? await options.service.decideSealedApproval(
              userId,
              request.params.agentId,
              request.params.messageId,
              sealed.data.sealed,
            )
          : await options.service.decideApproval(
              userId,
              request.params.agentId,
              request.params.messageId,
              body.data!.decision,
            );
        return { message: threadMessageSchema.parse(message) };
      } catch (cause) {
        if (cause instanceof ThreadServiceError) {
          if (cause.code === 'approval_not_found')
            return error(reply, 404, 'not_found', 'No such approval.');
          if (cause.code === 'computer_offline')
            return error(
              reply,
              409,
              'agent_offline',
              "Your computer isn't connected. Open it and try again.",
            );
          if (cause.code === 'approval_conflict')
            return reply.code(409).send({
              error: {
                code: 'approval_already_decided',
                message: 'Approval is no longer pending.',
                request_id: request.id,
              },
              message: cause.current,
            });
        }
        throw cause;
      }
    },
  );

  // Deletes one message from Twring (never from the agent's own memory). Idempotent: an id that is
  // already gone, or was never in this person's thread, answers 204 like a fresh delete.
  app.delete<{ Params: { agentId: string; messageId: string } }>(
    '/v1/agents/:agentId/messages/:messageId',
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await agentFor(userId, request.params.agentId)))
        return error(reply, 404, 'not_found', 'No such agent.');
      if (!threadMessageIdSchema.safeParse(request.params.messageId).success)
        return error(reply, 404, 'not_found', 'No such message.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      try {
        await options.service.deleteMessage(
          userId,
          request.params.agentId,
          request.params.messageId,
        );
      } catch (cause) {
        if (cause instanceof ThreadServiceError && cause.code === 'message_in_progress')
          return error(
            reply,
            409,
            'message_in_progress',
            'Your agent is still answering this message. Stop it first, then delete it.',
          );
        throw cause;
      }
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { agentId: string }; Querystring: Record<string, unknown> }>(
    '/v1/agents/:agentId/media',
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await agentFor(userId, request.params.agentId)))
        return error(reply, 404, 'not_found', 'No such agent.');
      const query = mediaQuerySchema.safeParse(request.query);
      const before =
        query.success && query.data.cursor !== undefined
          ? mediaCursor.decode(query.data.cursor)
          : undefined;
      if (!query.success || (query.data.cursor !== undefined && !before))
        return error(reply, 400, 'bad_request', 'Invalid media query.');
      if (!reads.tryAcquire(userId)) return limited(reply);
      const page = await options.store.listMedia(userId, request.params.agentId, {
        limit: query.data.limit,
        ...(before && { before }),
      });
      const last = page.items.at(-1);
      return mediaPageResponseSchema.parse({
        items: page.items.map(({ messageId, createdAt, ...item }) => ({
          ...item,
          message_id: messageId,
          created_at: createdAt,
        })),
        next_cursor: page.hasMore && last ? mediaCursor.encode(last.createdAt, last.id) : null,
      });
    },
  );

  app.put<{ Params: { agentId: string } }>('/v1/agents/:agentId/read', async (request, reply) => {
    const userId = userFor(request);
    if (!(await agentFor(userId, request.params.agentId)))
      return error(reply, 404, 'not_found', 'No such agent.');
    const body = readMarkerRequestSchema.safeParse(request.body);
    if (!body.success) return error(reply, 400, 'bad_request', 'Invalid read marker.');
    if (!writes.tryAcquire(userId)) return limited(reply);
    await options.store.markRead(userId, request.params.agentId, body.data.seq);
    return reply.code(204).send();
  });

  app.delete<{ Params: { agentId: string } }>(
    '/v1/agents/:agentId/messages',
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await agentFor(userId, request.params.agentId)))
        return error(reply, 404, 'not_found', 'No such agent.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      return { deleted: await options.service.clear(userId, request.params.agentId) };
    },
  );
}

const TEXT_BODY_LIMIT = 16 * 1024;
const SEALED_BODY_LIMIT = 32 * 1024;

const VOICE_NOTE_TYPES = new Set(['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac']);

/**
 * The audio type to transcribe as, or undefined when the note is not one we accept. A known audio
 * header is trusted; a missing or generic one is accepted only when the bytes are an MP4 container
 * (an `ftyp` box at offset 4), which is what the app records.
 */
export function voiceNoteType(header: string | undefined, body: Buffer): string | undefined {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (VOICE_NOTE_TYPES.has(type)) return type;
  const generic = type === '' || type === 'application/octet-stream';
  return generic && body.length >= 8 && body.toString('latin1', 4, 8) === 'ftyp'
    ? 'audio/mp4'
    : undefined;
}
