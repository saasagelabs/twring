import { INTERRUPTION_KEYTERMS, type GatewayEnv } from '@twring/config/gateway';

import type { TtsRouter } from '../agents/tts-router';
import { DEEPGRAM_VOICES, cartesiaVoice, xaiVoice } from '../agents/voices';

import { createFailoverTts } from './failover-tts';

import { PrerecordedTranscriptionError } from './deepgram-prerecorded';
import type { ResolvedSpeech } from './speech-resolver';
import type { SttProvider, TtsProvider } from './types';
import { createXaiStt, type XaiSttOptions } from './xai-stt';
import { createXaiTts, type XaiTtsOptions, type XaiVoice } from './xai-tts';

/** The voice a call speaks in when its agent's voice is not a Grok voice. */
export const SERVER_XAI_DEFAULT_VOICE: XaiVoice = 'eve';

/**
 * The server's own xAI key, when it speaks with xAI: self-hosted, with an xAI key and no Deepgram
 * key. With both keys Deepgram is used, as on hosted Twring (which never uses this).
 */
export function serverXaiKey(
  env: Pick<GatewayEnv, 'TWRING_MODE' | 'DEEPGRAM_API_KEY' | 'XAI_API_KEY'>,
): string | undefined {
  if (env.TWRING_MODE !== 'selfhost' || env.DEEPGRAM_API_KEY !== undefined) return undefined;
  return env.XAI_API_KEY;
}

export interface ServerXaiVoiceOptions {
  apiKey: string;
  /** XAI_STT_* settings. */
  stt: { endpointingMs: number; smartTurn?: number; smartTurnTimeoutMs?: number };
  createStt?: (options: XaiSttOptions) => SttProvider;
  createTts?: (options: XaiTtsOptions) => TtsProvider;
  /**
   * The person's own Deepgram/Cartesia keys and the server's Cartesia key: Deepgram listening on
   * an own Deepgram key, and voices spoken exactly (`forSample`) on the key `speech` names.
   */
  ownKeys?: {
    stt: (keyterms: readonly string[], agentName?: string, speech?: ResolvedSpeech) => SttProvider;
    tts: Pick<TtsRouter, 'forSample'>;
  };
  logger?: { warn(fields: object, message: string): void };
}

/**
 * Which provider speaks a voice on a server on its own xAI key: a Grok voice on xAI; a Cartesia
 * voice on any Cartesia key (own or server); a Deepgram voice on an own Deepgram key; anything
 * else in the server's Grok voice. The call registry blames refusals by this.
 */
export function serverXaiTtsSide(
  voiceId: string,
  speech: ResolvedSpeech | undefined,
): 'xai' | 'deepgram' | 'cartesia' {
  if (xaiVoice(voiceId) !== undefined) return 'xai';
  if (cartesiaVoice(voiceId) !== undefined && speech?.cartesia !== undefined) return 'cartesia';
  if (DEEPGRAM_VOICES.some((voice) => voice.id === voiceId) && speech?.deepgram !== undefined)
    return 'deepgram';
  return 'xai';
}

/** Deepgram listening on the person's own Deepgram key, when they chose it. */
export function serverXaiListensOnDeepgram(speech: ResolvedSpeech | undefined): boolean {
  return speech?.listening === 'deepgram' && speech.deepgram?.source === 'own';
}

export interface ServerCallVoice {
  /** Tells the call registry who to blame for a refused key (`ownKeySides`). */
  speaksServerXai: true;
  voice: { stt: SttProvider; tts: TtsProvider };
  sttForKeyterms: (
    keyterms: readonly string[],
    agentName?: string,
    speech?: ResolvedSpeech,
  ) => SttProvider;
  ttsForVoice: (voiceId: string, speech?: ResolvedSpeech) => TtsProvider;
}

/**
 * A self-hosted server's calls on its own xAI key: xAI listens, and speaks in the agent's Grok
 * voice; with `ownKeys`, own Deepgram listening and own or server-Cartesia voices are honoured as
 * on hosted (`serverXaiTtsSide`); any voice nobody can speak is the default Grok voice. A person's own xAI key speaks instead
 * when they saved one, and listens when they also chose xAI listening.
 */
