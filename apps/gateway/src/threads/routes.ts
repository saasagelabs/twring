import {
  approvalDecisionRequestSchema,
  agentIdSchema,
  MAX_USER_MESSAGE_CHARS,
  messagePageResponseSchema,
  readMarkerRequestSchema,
  sendMessageRequestSchema,
  threadListResponseSchema,
  threadMessageIdSchema,
  threadMessageSchema,
  voiceNoteQuerySchema,
  type ErrorCode,
  type ErrorResponse,
  type ThreadMessage,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { toSafeError } from '../redact';
import type { AgentRecord, AgentRepository } from '../store/repositories';
import { ThreadServiceError, type ThreadService } from './service';
import type { SqliteThreadStore } from './store';
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
  ) => Promise<string>;
  /** A voice note heard by xAI: the person's own key when they chose it, or the server's own. */
  transcribeWithXai?: (
    apiKey: string,
    audio: Uint8Array,
    contentType: string,
    keyterms?: readonly string[],
    signal?: AbortSignal,
  ) => Promise<string>;
  /** Whose Deepgram key a voice note uses (BYOK); absent means Twring's, as before. */
  speech?: SpeechResolver;
  /** Operator alert for a speech key store that cannot be read. */
  onError?: (error: Error, context: { requestId: string }) => void;
  /** The words a voice note to this agent should hear right, as its calls do. */
  wordsFor?: (userId: string, agentId: string) => Promise<readonly string[]>;
  filesEnabled?: boolean;
}

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
  code: ErrorCode,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
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
    { bodyLimit: 16 * 1024 },
    async (request, reply) => {
      const userId = userFor(request);
      if (!(await writable(userId, request.params.agentId, reply))) return reply;
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
        const { client_id: clientId, duration_ms: durationMs } = query.data;
        const prior = await options.store.findUserMessageByClientId(userId, agentId, clientId);
        if (prior) return reply.code(200).send({ message: threadMessageSchema.parse(prior) });
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
        if (options.speech !== undefined) {
          try {
            const resolved = await options.speech.resolve(userId);
            deepgram = resolved.deepgram;
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
              ? transcribeWithXai!(xai.apiKey, audio, contentType, words)
              : transcribe!(
                  audio,
                  contentType,
                  undefined,
                  words,
                  ...(deepgram ? [deepgram.apiKey] : []),
                )
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
      const body = approvalDecisionRequestSchema.safeParse(request.body);
      if (!body.success) return error(reply, 400, 'bad_request', 'Invalid decision.');
      if (!writes.tryAcquire(userId)) return limited(reply);
      try {
        const message = await options.service.decideApproval(
          userId,
          request.params.agentId,
          request.params.messageId,
          body.data.decision,
        );
        return { message: threadMessageSchema.parse(message) };
      } catch (cause) {
        if (cause instanceof ThreadServiceError) {
          if (cause.code === 'approval_not_found')
            return error(reply, 404, 'not_found', 'No such approval.');
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
