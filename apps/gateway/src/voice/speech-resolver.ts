import type { ListeningProvider, SpeechProvider } from '@twring/contracts';

import { CredentialDecryptError } from '../store/cipher';
import type { SpeechKeyVault } from '../store/speech-keys';

/** One provider's key for a call, and whose it is. The key never leaves the server. */
export interface ProviderSpeech {
  apiKey: string;
  source: 'own' | 'twring';
}

/** The keys a call speaks with; a provider is absent when nobody has a key for it. */
export interface ResolvedSpeech {
  deepgram?: ProviderSpeech;
  cartesia?: ProviderSpeech;
  /**
   * The person's own key, or (`twring`) the server's own xAI key on a self-hosted server that
   * speaks with xAI only. Hosted Twring has no xAI account.
   */
  xai?: ProviderSpeech;
  /** Which provider hears the call; absent means Deepgram. */
  listening?: ListeningProvider;
}

/** The person's saved key exists but cannot be opened: the call must not start. */
export class SpeechKeyUnreadableError extends Error {
  constructor(readonly provider: SpeechProvider) {
    super(`saved ${provider} key could not be read`);
    this.name = 'SpeechKeyUnreadableError';
  }
}

/** The provider refused the person's own key: the work stops; Twring's key is never used. */
export class SpeechKeyRefusedError extends Error {
  constructor(readonly provider: SpeechProvider) {
    super(`own ${provider} key refused`);
    this.name = 'SpeechKeyRefusedError';
  }
}

export const SPEECH_PROVIDER_NAMES = {
  deepgram: 'Deepgram',
  cartesia: 'Cartesia',
  xai: 'xAI',
} as const;

/** What a route answers when the person's keys stop the work; undefined for any other error. */
export function speechKeyRefusal(
  error: unknown,
):
  | { status: 409; code: 'speech_key_refused' | 'speech_key_unreadable'; message: string }
  | undefined {
  if (error instanceof SpeechKeyRefusedError)
    return {
      status: 409,
      code: 'speech_key_refused',
      message: `Your ${SPEECH_PROVIDER_NAMES[error.provider]} key was refused. Update it in Settings.`,
    };
  if (error instanceof SpeechKeyUnreadableError)
    return {
      status: 409,
      code: 'speech_key_unreadable',
      message: `Couldn't read your saved ${SPEECH_PROVIDER_NAMES[error.provider]} key. Add it again in Settings.`,
    };
  return undefined;
}

export interface SpeechResolver {
  resolve(userId: string): Promise<ResolvedSpeech>;
}

const PROVIDERS: readonly SpeechProvider[] = ['deepgram', 'cartesia', 'xai'];

/**
 * Picks each provider's key for a person's call: their own saved key wins; otherwise Twring's.
 * With the switch off (or no vault) every call uses Twring's keys, exactly as before BYOK.
 */
export function createSpeechResolver(options: {
  enabled: boolean;
  vault?: SpeechKeyVault;
  deepgram?: { apiKey: string };
  cartesia?: { apiKey: string };
  /** The server's own xAI key: only a self-hosted server with no Deepgram key (`serverXaiKey`). */
  xai?: { apiKey: string };
}): SpeechResolver {
  const twring = (provider: SpeechProvider): ProviderSpeech | undefined => {
    const apiKey = options[provider]?.apiKey;
    return apiKey === undefined ? undefined : { apiKey, source: 'twring' };
  };
  return {
    async resolve(userId) {
      const { vault } = options;
      const resolved: ResolvedSpeech = {};
      for (const provider of PROVIDERS) {
        let own: string | undefined;
        if (options.enabled && vault !== undefined) {
          try {
            own = await vault.get(userId, provider);
          } catch (error) {
            if (error instanceof CredentialDecryptError)
              throw new SpeechKeyUnreadableError(provider);
            throw error;
          }
        }
        const speech =
          own === undefined ? twring(provider) : { apiKey: own, source: 'own' as const };
        if (speech !== undefined) resolved[provider] = speech;
      }
      // The saved choice counts only while its key is here (the vault already checks; a key
      // removed between the two reads still falls back to Deepgram).
      const choice =
        options.enabled && vault !== undefined ? await vault.getListening(userId) : 'deepgram';
      resolved.listening = choice === 'xai' && resolved.xai !== undefined ? 'xai' : 'deepgram';
      // A server on its own xAI key hears on xAI unless the person's own Deepgram key is here.
      if (options.xai !== undefined && resolved.deepgram === undefined) resolved.listening = 'xai';
      return resolved;
    },
  };
}
