/**
 * Post-call feedback that needs a person to read it (a written note, or 1 to 3 stars) reaches the
 * owner in one email every round, instead of waiting for a manual export.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { feedbackRecordSchema, type FeedbackRecord } from '../calls/feedback-store';
import { appNoteSchema, type AppNote } from '../me/notes';
import type { OutgoingEmail, SendResult } from '../waitlist/invite-flow';

/** How often new feedback is checked. */
// Hourly: at most 24 emails a day, leaving the shared email allowance for invites and alerts.
export const FEEDBACK_DIGEST_EVERY_MS = 60 * 60_000;

const ISSUE_WORDS: Record<FeedbackRecord['issues'][number], string> = {
  cut_off: 'cut me off',
  misheard: 'misheard me',
  slow: 'slow replies',
};

function worthReading(record: FeedbackRecord): boolean {
  return (record.note ?? '').trim().length > 0 || record.rating <= 3;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function feedbackEmail(
  items: readonly { record: FeedbackRecord; agentName: string | undefined }[],
  notes: readonly AppNote[] = [],
): { subject: string; text: string } {
  const lines = items.map(({ record, agentName }) => {
    const stars = `${record.rating} ${record.rating === 1 ? 'star' : 'stars'}`;
    const issues =
      record.issues.length > 0 ? `: ${record.issues.map((i) => ISSUE_WORDS[i]).join(', ')}` : '';
    const said = record.note ? oneLine(record.note) : '';
    const note = said ? `\n  "${said}"` : '';
    const when = record.created_at.slice(0, 16).replace('T', ' ');
    const app = record.app_version ? `, app ${record.app_version}` : '';
    return `- ${stars}${issues} (call with ${agentName ?? 'an agent'}, ${when} UTC${app})${note}`;
  });
  const noteLines = notes.map((n) => {
    const when = n.created_at.slice(0, 16).replace('T', ' ');
    const app = n.app_version ? `, app ${n.app_version}` : '';
    return `- "${oneLine(n.note)}"\n  (${n.email ?? 'no email on the account'}, ${when} UTC${app})`;
  });
  const subject =
    notes.length > 0 && items.length > 0
      ? `Twring: ${plural(notes.length, 'note', 'notes')} and ${plural(items.length, 'call rating', 'call ratings')} to read`
      : notes.length > 0
        ? `Twring: ${plural(notes.length, 'note', 'notes')} to read`
        : `Twring: ${plural(items.length, 'new call rating', 'new call ratings')} to read`;
  const parts = [
    ...(noteLines.length > 0
      ? [`Notes sent from Settings (reply to the address shown):\n\n${noteLines.join('\n')}`]
      : []),
    ...(lines.length > 0
      ? [`People rated their calls. Notes and ratings of 3 stars or fewer:\n\n${lines.join('\n')}`]
      : []),
  ];
  return {
    subject,
    text: `${parts.join('\n\n')}

All ratings and the daily numbers: the operations scripts.`,
  };
}

export class FeedbackDigest {
  constructor(
    private readonly options: {
      to: string;
      /** All stored feedback, read fresh each round. */
      readRows: () => Promise<readonly FeedbackRecord[]>;
      /** Notes sent from Settings, read fresh each round. */
      readNotes?: () => Promise<readonly AppNote[]>;
      /** The newest feedback already handled; undefined before the first round. */
      loadMark: () => Promise<string | undefined>;
      saveMark: (at: string) => Promise<void>;
      send: (email: OutgoingEmail) => Promise<SendResult>;
      agentName: (userId: string, agentId: string) => Promise<string | undefined>;
      /** A store file could not be read this round; the other one is still emailed. */
      onReadError?: (source: 'call ratings' | 'notes', error: unknown) => void;
      now?: () => Date;
    },
  ) {}

  async run(): Promise<void> {
    const mark = await this.options.loadMark();
    if (mark === undefined) {
      // First round: start from now, so old feedback is not emailed all at once.
      await this.options.saveMark((this.options.now?.() ?? new Date()).toISOString());
      return;
    }
    const safely = async <T>(
      source: 'call ratings' | 'notes',
      read: () => Promise<readonly T[]>,
    ) => {
      try {
        return await read();
      } catch (error) {
        this.options.onReadError?.(source, error);
        return [];
      }
    };
    const fresh = (await safely('call ratings', this.options.readRows)).filter(
      (r) => r.created_at > mark,
    );
    const notes = (await safely('notes', this.options.readNotes ?? (() => Promise.resolve([]))))
      .filter((n) => n.created_at > mark)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (fresh.length === 0 && notes.length === 0) return;
    const newest = [...fresh, ...notes].reduce(
      (at, r) => (r.created_at > at ? r.created_at : at),
      mark,
    );
    const toRead = fresh
      .filter(worthReading)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (toRead.length > 0 || notes.length > 0) {
      const items = await Promise.all(
        toRead.map(async (record) => ({
          record,
          agentName: await this.options
            .agentName(record.user_id, record.agent_id)
            .catch(() => undefined),
        })),
      );
      const result = await this.options.send({
        to: this.options.to,
        ...feedbackEmail(items, notes),
      });
      // "Later" (rate limit, daily cap): keep the bookmark so the next round tries again. A
      // rejected email would fail the same way every round, so it moves on.
      if (result === 'retry') return;
    }
    await this.options.saveMark(newest);
  }
}

/** A store file read fresh (the app's own reader caches it); bad rows are skipped. */
async function readRowsFile<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row) => {
    const result = schema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}

export function readFeedbackFile(file: string): Promise<FeedbackRecord[]> {
  return readRowsFile(file, feedbackRecordSchema);
}

/** Notes sent from Settings (`app-notes.json`). */
export function readNotesFile(file: string): Promise<AppNote[]> {
  return readRowsFile(file, appNoteSchema);
}

const markSchema = z.object({ sent_until: z.iso.datetime() });

/** The bookmark, or undefined only when there is none yet (first run). Anything else throws. */
export async function loadDigestMark(file: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return markSchema.parse(JSON.parse(text)).sent_until;
}

/** Written to a temporary file and renamed, so a crash never leaves a half-written bookmark. */
export async function saveDigestMark(file: string, at: string): Promise<void> {
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify({ sent_until: at })}\n`, { mode: 0o600 });
  await rename(temp, file);
}
