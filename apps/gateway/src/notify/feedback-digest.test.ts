import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FeedbackRecord } from '../calls/feedback-store';
import type { AppNote } from '../me/notes';
import {
  FEEDBACK_DIGEST_EVERY_MS,
  FeedbackDigest,
  feedbackEmail,
  loadDigestMark,
  readFeedbackFile,
  saveDigestMark,
} from './feedback-digest';

function rating(at: string, extra: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    call_id: 'call_abcdefghij0123456789',
    user_id: 'user-1',
    agent_id: 'agt_x',
    rating: 5,
    issues: [],
    created_at: at,
    ...extra,
  };
}

function setup(rows: FeedbackRecord[], mark?: string, notes: AppNote[] = []) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const state = { mark, result: 'sent' as 'sent' | 'retry' };
  const clock = { now: new Date('2026-10-23T10:00:00.000Z') };
  const digest = new FeedbackDigest({
    to: 'support@twring.com',
    readRows: () => Promise.resolve(rows),
    readNotes: () => Promise.resolve(notes),
    loadMark: () => Promise.resolve(state.mark),
    saveMark: (at) => {
      state.mark = at;
      return Promise.resolve();
    },
    send: (email) => {
      if (state.result === 'sent') sent.push(email);
      return Promise.resolve(state.result);
    },
    agentName: (_user, id) => Promise.resolve(id === 'agt_x' ? 'Hermes' : undefined),
    now: () => clock.now,
  });
  return { digest, sent, state, clock };
}

describe('feedback digest', () => {
  it('notes sent from Settings come in their own part, with the sender to reply to', async () => {
    const t = setup(
      [rating('2026-10-23T09:20:00.000Z', { rating: 2 })],
      '2026-10-23T09:00:00.000Z',
      [
        {
          id: `note_${'a'.repeat(20)}`,
          user_id: 'user-1',
          email: 'ann@example.com',
          note: 'Can I\nchange the ring tone?',
          app_version: '0.1.0 (12) ios',
          created_at: '2026-10-23T09:45:00.000Z',
        },
      ],
    );
    await t.digest.run();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.subject).toBe('Twring: 1 note and 1 call rating to read');
    expect(t.sent[0]!.text).toContain('Notes sent from Settings');
    expect(t.sent[0]!.text).toContain('"Can I change the ring tone?"');
    expect(t.sent[0]!.text).toContain('ann@example.com');
    expect(t.sent[0]!.text).not.toContain('user-1');
    expect(t.state.mark).toBe('2026-10-23T09:45:00.000Z');
  });

  it('one unreadable file does not silence the other', async () => {
    const sent: { subject: string }[] = [];
    const failures: string[] = [];
    const digest = new FeedbackDigest({
      to: 'support@twring.com',
      readRows: () => Promise.reject(new Error('call-feedback.json is not valid JSON')),
      readNotes: () =>
        Promise.resolve([
          {
            id: `note_${'c'.repeat(20)}`,
            user_id: 'user-1',
            note: 'Still works?',
            created_at: '2026-10-23T09:30:00.000Z',
          },
        ]),
      loadMark: () => Promise.resolve('2026-10-23T09:00:00.000Z'),
      saveMark: () => Promise.resolve(),
      send: (email) => {
        sent.push(email);
        return Promise.resolve('sent');
      },
      agentName: () => Promise.resolve(undefined),
      onReadError: (source) => failures.push(source),
    });
    await digest.run();
    expect(sent.map((e) => e.subject)).toEqual(['Twring: 1 note to read']);
    expect(failures).toEqual(['call ratings']);
  });

  it('a note alone is enough for an email', async () => {
    const t = setup([], '2026-10-23T09:00:00.000Z', [
      {
        id: `note_${'b'.repeat(20)}`,
        user_id: 'user-1',
        note: 'Love it',
        created_at: '2026-10-23T09:30:00.000Z',
      },
    ]);
    await t.digest.run();
    expect(t.sent[0]!.subject).toBe('Twring: 1 note to read');
    expect(t.sent[0]!.text).toContain('no email on the account');
  });

  it('the first run starts from now: no old feedback is emailed', async () => {
    const t = setup([rating('2026-10-20T10:00:00.000Z', { rating: 1, note: 'old' })]);
    await t.digest.run();
    expect(t.sent).toEqual([]);
    expect(t.state.mark).toBe('2026-10-23T10:00:00.000Z');
  });

  it('emails notes and low ratings in one email, and skips quiet 4 and 5 star ratings', async () => {
    const t = setup(
      [
        rating('2026-10-23T09:10:00.000Z', { rating: 5 }),
        rating('2026-10-23T09:20:00.000Z', { rating: 2, issues: ['cut_off', 'slow'] }),
        rating('2026-10-23T09:30:00.000Z', { rating: 5, note: 'Loved it' }),
        rating('2026-10-23T09:40:00.000Z', { rating: 4 }),
      ],
      '2026-10-23T09:00:00.000Z',
    );
    await t.digest.run();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('support@twring.com');
    expect(t.sent[0]!.subject).toBe('Twring: 2 new call ratings to read');
    expect(t.sent[0]!.text).toContain('2 stars');
    expect(t.sent[0]!.text).toContain('cut me off, slow replies');
    expect(t.sent[0]!.text).toContain('"Loved it"');
    expect(t.sent[0]!.text).toContain('Hermes');
    expect(t.sent[0]!.text).not.toContain('user-1');
    // The bookmark is the newest feedback read, so anything saved during the round comes next time.
    expect(t.state.mark).toBe('2026-10-23T09:40:00.000Z');
  });

  it('sends nothing when there is nothing to read, and moves on', async () => {
    const t = setup(
      [rating('2026-10-23T09:10:00.000Z', { rating: 5 })],
      '2026-10-23T09:00:00.000Z',
    );
    await t.digest.run();
    expect(t.sent).toEqual([]);
    expect(t.state.mark).toBe('2026-10-23T09:10:00.000Z');
  });

  it('a busy email service keeps the feedback for the next round', async () => {
    const t = setup(
      [rating('2026-10-23T09:20:00.000Z', { rating: 1 })],
      '2026-10-23T09:00:00.000Z',
    );
    t.state.result = 'retry';
    await t.digest.run();
    expect(t.state.mark).toBe('2026-10-23T09:00:00.000Z');
    t.state.result = 'sent';
    await t.digest.run();
    expect(t.sent).toHaveLength(1);
  });

  it('feedback that arrives during a round is not skipped next time', async () => {
    const rows = [rating('2026-10-23T09:20:00.000Z', { rating: 1 })];
    const t = setup(rows, '2026-10-23T09:00:00.000Z');
    await t.digest.run();
    rows.push(rating('2026-10-23T09:59:59.000Z', { rating: 1, note: 'late' }));
    t.clock.now = new Date('2026-10-23T10:15:00.000Z');
    await t.digest.run();
    expect(t.sent.map((e) => e.text.includes('"late"'))).toEqual([false, true]);
  });
});

