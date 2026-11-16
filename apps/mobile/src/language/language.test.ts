import { SPEAKER_LANGUAGES } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  defaultVoiceFor,
  languageAccessibilityLabel,
  languageName,
  voiceLanguageNote,
  voicesForLanguage,
} from './language';

const VOICES = [
  { id: 'aura-thalia-en', label: 'Thalia', languages: ['en'] },
  { id: 'aura-luna-en', label: 'Luna' },
  { id: 'cartesia-a', label: 'A', languages: ['en', 'hi', 'es'] },
  { id: 'cartesia-b', label: 'B', languages: ['hi'] },
];

describe('language names', () => {
  it('names all ten languages in their own words', () => {
    for (const code of SPEAKER_LANGUAGES) expect(languageName(code)).toBeTruthy();
    expect(new Set(SPEAKER_LANGUAGES.map(languageName)).size).toBe(10);
    expect(languageName('hi')).toBe('हिन्दी');
    expect(languageName('ja')).toBe('日本語');
    expect(languageAccessibilityLabel('de')).toBe('Deutsch, German');
    expect(languageAccessibilityLabel('en')).toBe('English');
  });
});

describe('voicesForLanguage', () => {
  it('leaves the English list unchanged', () => {
    expect(voicesForLanguage(VOICES, 'en').map((v) => v.id)).toEqual([
      'aura-thalia-en',
      'aura-luna-en',
      'cartesia-a',
    ]);
    const old = VOICES.slice(0, 2);
    expect(voicesForLanguage(old, 'en')).toEqual(old);
  });

  it('drops English-only voices for Hindi, counting a missing list as English', () => {
    expect(voicesForLanguage(VOICES, 'hi').map((v) => v.id)).toEqual(['cartesia-a', 'cartesia-b']);
  });

  it('keeps the current voice first when it cannot speak the language', () => {
    expect(voicesForLanguage(VOICES, 'hi', 'aura-luna-en').map((v) => v.id)).toEqual([
      'aura-luna-en',
      'cartesia-a',
      'cartesia-b',
    ]);
    expect(voicesForLanguage(VOICES, 'hi', 'cartesia-b').map((v) => v.id)).toEqual([
      'cartesia-a',
      'cartesia-b',
    ]);
  });

  it('notes a voice that cannot speak the language', () => {
    expect(voiceLanguageNote(VOICES[1], 'hi')).toBe('Speaks English only');
    expect(voiceLanguageNote(VOICES[2], 'hi')).toBeUndefined();
  });

  it('picks a default that speaks the language', () => {
    expect(defaultVoiceFor(VOICES, 'aura-thalia-en', 'en')).toBe('aura-thalia-en');
    expect(defaultVoiceFor(VOICES, 'aura-thalia-en', 'hi')).toBe('cartesia-a');
    expect(defaultVoiceFor(VOICES, 'aura-thalia-en', 'ja')).toBe('aura-thalia-en');
  });
});
