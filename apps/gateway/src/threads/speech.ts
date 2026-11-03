import {
  agentIdSchema,
  threadMessageIdSchema,
  type ErrorCode,
  type ErrorResponse,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  CARTESIA_DEFAULT_VOICE_ID,
  DEEPGRAM_DEFAULT_VOICE_ID,
  DEEPGRAM_VOICES,
  XAI_DEFAULT_VOICE_ID,
  cartesiaVoice,
  xaiVoice,
} from '../agents/voices';
import { devUserResolver, type UserResolver } from '../auth';
import { SpeechTextFilter } from '../conversation/speech-text';
import { FixedWindowLimiter } from '../rate-limit';
import { StoreCorruptError } from '../store/collection';
import type { AgentRepository } from '../store/repositories';
import { CARTESIA_API_VERSION } from '../voice/cartesia-tts';
import { isKeyRefusal } from '../voice/deepgram-prerecorded';
import {
  SpeechKeyRefusedError,
  speechKeyRefusal,
  type ResolvedSpeech,
  type SpeechResolver,
} from '../voice/speech-resolver';
import { XaiSynthesisError, synthesizeWithXai } from '../voice/xai-rest';
import type { SqliteThreadStore } from './store';

const CACHE_MS = 600_000;
const TIMEOUT_MS = 20_000;
const MAX_TEXT = 3_000;

export interface MessageSpeechOptions {
  store: Pick<SqliteThreadStore, 'findMessageById'>;
  agents: Pick<AgentRepository, 'get'>;
  deepgram?: { apiKey: string };
  cartesia?: { apiKey: string; ttsModel: string; ttsSpeed?: number };
  /** Cartesia model settings for a person's own Cartesia key when the server has no key. */
  cartesiaDefaults?: { ttsModel: string; ttsSpeed?: number };
  /** Whose keys a reply is spoken with (BYOK); absent means Twring's, as before. */
  speech?: SpeechResolver;
  /** Operator alert for a speech key store that cannot be read. */
  onError?: (error: Error, context: { requestId: string }) => void;
  userFor?: UserResolver;
  fetch?: typeof fetch;
  now?: () => number;
}

function spokenText(text: string): string {
  const filter = new SpeechTextFilter();
  const cleaned = (filter.push(text) + filter.end()).trim();
  if (cleaned.length <= MAX_TEXT) return cleaned;
  const prefix = cleaned.slice(0, MAX_TEXT);
  const ends = [...prefix.matchAll(/[.!?](?=\s|$)/g)];
  const cut = ends.at(-1)?.index;
  return `${(cut === undefined ? prefix : prefix.slice(0, cut + 1)).trim()} The rest is in the chat.`;
}

/** The provider answered with an error status. */
class SpeechProviderError extends Error {
  constructor(readonly status: number) {
    super('speech provider failed');
    this.name = 'SpeechProviderError';
  }
}