describe('feedbackEmail', () => {
  it('reads plainly for one rating, without account ids', () => {
    const { subject, text } = feedbackEmail([
      {
        record: rating('2026-10-23T09:20:00.000Z', {
          rating: 1,
          note: 'It never answered',
          app_version: '0.1.0 (11) android',
        }),
        agentName: undefined,
      },
    ]);
    expect(subject).toBe('Twring: 1 new call rating to read');
    expect(text).toContain('1 star');
    expect(text).toContain('"It never answered"');
    expect(text).toContain('an agent');
    expect(text).toContain('0.1.0 (11) android');
    expect(text).not.toMatch(/user-1|call_/);
  });

  it('keeps a note with line breaks on one line', () => {
    const { text } = feedbackEmail([
      {
        record: rating('2026-10-23T09:20:00.000Z', { rating: 2, note: 'first\n\nsecond  line' }),
        agentName: 'Hermes',
      },
    ]);
    expect(text).toContain('"first second line"');
  });
});

describe('feedback files', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function dir() {
    const d = await mkdtemp(join(tmpdir(), 'cord-feedback-'));
    dirs.push(d);
    return d;
  }

  it('reads good rows fresh, skips bad ones, and treats a missing file as empty', async () => {
    const d = await dir();
    const file = join(d, 'call-feedback.json');
    expect(await readFeedbackFile(file)).toEqual([]);
    await writeFile(
      file,
      JSON.stringify([rating('2026-10-23T09:20:00.000Z', { rating: 2 }), { broken: true }]),
    );
    expect(await readFeedbackFile(file)).toMatchObject([{ rating: 2 }]);
    await writeFile(file, JSON.stringify([rating('2026-10-23T09:30:00.000Z', { rating: 3 })]));
    expect(await readFeedbackFile(file)).toMatchObject([{ rating: 3 }]);
  });

  it('a damaged bookmark is an error, not a fresh start that skips feedback', async () => {
    const file = join(await dir(), 'feedback-digest.json');
    await writeFile(file, '');
    await expect(loadDigestMark(file)).rejects.toThrow();
    await writeFile(file, '{"sent_until":"not a date"}');
    await expect(loadDigestMark(file)).rejects.toThrow();
  });

  it('runs at most once an hour, to leave email room for invites and alerts', () => {
    expect(FEEDBACK_DIGEST_EVERY_MS).toBe(60 * 60_000);
  });

  it('keeps the bookmark between restarts', async () => {
    const file = join(await dir(), 'feedback-digest.json');
    expect(await loadDigestMark(file)).toBeUndefined();
    await saveDigestMark(file, '2026-10-23T09:40:00.000Z');
    expect(await loadDigestMark(file)).toBe('2026-10-23T09:40:00.000Z');
  });
});
