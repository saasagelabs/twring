import type { SpeakerLanguage } from '@twring/contracts';

import { createCartesiaTts, type CartesiaTtsOptions } from '../voice/cartesia-tts';
import { createDeepgramTts, type DeepgramTtsOptions } from '../voice/deepgram-tts';
import { createFailoverTts } from '../voice/failover-tts';
import { createXaiTts, type XaiTtsOptions } from '../voice/xai-tts';
import type { TtsProvider, VoiceError } from '../voice/types';
import type { CallLogger } from '../calls/runtime';
import type { ResolvedSpeech } from '../voice/speech-resolver';

import { CARTESIA_DEFAULT_VOICE_ID, DEEPGRAM_VOICES, cartesiaVoice, xaiVoice } from './voices';

export interface TtsRouterOptions {
  deepgram: { apiKey: string; ttsModel: string };
  /** Undefined when CARTESIA_API_KEY is not set. */
  cartesia?: { apiKey: string; ttsModel: string; ttsSpeed?: number } | undefined;
  /** Cartesia model settings for a person's own Cartesia key when the server has no key. */
  cartesiaDefaults?: { ttsModel: string; ttsSpeed?: number };
  logger?: CallLogger;
  /** Called the first time a Cartesia voice falls back because Cartesia is not configured. */
  onCartesiaFallback?: (voiceId: string) => void;
  createDeepgram?: (options: DeepgramTtsOptions) => TtsProvider;
  createCartesia?: (options: CartesiaTtsOptions) => TtsProvider;
  createXai?: (options: XaiTtsOptions) => TtsProvider;
}

export interface TtsRouter {
  /**
   * A call's TTS: never fails; an unusable voice falls back to the default Deepgram voice. Keys
   * come from `speech` when given; a provider on the person's own key never fails over.
   */
  forCall(voiceId: string, speech?: ResolvedSpeech): TtsProvider;
  /**
   * A voice sample's TTS: exactly that voice, or undefined when it cannot be spoken. Keys come
   * from `speech` when given (a person's own key for a voice the server cannot make).
   */
  forSample(voiceId: string, speech?: ResolvedSpeech): TtsProvider | undefined;
  /**
   * Exactly that voice for a call, in the person's language, or undefined when it cannot be
   * spoken. For a caller that picks its own fallback (a server on its own xAI key).
   */
  forCallVoice(voiceId: string, speech?: ResolvedSpeech): TtsProvider | undefined;
}

/** Picks the provider by voice id (ADR-020). Provider choice stays here, out of the pipeline. */
export function createTtsRouter(options: TtsRouterOptions): TtsRouter {
  const deepgram = options.createDeepgram ?? createDeepgramTts;
  const cartesia = options.createCartesia ?? createCartesiaTts;
  const xai = options.createXai ?? createXaiTts;
  let fallbackLogged = false;
  type Keys = { deepgram: string; cartesia?: string; xai?: string };
  const serverKeys: Keys = {
    deepgram: options.deepgram.apiKey,
    ...(options.cartesia && { cartesia: options.cartesia.apiKey }),
  };
  const cartesiaSettings = options.cartesia ?? options.cartesiaDefaults;
  const exact = (
    voiceId: string,
    keys: Keys = serverKeys,
    language?: SpeakerLanguage,
  ): TtsProvider | undefined => {
    if (DEEPGRAM_VOICES.some((voice) => voice.id === voiceId)) {
      return deepgram({ apiKey: keys.deepgram, model: voiceId });
    }
    const grok = xaiVoice(voiceId);
    // Grok voices exist only on the person's own xAI key; without one there is no provider.
    if (grok !== undefined) {
      return keys.xai === undefined
        ? undefined
        : xai({ apiKey: keys.xai, voice: grok, ...(language !== undefined && { language }) });
    }
    const voice = cartesiaVoice(voiceId);
    if (voice === undefined || keys.cartesia === undefined || cartesiaSettings === undefined) {
      return undefined;
    }
    return cartesia({
      apiKey: keys.cartesia,
      model: cartesiaSettings.ttsModel,
      voice,
      ...(language !== undefined && { language }),
      ...(cartesiaSettings.ttsSpeed !== undefined && { speed: cartesiaSettings.ttsSpeed }),
    });
  };
  const keysFor = (speech: ResolvedSpeech | undefined): Keys => ({
    deepgram: speech?.deepgram?.apiKey ?? serverKeys.deepgram,
    ...((speech?.cartesia?.apiKey ?? serverKeys.cartesia) !== undefined && {
      cartesia: speech?.cartesia?.apiKey ?? serverKeys.cartesia,
    }),
    ...(speech?.xai && { xai: speech.xai.apiKey }),
  });
  return {
    forCall(requestedVoiceId, speech) {
      const keys = keysFor(speech);
      const language = speech?.language;
      const canCartesia = keys.cartesia !== undefined && cartesiaSettings !== undefined;
      // Deepgram voices speak English only (ADR-036): a non-English speaker hears the default
      // Cartesia voice instead when Cartesia can speak, else the Deepgram voice as before.
      const voiceId =
        language !== undefined &&
        canCartesia &&
        DEEPGRAM_VOICES.some((voice) => voice.id === requestedVoiceId)
          ? CARTESIA_DEFAULT_VOICE_ID
          : requestedVoiceId;
      const defaultDeepgram = () =>
        deepgram({ apiKey: keys.deepgram, model: options.deepgram.ttsModel });
      const provider = exact(voiceId, keys, language);
      if (provider !== undefined) {
        // The person's own xAI key is the only xAI key: a Grok voice never fails over.
        if (xaiVoice(voiceId) !== undefined) return provider;
        const isCartesia = cartesiaVoice(voiceId) !== undefined;
        // The person's own key (ADR-037): a refusal ends the call so the phone says the key was
        // refused; any other failure (a voice their account cannot find, an outage) moves the
        // call to the default voice, on their own key for it when they have one.
        const ownKey = speech?.[isCartesia ? 'cartesia' : 'deepgram']?.source === 'own';
        const backup = isCartesia
          ? lazyBackup(defaultDeepgram)
          : canCartesia
            ? lazyBackup(() => exact(CARTESIA_DEFAULT_VOICE_ID, keys, language)!)
            : undefined;
        if (backup === undefined) return provider;
        return createFailoverTts(provider, backup, {
          ...(ownKey && { failsOver: (error: VoiceError) => error.code !== 'auth_failed' }),
          onFailover: (reason) =>
            options.logger?.warn(
              {
                event: 'tts_failover',
                from: provider.name,
                to: backup.name,
                reason_code: reason,
                own_key: ownKey,
              },
              'voice provider failover',
            ),
        });
      }
      if (cartesiaVoice(voiceId) !== undefined && !fallbackLogged) {
        fallbackLogged = true;
        options.onCartesiaFallback?.(voiceId);
      }
      return defaultDeepgram();
    },
    // Samples stay in English: they show how a voice sounds.
    forSample: (voiceId, speech) => exact(voiceId, keysFor(speech)),
    forCallVoice: (voiceId, speech) => exact(voiceId, keysFor(speech), speech?.language),
  };
}

function lazyBackup(create: () => TtsProvider): TtsProvider {
  let provider: TtsProvider | undefined;
  const get = () => (provider ??= create());
  return {
    get name() {
      return get().name;
    },
    open(onEvent, signal) {
      return get().open(onEvent, signal);
    },
  };
}