export class MessageSpeech {
  private readonly cache = new Map<string, { userId: string; bytes: Buffer; expires: number }>();
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MessageSpeechOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async get(userId: string, messageId: string, voiceId: string, text: string): Promise<Buffer> {
    const key = `${userId}\0${messageId}\0${voiceId}`;
    const now = this.now();
    for (const [id, entry] of this.cache) if (entry.expires <= now) this.cache.delete(id);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.bytes;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = this.keysFor(userId)
      .then((keys) => {
        // A Grok voice without an xAI key speaks Twring's default voice instead. A server on its
        // own xAI key (no Deepgram key) speaks any voice it cannot make in its Grok voice.
        const voice =
          keys.deepgram === undefined &&
          keys.xai?.source === 'twring' &&
          !this.speakable(voiceId, keys)
            ? XAI_DEFAULT_VOICE_ID
            : xaiVoice(voiceId) !== undefined && keys.xai === undefined
              ? this.defaultVoice(keys)
              : voiceId;
        return this.synthesize(voice, text, keys).catch((error: unknown) => {
          // A refused own key stops here: no other voice, and never Twring's key.
          if (error instanceof SpeechKeyRefusedError) throw error;
          // Any failure on the person's own key stays theirs: never another provider's key.
          if (this.primaryKey(voice, keys)?.source === 'own') throw error;
          // One provider failing must not silence the reply: try the other provider's default.
          const backup = this.backupVoice(voice, keys);
          if (backup === undefined) throw error;
          return this.synthesize(backup, text, keys);
        });
      })
      .then((bytes) => {
        this.cache.set(key, { userId, bytes, expires: this.now() + CACHE_MS });
        while ([...this.cache.values()].filter((entry) => entry.userId === userId).length > 3) {
          const oldest = [...this.cache].find(([, entry]) => entry.userId === userId);
          if (oldest) this.cache.delete(oldest[0]);
        }
        while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
        return bytes;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  /** The person's keys (their own first, then Twring's); Twring's alone without a resolver. */
  private keysFor(userId: string): Promise<ResolvedSpeech> {
    if (this.options.speech !== undefined) return this.options.speech.resolve(userId);
    const { deepgram, cartesia } = this.options;
    return Promise.resolve({
      ...(deepgram && { deepgram: { apiKey: deepgram.apiKey, source: 'twring' as const } }),
      ...(cartesia && { cartesia: { apiKey: cartesia.apiKey, source: 'twring' as const } }),
    });
  }

  private cartesiaSettings(): { ttsModel: string; ttsSpeed?: number } | undefined {
    return this.options.cartesia ?? this.options.cartesiaDefaults;
  }

  /** A key (and, for Cartesia, settings) exists for the voice's provider. */
  private speakable(voiceId: string, keys: ResolvedSpeech): boolean {
    if (xaiVoice(voiceId) !== undefined) return keys.xai !== undefined;
    if (cartesiaVoice(voiceId) !== undefined)
      return keys.cartesia !== undefined && this.cartesiaSettings() !== undefined;
    return DEEPGRAM_VOICES.some((voice) => voice.id === voiceId) && keys.deepgram !== undefined;
  }

  /** The key a voice is spoken with. */
  private primaryKey(voiceId: string, keys: ResolvedSpeech) {
    if (xaiVoice(voiceId) !== undefined) return keys.xai;
    return cartesiaVoice(voiceId) !== undefined ? keys.cartesia : keys.deepgram;
  }

  /** Twring's default voice: Cartesia's when it can speak, else Deepgram's. */
  private defaultVoice(keys: ResolvedSpeech): string {
    return keys.cartesia && this.cartesiaSettings()
      ? CARTESIA_DEFAULT_VOICE_ID
      : DEEPGRAM_DEFAULT_VOICE_ID;
  }

  /** The other provider's default voice, when that provider has a key. */
  private backupVoice(voiceId: string, keys: ResolvedSpeech): string | undefined {
    if (cartesiaVoice(voiceId) !== undefined)
      return keys.deepgram ? DEEPGRAM_DEFAULT_VOICE_ID : undefined;
    return keys.cartesia && this.cartesiaSettings() ? CARTESIA_DEFAULT_VOICE_ID : undefined;
  }

  private async synthesize(voiceId: string, text: string, keys: ResolvedSpeech): Promise<Buffer> {
    const grok = xaiVoice(voiceId);
    if (grok !== undefined) {
      if (keys.xai === undefined) throw new Error('voice unavailable');
      try {
        return await synthesizeWithXai(keys.xai.apiKey, grok, text, {
          fetch: this.fetcher,
          timeoutMs: TIMEOUT_MS,
        });
      } catch (error) {
        // A refusal of the person's own key is theirs to fix; the server's key is not.
        if (
          keys.xai.source === 'own' &&
          error instanceof XaiSynthesisError &&
          isKeyRefusal(error.status)
        )
          throw new SpeechKeyRefusedError('xai');
        throw error;
      }
    }
    let url: string;
    let headers: Record<string, string>;
    let body: object;
    let source: 'own' | 'twring';
    let provider: 'deepgram' | 'cartesia';
    const cartesia = cartesiaVoice(voiceId);
    const settings = this.cartesiaSettings();
    if (cartesia && keys.cartesia && settings) {
      source = keys.cartesia.source;
      provider = 'cartesia';
      url = 'https://api.cartesia.ai/tts/bytes';
      headers = {
        Authorization: `Bearer ${keys.cartesia.apiKey}`,
        'Cartesia-Version': CARTESIA_API_VERSION,
        'Content-Type': 'application/json',
      };
      body = {
        model_id: settings.ttsModel,
        transcript: text,
        voice: { mode: 'id', id: cartesia.voiceUuid },
        output_format: { container: 'mp3', bit_rate: 128000, sample_rate: 44100 },
        locale: cartesia.locale,
        ...(settings.ttsSpeed !== undefined &&
          settings.ttsSpeed !== 1 && {
            generation_config: { speed: settings.ttsSpeed },
          }),
      };
    } else if (DEEPGRAM_VOICES.some((voice) => voice.id === voiceId) && keys.deepgram) {
      source = keys.deepgram.source;
      provider = 'deepgram';
      // Our Deepgram voices are Flux models, which only `/v2/speak` serves (checked 2026-10-14:
      // `/v1/speak` answers 400 V2_MODEL_ON_V1_SPEAK_ENDPOINT; `/v2/speak` returns MP3).
      url = `https://api.deepgram.com/v2/speak?model=${encodeURIComponent(voiceId)}&encoding=mp3`;
      headers = {
        Authorization: `Token ${keys.deepgram.apiKey}`,
        'Content-Type': 'application/json',
      };
      body = { text };
    } else {
      throw new Error('voice unavailable');
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bytes = await Promise.race([
        this.fetcher(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok) {
            if (source === 'own' && isKeyRefusal(response.status))
              throw new SpeechKeyRefusedError(provider);
            throw new SpeechProviderError(response.status);
          }
          return Buffer.from(await response.arrayBuffer());
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('speech timeout'));
          }, TIMEOUT_MS);
        }),
      ]);
      if (bytes.length === 0) throw new Error('empty speech response');
      return bytes;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}