export function serverXaiCallVoice(options: ServerXaiVoiceOptions): ServerCallVoice {
  const stt = options.createStt ?? createXaiStt;
  const tts = options.createTts ?? createXaiTts;
  const keyFor = (speech?: ResolvedSpeech) => speech?.xai?.apiKey ?? options.apiKey;
  // An own xAI key hears the call only when the person chose xAI listening.
  const listenKeyFor = (speech?: ResolvedSpeech) =>
    speech?.listening === 'xai' ? keyFor(speech) : options.apiKey;
  const listen = (keyterms: readonly string[], speech?: ResolvedSpeech) =>
    stt({
      apiKey: listenKeyFor(speech),
      keyterms,
      endpointingMs: options.stt.endpointingMs,
      ...(options.stt.smartTurn !== undefined && { smartTurn: options.stt.smartTurn }),
      ...(options.stt.smartTurnTimeoutMs !== undefined && {
        smartTurnTimeoutMs: options.stt.smartTurnTimeoutMs,
      }),
    });
  const speak = (voiceId: string | undefined, speech?: ResolvedSpeech) =>
    tts({
      apiKey: keyFor(speech),
      voice: (voiceId === undefined ? undefined : xaiVoice(voiceId)) ?? SERVER_XAI_DEFAULT_VOICE,
    });
  const own = options.ownKeys;
  const speakFor = (voiceId: string, speech?: ResolvedSpeech): TtsProvider => {
    const side = own === undefined ? 'xai' : serverXaiTtsSide(voiceId, speech);
    if (side === 'xai' || own === undefined) return speak(voiceId, speech);
    const provider = own.tts.forSample(voiceId, speech);
    if (provider === undefined) return speak(voiceId, speech);
    // The person's own key never fails over; the server's Cartesia key falls back to Eve.
    if (speech?.[side]?.source === 'own') return provider;
    const backup = speak(undefined, speech);
    return createFailoverTts(provider, backup, {
      onFailover: (reason) =>
        options.logger?.warn(
          { event: 'tts_failover', from: provider.name, to: backup.name, reason_code: reason },
          'voice provider failover',
        ),
    });
  };
  return {
    speaksServerXai: true,
    voice: { stt: listen(INTERRUPTION_KEYTERMS), tts: speak(undefined) },
    sttForKeyterms: (agentTerms, agentName, speech) =>
      own !== undefined && serverXaiListensOnDeepgram(speech)
        ? own.stt(agentTerms, agentName, speech)
        : listen(
            [
              ...INTERRUPTION_KEYTERMS,
              ...agentTerms,
              ...(agentName === undefined ? [] : [agentName]),
            ],
            speech,
          ),
    ttsForVoice: speakFor,
  };
}

type DeepgramNoteTranscriber = (
  audio: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
  keyterms?: readonly string[],
  apiKey?: string,
) => Promise<string>;

/**
 * Deepgram voice notes on a server with no Deepgram key: only ever on the person's own key (their
 * Deepgram listening choice); without one the note fails as a server failure, never as theirs.
 */
export function ownDeepgramKeyOnly(transcribe: DeepgramNoteTranscriber): DeepgramNoteTranscriber {
  return (audio, contentType, signal, keyterms, apiKey) =>
    apiKey === undefined
      ? Promise.reject(new PrerecordedTranscriptionError('provider_failure'))
      : transcribe(audio, contentType, signal, keyterms, apiKey);
}

/**
 * Voice samples on a server's own xAI key: a Grok voice on the person's own xAI key when given,
 * else the server's; any other voice through `others` (the person's own keys only).
 */
export function serverXaiSampleRouter(
  apiKey: string,
  others: Pick<TtsRouter, 'forSample'>,
  createTts: (options: XaiTtsOptions) => TtsProvider = createXaiTts,
): Pick<TtsRouter, 'forSample'> {
  return {
    forSample(voiceId, speech) {
      const grok = xaiVoice(voiceId);
      if (grok === undefined) return others.forSample(voiceId, speech);
      return createTts({ apiKey: speech?.xai?.apiKey ?? apiKey, voice: grok });
    },
  };
}
