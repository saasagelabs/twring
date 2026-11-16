import { describe, expect, it } from 'vitest';
import { voiceSchema } from './agents';
import { languageSettingsSchema, SPEAKER_LANGUAGES, speakerLanguageSchema } from './language';

describe('speakerLanguageSchema', () => {
  it('accepts the ten languages', () => {
    expect(SPEAKER_LANGUAGES).toHaveLength(10);
    for (const code of SPEAKER_LANGUAGES) expect(speakerLanguageSchema.parse(code)).toBe(code);
  });
  it('rejects unknown codes', () => {
    for (const bad of ['ta', 'EN', 'en-US', '', 1, null])
      expect(speakerLanguageSchema.safeParse(bad).success).toBe(false);
  });
});

describe('languageSettingsSchema', () => {
  it('parses a language', () => {
    expect(languageSettingsSchema.parse({ language: 'hi' })).toEqual({ language: 'hi' });
  });
  it('rejects a missing or unknown language', () => {
    expect(languageSettingsSchema.safeParse({}).success).toBe(false);
    expect(languageSettingsSchema.safeParse({ language: 'xx' }).success).toBe(false);
  });
});

describe('voiceSchema languages', () => {
  it('is optional (an older server sends none)', () => {
    expect(voiceSchema.parse({ id: 'flux-haley-en', label: 'Thalia' }).languages).toBeUndefined();
  });
  it('accepts known languages and rejects unknown ones', () => {
    expect(
      voiceSchema.parse({ id: 'flux-haley-en', label: 'T', languages: ['en', 'hi'] }).languages,
    ).toEqual(['en', 'hi']);
    expect(
      voiceSchema.safeParse({ id: 'flux-haley-en', label: 'T', languages: ['ta'] }).success,
    ).toBe(false);
  });
});
