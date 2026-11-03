import { DECLINE_NOTE_MAX } from './protocol';

/** The quick-decline chips; `note` is what the agent receives. */
export const QUICK_REPLIES = [
  { label: 'Busy', note: 'busy' },
  { label: 'Outside', note: 'outside' },
  { label: "Let's text", note: 'text' },
] as const;

export type NoteCheck =
  { ok: true; note: string } | { ok: false; reason: 'empty' | 'too_long'; length: number };

/** A typed reply: one line, trimmed, at most 60 characters. */
export function checkNote(text: string): NoteCheck {
  const note = text
    // eslint-disable-next-line no-control-regex -- strip control characters from pasted text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (note === '') return { ok: false, reason: 'empty', length: 0 };
  const length = [...note].length;
  if (length > DECLINE_NOTE_MAX || note.length > DECLINE_NOTE_MAX) {
    return { ok: false, reason: 'too_long', length };
  }
  return { ok: true, note };
}

/** "12 characters left" under the reply field. */
export function charactersLeft(text: string): number {
  return DECLINE_NOTE_MAX - text.length;
}
