import {
  speechKeyPutRequestSchema,
  speechListeningPutRequestSchema,
  speechProviderSchema,
  type ErrorCode,
  type ErrorResponse,
  type ListeningProvider,
  type SpeechKeyListResponse,
  type SpeechProvider,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import { StoreCorruptError } from '../store/collection';
import type { SpeechKeyVault } from '../store/speech-keys';
import type { checkSpeechKey } from '../voice/key-check';
import { UserDeletions } from './user-deletions';

export interface SpeechKeyRoutesOptions {
  vault: SpeechKeyVault;
  /**
   * The switch (SPEECH_KEYS_ENABLED): off, list and save answer 404 `speech_keys_disabled`;
   * delete still works so a key saved while it was on can be removed.
   */
  enabled: boolean;
  /** Key saves; low, because each save asks the provider and could be used to guess keys. */
  writeRatePerMinute: number;
  /** Listening switches; no provider is asked, so a person can switch freely. Default 30. */
  listeningRatePerMinute?: number;
  /** Asks the provider whether the key works; tests inject a fake so no network is used. */
  check: typeof checkSpeechKey;
  userFor?: UserResolver;
  /** Shared with Delete my data, so a save that overlaps a deletion is dropped. */
  deletions?: UserDeletions;
}

const PROVIDER_LABELS: Record<SpeechProvider, string> = {
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
  xai: 'xAI',
};

const LISTENING_ARTICLE: Record<ListeningProvider, string> = {
  deepgram: 'a Deepgram',
  xai: 'an xAI',
};

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
 * A person's own Deepgram, Cartesia and xAI keys (BYOK) and which of Deepgram or xAI listens. A key is checked with its provider before it
 * is sealed and stored; it is never returned (only its last four) and never logged.
 */
export function registerSpeechKeyRoutes(
  app: FastifyInstance,
  options: SpeechKeyRoutesOptions,
): void {
  const { vault } = options;
  const deletions = options.deletions ?? new UserDeletions();
  const userFor = options.userFor ?? devUserResolver;
  const writeLimiter = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const listeningLimiter = new FixedWindowLimiter(options.listeningRatePerMinute ?? 30, 60_000);

  const disabled = (reply: FastifyReply): FastifyReply =>
    sendError(reply, 404, 'speech_keys_disabled', 'Your own voice keys are not available yet.');

  async function listFor(userId: string): Promise<SpeechKeyListResponse> {
    const saved = await vault.list(userId);
    const has = (provider: SpeechProvider): boolean =>
      saved.some((entry) => entry.provider === provider);
    return {
      listening: await vault.getListening(userId),
      // The choice is the person's only when both listening accounts have a key.
      listening_choice: has('deepgram') && has('xai'),
      providers: speechProviderSchema.options.map((provider) => {
        const row = saved.find((entry) => entry.provider === provider);
        return {
          provider,
          added:
            row === undefined
              ? null
              : { last4: row.last4, added_at: row.added_at, verified_at: row.verified_at },
        };
      }),
    };
  }

  app.get('/v1/me/speech-keys', async (request, reply) => {
    if (!options.enabled) return disabled(reply);
    return listFor(userFor(request));
  });

  // Registered before `/:provider` so "listening" is never read as a provider.
  app.put('/v1/me/speech-keys/listening', { bodyLimit: 1024 }, async (request, reply) => {
    if (!options.enabled) return disabled(reply);
    const userId = userFor(request);
    const since = deletions.epoch(userId);
    if (!listeningLimiter.tryAcquire(rateKey(request, userFor))) {
      return sendError(
        reply,
        429,
        'rate_limited',
        'Too many requests. Wait a minute and try again.',
      );
    }
    const parsed = speechListeningPutRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'Choose Deepgram or xAI.');
    }
    const provider = parsed.data.provider;
    const saved = await vault.list(userId);
    if (!saved.some((entry) => entry.provider === provider)) {
      return sendError(reply, 400, 'bad_request', `Add ${LISTENING_ARTICLE[provider]} key first.`);
    }
    // Delete my data since the key list was read must not be undone by this write.
    if (deletions.interrupted(userId, since)) {
      return sendError(
        reply,
        409,
        'speech_key_check_failed',
        "Couldn't save the choice. Try again.",
      );
    }
    try {
      await vault.setListening(userId, provider);
    } catch (error) {
      if (!(error instanceof StoreCorruptError)) throw error;
      request.log.warn({ event: 'speech_settings_unreadable' }, 'speech settings unreadable');
      return sendError(
        reply,
        503,
        'service_unavailable',
        "Couldn't save the choice. Try again later.",
      );
    }
    return listFor(userId);
  });

  app.put<{ Params: { provider: string } }>(
    '/v1/me/speech-keys/:provider',
    { bodyLimit: 1024 },
    async (request, reply) => {
      if (!options.enabled) return disabled(reply);
      const userId = userFor(request);
      const provider = speechProviderSchema.safeParse(request.params.provider);
      if (!provider.success) return sendError(reply, 404, 'not_found', 'No such voice provider.');
      if (!writeLimiter.tryAcquire(rateKey(request, userFor))) {
        return sendError(
          reply,
          429,
          'rate_limited',
          'Too many requests. Wait a minute and try again.',
        );
      }
      const parsed = speechKeyPutRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'speech_key_invalid',
          "That doesn't look like a key. Paste it again.",
        );
      }
      const label = PROVIDER_LABELS[provider.data];
      const since = deletions.epoch(userId);
      const result = await options.check(provider.data, parsed.data.key);
      if (result === 'refused') {
        return sendError(
          reply,
          422,
          'speech_key_refused',
          `${label} refused this key. Check it in your ${label} account.`,
        );
      }
      if (result === 'unavailable') {
        return sendError(
          reply,
          503,
          'speech_key_check_failed',
          `Couldn't reach ${label} to check the key. Try again.`,
        );
      }
      // The check can take seconds; Delete my data in that window must not be undone by this save.
      if (deletions.interrupted(userId, since)) {
        return sendError(
          reply,
          409,
          'speech_key_check_failed',
          "Couldn't save the key. Try again.",
        );
      }
      await vault.put(userId, provider.data, parsed.data.key, new Date());
      request.log.info({ event: 'speech_key_saved', provider: provider.data }, 'speech key saved');
      return listFor(userId);
    },
  );

  app.delete<{ Params: { provider: string } }>(
    '/v1/me/speech-keys/:provider',
    async (request, reply) => {
      const userId = userFor(request);
      const provider = speechProviderSchema.safeParse(request.params.provider);
      if (!provider.success) return sendError(reply, 404, 'not_found', 'No such voice provider.');
      await vault.delete(userId, provider.data);
      return reply.code(204).send();
    },
  );
}
