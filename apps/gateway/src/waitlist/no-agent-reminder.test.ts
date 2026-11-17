import { describe, expect, it } from 'vitest';

import { MemoryCollection } from '../store/collection';

import {
  MAX_REMINDERS_PER_RUN,
  NoAgentReminder,
  noAgentReminderEmail,
  type NoAgentReminderRecord,
} from './no-agent-reminder';

const HOUR = 60 * 60_000;
const START = Date.parse('2026-11-18T10:00:00.000Z');

function setup(
  options: {
    agents?: Set<string>;
    callers?: Set<string>;
    result?: 'sent' | 'retry' | 'rejected';
    rows?: NoAgentReminderRecord[];
  } = {},
) {
  let now = START;
  const records = new MemoryCollection<NoAgentReminderRecord>();
  void records.update(() => ({ items: options.rows ?? [], result: undefined }));
  const sent: {
    to: string;
    subject: string;
    text: string;
    replyTo?: string;
    idempotencyKey?: string;
  }[] = [];
  let writes = 0;
  const counted = {
    read: () => records.read(),
    update: <R>(change: Parameters<typeof records.update<R>>[0]) => {
      writes += 1;
      return records.update(change);
    },
  };
  const reminder = new NoAgentReminder({
    records: counted,
    hasAgent: (userId) => Promise.resolve(options.agents?.has(userId) ?? false),
    hasCalled: (userId) => Promise.resolve(options.callers?.has(userId) ?? false),
    send: (email) => {
      sent.push(email);
      return Promise.resolve(options.result ?? 'sent');
    },
    replyTo: 'support@example.com',
    now: () => new Date(now),
  });
  return {
    reminder,
    records,
    sent,
    writes: () => writes,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the reminder to connect an agent', () => {
  it('remembers when a person was first seen, once', async () => {
    const { reminder, records, writes, advance } = setup();
    await reminder.seen('u1', ' Person@Example.com ');
    advance(HOUR);
    await reminder.seen('u1', 'person@example.com');
    expect(await records.read()).toEqual([
      { user_id: 'u1', email: 'person@example.com', first_seen_at: new Date(START).toISOString() },
    ]);
    expect(writes()).toBe(1);
  });

  it('emails a person with no agent once, 24 hours after they were first seen', async () => {
    const { reminder, records, sent, advance } = setup();
    await reminder.seen('u1', 'person@example.com');
    advance(23 * HOUR);
    await reminder.run();
    expect(sent).toEqual([]);
    advance(HOUR);
    await reminder.run();
    expect(sent).toEqual([
      {
        to: 'person@example.com',
        replyTo: 'support@example.com',
        idempotencyKey: 'no-agent-reminder/u1',
        ...noAgentReminderEmail(),
      },
    ]);
    await reminder.run();
    expect(sent).toHaveLength(1);
    // Settled: the address is no longer kept.
    expect(await records.read()).toEqual([
      {
        user_id: 'u1',
        first_seen_at: new Date(START).toISOString(),
        settled_at: new Date(START + 24 * HOUR).toISOString(),
        outcome: 'sent',
      },
    ]);
  });

  it('does not email someone who connected an agent, or who has made calls', async () => {
    const { reminder, records, sent, advance } = setup({
      agents: new Set(['u1']),
      callers: new Set(['u2']),
    });
    await reminder.seen('u1', 'one@example.com');
    await reminder.seen('u2', 'two@example.com');
    advance(25 * HOUR);
    await reminder.run();
    expect(sent).toEqual([]);
    expect((await records.read()).map((r) => [r.outcome, r.email])).toEqual([
      ['has_agent', undefined],
      ['called', undefined],
    ]);
  });

  it('lets a reminder go unsent once it is more than a week late (the server was off)', async () => {
    const { reminder, records, sent, advance } = setup();
    await reminder.seen('u1', 'person@example.com');
    advance(8 * 24 * HOUR);
    await reminder.run();
    expect(sent).toEqual([]);
    expect((await records.read())[0]?.outcome).toBe('expired');
  });

  it('tries again later when the email service is busy, and gives up on an address that refuses', async () => {
    const busy = setup({ result: 'retry' });
    await busy.reminder.seen('u1', 'person@example.com');
    busy.advance(25 * HOUR);
    await busy.reminder.run();
    await busy.reminder.run();
    expect(busy.sent).toHaveLength(2);
    expect((await busy.records.read())[0]?.settled_at).toBeUndefined();

    // The same key both times: if the first was delivered and only the answer was lost, the
    // email service drops the second.
    expect(busy.sent.map((e) => e.idempotencyKey)).toEqual([
      'no-agent-reminder/u1',
      'no-agent-reminder/u1',
    ]);

    const refused = setup({ result: 'rejected' });
    await refused.reminder.seen('u1', 'person@example.com');
    refused.advance(25 * HOUR);
    await refused.reminder.run();
    await refused.reminder.run();
    expect(refused.sent).toHaveLength(1);
    expect((await refused.records.read())[0]).toMatchObject({ outcome: 'rejected' });
    expect((await refused.records.read())[0]?.email).toBeUndefined();
  });

  it('never emails someone already settled (people from before the reminder existed)', async () => {
    const { reminder, sent, advance } = setup({
      rows: [
        {
          user_id: 'u1',
          first_seen_at: new Date(START - 30 * 24 * HOUR).toISOString(),
          settled_at: new Date(START).toISOString(),
          outcome: 'existing',
        },
      ],
    });
    await reminder.seen('u1', 'person@example.com');
    advance(25 * HOUR);
    await reminder.run();
    expect(sent).toEqual([]);
  });

  it(`sends at most ${MAX_REMINDERS_PER_RUN} in one run; the rest go next time`, async () => {
    const { reminder, sent, advance } = setup();
    for (let i = 0; i < MAX_REMINDERS_PER_RUN + 3; i += 1)
      await reminder.seen(`u${i}`, `p${i}@example.com`);
    advance(25 * HOUR);
    await reminder.run();
    expect(sent).toHaveLength(MAX_REMINDERS_PER_RUN);
    await reminder.run();
    expect(sent).toHaveLength(MAX_REMINDERS_PER_RUN + 3);
  });

  it('forgets a person entirely on Delete my data', async () => {
    const { reminder, records, sent, advance } = setup();
    await reminder.seen('u1', 'person@example.com');
    await reminder.seen('u2', 'other@example.com');
    expect(await reminder.deleteAllForUser('u1')).toBe(1);
    expect((await records.read()).map((r) => r.user_id)).toEqual(['u2']);
    advance(25 * HOUR);
    await reminder.run();
    expect(sent.map((e) => e.to)).toEqual(['other@example.com']);
  });

  it('writes nothing when Delete my data started while the app was opening', async () => {
    const { reminder, records } = setup();
    await reminder.seen('u1', 'person@example.com', () => false);
    expect(await records.read()).toEqual([]);
    // Not remembered as on file either: the next open records them.
    await reminder.seen('u1', 'person@example.com', () => true);
    expect((await records.read()).map((r) => r.user_id)).toEqual(['u1']);
  });

  it('a person whose sign-in carries no email address is not tracked', async () => {
    const { reminder, records, sent } = setup();
    await reminder.seen('u1', undefined);
    expect(await records.read()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('says what to do in plain words, with no em dashes', () => {
    const email = noAgentReminderEmail();
    expect(email.subject).toBe('Connect your agent to Twring');
    expect(email.text).toContain('tap Connect my agent');
    expect(email.text).not.toContain(String.fromCodePoint(0x2014));
  });
});
