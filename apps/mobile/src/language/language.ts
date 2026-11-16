import { SPEAKER_LANGUAGES, type SpeakerLanguage } from '@twring/contracts';

/** Each language in its own words, the way its speakers look for it. */
export const LANGUAGE_NAMES: Record<SpeakerLanguage, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  hi: 'हिन्दी',
  ru: 'Русский',
  pt: 'Português',
  ja: '日本語',
  it: 'Italiano',
  nl: 'Nederlands',
};

/** English name for screen readers set to another language. */
const ENGLISH_NAMES: Record<SpeakerLanguage, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  hi: 'Hindi',
  ru: 'Russian',
  pt: 'Portuguese',
  ja: 'Japanese',
  it: 'Italian',
  nl: 'Dutch',
};

export const LANGUAGE_EXPLANATION =
  'Twring hears you and speaks in this language. Your agent answers in whatever language it likes.';

export function languageName(language: SpeakerLanguage): string {
  return LANGUAGE_NAMES[language];
}

export function languageAccessibilityLabel(language: SpeakerLanguage): string {
  const native = LANGUAGE_NAMES[language];
  const english = ENGLISH_NAMES[language];
  return native === english ? native : `${native}, ${english}`;
}

export const ALL_LANGUAGES: readonly SpeakerLanguage[] = SPEAKER_LANGUAGES;

interface LanguageVoice {
  id: string;
  languages?: readonly string[] | undefined;
}

/** The languages a voice speaks; an older server sends none, which means English. */
export function voiceLanguages(voice: LanguageVoice): readonly string[] {
  return voice.languages ?? ['en'];
}

export function voiceSpeaks(voice: LanguageVoice, language: SpeakerLanguage): boolean {
  return voiceLanguages(voice).includes(language);
}

/** "Speaks English only" for a voice that cannot speak the person's language, else undefined. */
export function voiceLanguageNote(
  voice: LanguageVoice,
  language: SpeakerLanguage,
): string | undefined {
  if (voiceSpeaks(voice, language)) return undefined;
  const names = voiceLanguages(voice)
    .map((code) => (code in LANGUAGE_NAMES ? LANGUAGE_NAMES[code as SpeakerLanguage] : undefined))
    .filter((name): name is string => name !== undefined);
  return names.length > 0 ? `Speaks ${names.join(', ')} only` : undefined;
}

/**
 * The voices to list for someone who speaks `language`. The agent's current voice stays, first,
 * even when it cannot speak the language, so nothing changes without the person seeing it.
 */
export function voicesForLanguage<V extends LanguageVoice>(
  voices: readonly V[],
  language: SpeakerLanguage,
  current?: string,
): V[] {
  const speaking = voices.filter((voice) => voiceSpeaks(voice, language));
  const kept = voices.find((voice) => voice.id === current && !voiceSpeaks(voice, language));
  return kept === undefined ? speaking : [kept, ...speaking];
}

/** The voice a new agent starts with: the server's default when it speaks the language. */
export function defaultVoiceFor<V extends LanguageVoice>(
  voices: readonly V[],
  defaultId: string,
  language: SpeakerLanguage,
): string {
  const fallback = voices.find((voice) => voice.id === defaultId);
  if (fallback === undefined || voiceSpeaks(fallback, language)) return defaultId;
  return voices.find((voice) => voiceSpeaks(voice, language))?.id ?? defaultId;
}
