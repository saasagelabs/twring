import type { DeepgramConfig } from '@twring/config/gateway';

import { createDeepgramStt, type DeepgramSttOptions } from './deepgram-stt';
import type { ResolvedSpeech } from './speech-resolver';
import type { SttProvider } from './types';
import { createXaiStt, type XaiSttOptions } from './xai-stt';

export interface CallSttOptions {
  deepgram: Pick<
    DeepgramConfig,
    'apiKey' | 'sttModel' | 'sttLanguageHints' | 'sttEotThreshold' | 'sttEotTimeoutMs'
  >;
  /** XAI_STT_* settings, used only when a person listens on their own xAI key. */
  xai: { endpointingMs: number; smartTurn?: number; smartTurnTimeoutMs?: number };
  /** Merges an agent's terms with the server's; both providers get the same list. */
  keyterms: (agentTerms: readonly string[], agentName?: string) => string[];
  createDeepgram?: (options: DeepgramSttOptions) => SttProvider;
  createXai?: (options: XaiSttOptions) => SttProvider;
}

/** Deepgram Flux model that hears the non-English languages (ADR-036). */
export const MULTILINGUAL_STT_MODEL = 'flux-general-multi';

/** A call's STT: the resolved listening provider, xAI only on the person's own xAI key. */
export function createCallStt(
  options: CallSttOptions,
): (agentTerms: readonly string[], agentName?: string, speech?: ResolvedSpeech) => SttProvider {
  const deepgram = options.createDeepgram ?? createDeepgramStt;
  const xai = options.createXai ?? createXaiStt;
  return (agentTerms, agentName, speech) => {
    const keyterms = options.keyterms(agentTerms, agentName);
    const listening = speech?.xai === undefined ? 'deepgram' : (speech.listening ?? 'deepgram');
    switch (listening) {
      case 'xai':
        return xai({
          apiKey: speech!.xai!.apiKey,
          keyterms,
          endpointingMs: options.xai.endpointingMs,
          ...(speech?.language !== undefined && { language: speech.language }),
          ...(options.xai.smartTurn !== undefined && { smartTurn: options.xai.smartTurn }),
          ...(options.xai.smartTurnTimeoutMs !== undefined && {
            smartTurnTimeoutMs: options.xai.smartTurnTimeoutMs,
          }),
        });
      case 'deepgram': {
        const config = options.deepgram;
        // A non-English speaker is heard by the multilingual model with their language as the
        // hint (ADR-036); English keeps the configured model and hints exactly.
        const language = speech?.language;
        return deepgram({
          apiKey: speech?.deepgram?.apiKey ?? config.apiKey,
          model: language === undefined ? config.sttModel : MULTILINGUAL_STT_MODEL,
          languageHints: language === undefined ? config.sttLanguageHints : [language],
          keyterms,
          ...(config.sttEotThreshold !== undefined && { eotThreshold: config.sttEotThreshold }),
          ...(config.sttEotTimeoutMs !== undefined && { eotTimeoutMs: config.sttEotTimeoutMs }),
        });
      }
      default: {
        const never: never = listening;
        return never;
      }
    }
  };
}
