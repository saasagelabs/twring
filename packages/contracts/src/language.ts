import { z } from 'zod';

/**
 * The language a person speaks (ADR-036). One per person: Twring hears them and speaks the agent's
 * replies in it. These are the languages Deepgram `flux-general-multi` hears; English stays on the
 * English model.
 */
export const SPEAKER_LANGUAGES = [
  'en',
  'es',
  'fr',
  'de',
  'hi',
  'ru',
  'pt',
  'ja',
  'it',
  'nl',
] as const;
export const speakerLanguageSchema = z.enum(SPEAKER_LANGUAGES);
export type SpeakerLanguage = z.infer<typeof speakerLanguageSchema>;

/** `GET` / `PUT /v1/me/language`. */
export const languageSettingsSchema = z.object({ language: speakerLanguageSchema });
export type LanguageSettings = z.infer<typeof languageSettingsSchema>;
