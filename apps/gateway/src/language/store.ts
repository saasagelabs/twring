import { speakerLanguageSchema, type SpeakerLanguage } from '@twring/contracts';
import { z } from 'zod';

import type { Collection } from '../store/collection';

/**
 * The language each person speaks (ADR-036), one row per person. The stored code is read loosely
 * so one bad row never breaks the file: anything that is not a known language reads as English.
 */
export const languageRecordSchema = z.object({
  user_id: z.string().min(1),
  language: z.string(),
});
export type LanguageRecord = z.infer<typeof languageRecordSchema>;

export const DEFAULT_LANGUAGE: SpeakerLanguage = 'en';

export class LanguageRepository {
  constructor(private readonly rows: Collection<LanguageRecord>) {}

  async get(userId: string): Promise<SpeakerLanguage> {
    const row = (await this.rows.read()).find((r) => r.user_id === userId);
    const parsed = speakerLanguageSchema.safeParse(row?.language);
    return parsed.success ? parsed.data : DEFAULT_LANGUAGE;
  }

  put(userId: string, language: SpeakerLanguage): Promise<SpeakerLanguage> {
    return this.rows.update((items) => ({
      items: [...items.filter((r) => r.user_id !== userId), { user_id: userId, language }],
      result: language,
    }));
  }

  deleteAllForUser(userId: string): Promise<number> {
    return this.rows.update((items) => {
      const kept = items.filter((row) => row.user_id !== userId);
      return { items: kept, result: items.length - kept.length };
    });
  }
}