function error(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message?: string,
): FastifyReply {
  const body: ErrorResponse = {
    error: {
      code,
      message:
        message ??
        (status === 502
          ? 'Could not play this reply.'
          : status === 429
            ? 'Too many requests. Try again later.'
            : 'No such message.'),
      request_id: reply.request.id,
    },
  };
  return reply.code(status).send(body);
}

export function registerMessageSpeechRoute(
  app: FastifyInstance,
  options: MessageSpeechOptions,
): void {
  const userFor = options.userFor ?? devUserResolver;
  const limiter = new FixedWindowLimiter(20, 60_000);
  const speech = new MessageSpeech(options);
  app.get<{ Params: { agentId: string; messageId: string } }>(
    '/v1/agents/:agentId/messages/:messageId/speech',
    async (request, reply) => {
      const userId = userFor(request);
      const { agentId, messageId } = request.params;
      if (
        !agentIdSchema.safeParse(agentId).success ||
        !threadMessageIdSchema.safeParse(messageId).success
      )
        return error(reply, 404, 'not_found');
      const agent = await options.agents.get(userId, agentId);
      if (!agent) return error(reply, 404, 'not_found');
      const message = await options.store.findMessageById(userId, agentId, messageId);
      if (message?.kind !== 'agent_text') return error(reply, 404, 'not_found');
      const text = spokenText(message.text);
      if (!text) return error(reply, 404, 'not_found');
      if (!limiter.tryAcquire(userId)) return error(reply, 429, 'rate_limited');
      try {
        const audio = await speech.get(userId, messageId, agent.voice_id, text);
        return reply.header('Cache-Control', 'private, max-age=600').type('audio/mpeg').send(audio);
      } catch (cause) {
        if (cause instanceof StoreCorruptError) {
          // Fail closed, as calls do: nobody can tell whose key is their own. No path, no key.
          const safeError = new Error('speech key store unreadable');
          safeError.name = 'SpeechKeysUnavailable';
          request.log.error({ event: 'speech_keys_unavailable' }, 'speech key store unreadable');
          options.onError?.(safeError, { requestId: request.id });
          return error(
            reply,
            503,
            'service_unavailable',
            'Voice is briefly unavailable. Try again in a moment.',
          );
        }
        const refusal = speechKeyRefusal(cause);
        if (refusal) return error(reply, refusal.status, refusal.code, refusal.message);
        return error(reply, 502, 'service_unavailable');
      }
    },
  );
}
