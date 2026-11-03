/**
 * Notes people send from Settings (Send feedback), kept with their email so the owner can reply.
 * Deleted with the person's data; the hourly owner email reads them (notify/feedback-digest.ts).
 */
import { randomBytes } from 'node:crypto';

import { MAX_APP_FEEDBACK_CHARS } from '@twring/contracts';
import { z } from 'zod';

import type { Collection } from '../store/collection';

/** Each person's newest notes are kept; older ones drop off. */
export const MAX_NOTES_PER_USER = 100;

export const appNoteSchema = z.object({
  id: z.string().regex(/^note_[a-z0-9]{20}$/),
  user_id: z.string().min(1),
  email: z.email().optional(),
  note: z.string().min(1).max(MAX_APP_FEEDBACK_CHARS),
  app_version: z.string().max(100).optional(),
  created_at: z.iso.datetime(),
});
export type AppNote = z.infer<typeof appNoteSchema>;

export function newNoteId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(20);
  return `note_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

export class NoteStore {
  constructor(private readonly rows: Collection<AppNote>) {}

  add(record: AppNote): Promise<void> {
    return this.rows.update((items) => {
      const mine = items
        .filter((item) => item.user_id === record.user_id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - MAX_NOTES_PER_USER)));
      return { items: [...items.filter((item) => !drop.has(item)), record], result: undefined };
    });
  }

  deleteAllForUser(userId: string): Promise<number> {
    return this.rows.update((items) => {
      const kept = items.filter((item) => item.user_id !== userId);
      return { items: kept, result: items.length - kept.length };
    });
  }
}
