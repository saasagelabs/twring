import type { Voice, VoiceListResponse } from '@twring/contracts';

import type { CartesiaVoice } from '../voice/cartesia-tts';
import type { XaiVoice } from '../voice/xai-tts';

/**
 * The Flux TTS voices an agent may use (developers.deepgram.com/docs/flux-tts/voices). Server-owned
 * and deliberately short: a voice id is sent to Deepgram only if it is on this list.
 */
export const DEEPGRAM_VOICES: readonly Voice[] = [
  { id: 'flux-haley-en', label: 'Haley · American' },
  { id: 'flux-hannah-en', label: 'Hannah · American' },
  { id: 'flux-cliff-en', label: 'Cliff · American' },
  { id: 'flux-miles-en', label: 'Miles · American' },
  { id: 'flux-gemma-en', label: 'Gemma · British' },
  { id: 'flux-kit-en', label: 'Kit · British' },
  { id: 'flux-priya-en', label: 'Priya · Indian' },
  { id: 'flux-naveen-en', label: 'Naveen · Indian' },
];

interface CartesiaVoiceEntry extends Voice, CartesiaVoice {}

/**
 * Cartesia Sonic voices (ADR-020), offered only when CARTESIA_API_KEY is set. Twring ids map to
 * Cartesia voice UUIDs here, server-side; the app never sees a UUID. These UUIDs are the voices
 * Cartesia's docs recommend for voice agents
 * (https://docs.cartesia.ai/build-with-cartesia/tts-models/latest).
 */
const CARTESIA_VERIFIED_VOICES: readonly CartesiaVoiceEntry[] = [
  {
    id: 'cartesia-skylar-en',
    label: 'Skylar · American',
    voiceUuid: 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
    locale: 'en-US',
  },
  {
    id: 'cartesia-daniel-en',
    label: 'Daniel · American',
    voiceUuid: '47c38ca4-5f35-497b-b1a3-415245fb35e1',
    locale: 'en-US',
  },
  {
    id: 'cartesia-archie-en',
    label: 'Archie · British',
    voiceUuid: 'ef191366-f52f-447a-a398-ed8c0f2943a1',
    locale: 'en-GB',
  },
];

/**
 * Native Indian English voices (accent `en-IN/indian-english`), checked against the live
 * `GET /voices` library on 2026-09-29. Cartesia's "Priya" is left out: Deepgram already has a
 * "Priya · Indian".
 */
const CARTESIA_INDIAN_VOICES: readonly CartesiaVoiceEntry[] = [
  {
    id: 'cartesia-janvi-en',
    label: 'Janvi · Indian',
    voiceUuid: '7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8',
    locale: 'en-IN',
  },
  {
    id: 'cartesia-devansh-en',
    label: 'Devansh · Indian',
    voiceUuid: '1259b7e3-cb8a-43df-9446-30971a46b8b0',
    locale: 'en-IN',
  },
];

export const CARTESIA_VOICES: readonly CartesiaVoiceEntry[] = [
  ...CARTESIA_INDIAN_VOICES,
  ...CARTESIA_VERIFIED_VOICES,
];

interface XaiVoiceEntry extends Voice {
  xaiVoice: XaiVoice;
}

/**
 * xAI Grok voices, offered to a person with their own xAI key, and on a self-hosted server that
 * speaks on its own xAI key (hosted Twring has none).
 */
export const XAI_VOICES: readonly XaiVoiceEntry[] = [
  { id: 'xai-eve-en', label: 'Eve · Grok', xaiVoice: 'eve' },
  { id: 'xai-ara-en', label: 'Ara · Grok', xaiVoice: 'ara' },
  { id: 'xai-rex-en', label: 'Rex · Grok', xaiVoice: 'rex' },
  { id: 'xai-sal-en', label: 'Sal · Grok', xaiVoice: 'sal' },
  { id: 'xai-leo-en', label: 'Leo · Grok', xaiVoice: 'leo' },
];

/** Every voice Twring knows, whichever provider speaks it. */
export const VOICES: readonly Voice[] = [
  ...DEEPGRAM_VOICES,
  ...CARTESIA_VOICES.map(({ id, label }) => ({ id, label })),
  ...XAI_VOICES.map(({ id, label }) => ({ id, label })),
];

/** Default when Cartesia is not configured. */
export const DEEPGRAM_DEFAULT_VOICE_ID = 'flux-haley-en';
/** Default on a self-hosted server that speaks on its own xAI key. */
export const XAI_DEFAULT_VOICE_ID = 'xai-eve-en';
/** Default when Cartesia is configured (ADR-022: lowest first-audio latency measured on staging). */
export const CARTESIA_DEFAULT_VOICE_ID = 'cartesia-janvi-en';

/** The gate: a voice id reaches a provider only if it is on one of the lists above. */
export function isAllowedVoice(voiceId: string): boolean {
  return VOICES.some((voice) => voice.id === voiceId);
}

/** The Cartesia voice for a Twring id, or undefined when the id is not a Cartesia voice. */
export function cartesiaVoice(voiceId: string): CartesiaVoice | undefined {
  const entry = CARTESIA_VOICES.find((voice) => voice.id === voiceId);
  return entry && { voiceUuid: entry.voiceUuid, locale: entry.locale };
}

/** The xAI voice for a Twring id, or undefined when the id is not a Grok voice. */
export function xaiVoice(voiceId: string): XaiVoice | undefined {
  return XAI_VOICES.find((voice) => voice.id === voiceId)?.xaiVoice;
}

export interface VoiceListOptions {
  /** CARTESIA_API_KEY is set: offer the Cartesia voices too. */
  cartesia: boolean;
  /** The caller has their own xAI key: offer the Grok voices too. */
  xai?: boolean;
  /**
   * A self-hosted server on its own xAI key (no Deepgram key): the Grok voices are offered with
   * Eve as the default, and the Deepgram voices only when `deepgram` says someone can speak them.
   */
  xaiServer?: boolean;
  /** With `xaiServer`: the caller has their own Deepgram key. */
  deepgram?: boolean;
}

/** The voice a new agent gets when it names none. Existing agents keep their saved voice. */
export function defaultVoiceId(options: VoiceListOptions = { cartesia: false }): string {
  if (options.xaiServer) return XAI_DEFAULT_VOICE_ID;
  return options.cartesia ? CARTESIA_DEFAULT_VOICE_ID : DEEPGRAM_DEFAULT_VOICE_ID;
}

export function voiceList(options: VoiceListOptions = { cartesia: false }): VoiceListResponse {
  const deepgram = options.xaiServer && !options.deepgram ? [] : DEEPGRAM_VOICES;
  const cartesia = options.cartesia
    ? CARTESIA_VOICES.map(({ id, label }): Voice => ({ id, label }))
    : [];
  const xai =
    options.xai || options.xaiServer
      ? XAI_VOICES.map(({ id, label }): Voice => ({ id, label }))
      : [];
  return {
    voices: [...deepgram, ...cartesia, ...xai],
    default_voice_id: defaultVoiceId(options),
  };
}
