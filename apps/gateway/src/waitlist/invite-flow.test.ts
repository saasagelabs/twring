import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MemoryCollection } from '../store/collection';

import {
  InviteFlow,
  approvalsFileSchema,
  inviteEmail,
  readApprovalsFile,
  requestDigest,
  type OutgoingEmail,
} from './invite-flow';
import type { WaitlistRecord } from './routes';

const T0 = '2026-10-22T09:00:00.000Z';

function row(email: string, extra: Partial<WaitlistRecord> = {}): WaitlistRecord {
  return { email, created_at: T0, source: 'beta', ...extra };
}

async function setup(
  options: {
    rows?: WaitlistRecord[];
    members?: string[];
    failSendTo?: string[];
    /** Addresses the email service turns away for now (daily cap, outage). */
    busyFor?: string[];
    autoInvitePerDay?: number;
  } = {},
) {
  const records = new MemoryCollection<WaitlistRecord>();
  await records.update(() => ({ items: options.rows ?? [], result: undefined }));
  const sent: OutgoingEmail[] = [];
  const letIn: string[] = [];
  let approvals: unknown = { approvals: [] };
  const clock = { ms: Date.parse('2026-10-22T10:00:00.000Z') };
  const flow = new InviteFlow({
    records,
    ownerTo: 'support@twring.com',
    send: (email) => {
      if (options.failSendTo?.some((to) => email.to === to)) return Promise.resolve('rejected');
      if (options.busyFor?.some((to) => email.to === to)) return Promise.resolve('retry');
      sent.push(email);
      return Promise.resolve('sent');
    },
    letIn: (email) => {
      letIn.push(email);
      return Promise.resolve();
    },
    // Someone let in by an earlier round is a member, like the real store.
    isMember: (email) =>
      Promise.resolve((options.members?.includes(email) ?? false) || letIn.includes(email)),
    readApprovals: () => Promise.resolve(approvalsFileSchema.parse(approvals).approvals),
    links: {
      android: 'https://twring.com/downloads/twring-0.1.0-b10.apk',
      iphone: 'https://testflight.apple.com/join/abc',
    },
    now: () => new Date(clock.ms),
    ...(options.autoInvitePerDay !== undefined && { autoInvitePerDay: options.autoInvitePerDay }),
  });
  const approve = (entry: Record<string, unknown>) => {
    approvals = { approvals: [{ id: `a${String(Math.random()).slice(2, 8)}`, ...entry }] };
  };
  return { flow, records, sent, approve, clock, letIn };
}

describe('automatic invites (AUTO_ADMIT_PER_DAY)', () => {
  it('lets website requests in and emails them, without an approval, up to the daily limit, oldest first', async () => {
    const { flow, sent, records, clock } = await setup({
      autoInvitePerDay: 2,
      rows: [
        row('c@x.com', { created_at: '2026-10-22T09:30:00.000Z' }),
        row('a@x.com', { created_at: '2026-10-22T08:00:00.000Z' }),
        row('b@x.com', { created_at: '2026-10-22T09:00:00.000Z' }),
      ],
    });
    await flow.processApprovals();
    expect(sent.map((e) => e.to)).toEqual(['a@x.com', 'b@x.com']);
    await flow.processApprovals();
    expect(sent).toHaveLength(2);
    clock.ms = Date.parse('2026-10-23T00:05:00.000Z');
    await flow.processApprovals();
    expect(sent.map((e) => e.to)).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
    expect((await records.read()).every((r) => r.invited_at !== undefined)).toBe(true);
  });

  it('skips requests from the app (they get in on sign-in) and requests older than a week', async () => {
    const { flow, sent } = await setup({
      autoInvitePerDay: 10,
      rows: [
        row('app@x.com', { source: 'app' }),
        row('old@x.com', { created_at: '2026-10-14T00:36:00.000Z' }),
        row('new@x.com'),
      ],
    });
    await flow.processApprovals();
    expect(sent.map((e) => e.to)).toEqual(['new@x.com']);
  });

  it('counts invites the owner approved today toward the limit', async () => {
    const { flow, sent, approve } = await setup({
      autoInvitePerDay: 1,
      rows: [row('named@x.com'), row('other@x.com')],
    });
    approve({ at: '2026-10-22T09:59:00.000Z', emails: ['named@x.com'] });
    await flow.processApprovals();
    expect(sent.map((e) => e.to)).toEqual(['named@x.com']);
  });

  it('in automatic mode the owner gets no email for new requests, only for failed invites', async () => {
    const { flow, sent, records } = await setup({
      autoInvitePerDay: 50,
      rows: [row('new@x.com', { source: 'app' })],
    });
    await flow.sendDigest();
    expect(sent).toHaveLength(0);
    expect((await records.read())[0]?.notified_at).toBeDefined();
    await records.update((items) => ({
      items: items.map((r) => ({ ...r, invite_failed_at: '2026-10-22T09:30:00.000Z' })),
      result: undefined,
    }));
    await flow.sendDigest();
    expect(sent.map((e) => e.to)).toEqual(['support@twring.com']);
  });

  it('the summary email says nothing is needed from the owner', () => {
    const { text } = requestDigest([row('a@x.com')], { pending: 1, failed: [] }, 50);
    expect(text).toMatch(/automatically/);
    expect(text).toMatch(/up to 50 a day/);
    expect(text).not.toMatch(/approve --all/);
  });
});

describe('inviteEmail', () => {
  const links = {
    android: 'https://a.example/app.apk',
    iphone: 'https://testflight.apple.com/join/x',
  };

  it('has no code at all: install, sign in, connect', () => {
    const { subject, text } = inviteEmail({ links });
    expect(subject).toBe('Your Twring invite');
    expect(text).toContain(
      'iPhone: install TestFlight from the App Store, then open this link on your iPhone and tap Install: https://testflight.apple.com/join/x',
    );
    expect(text).toContain('https://a.example/app.apk');
    expect(text).toContain(
      '2. Open Twring and sign in with Google, or Apple on iPhone, using this email address. You are in.',
    );
    expect(text).toMatch(
      /3\. Tap Connect my agent and follow the steps: Twring gives you a short message to send to your agent\./,
    );
    expect(text).toContain('Your agent can ring your phone when a job is done or needs you.');
    expect(text).not.toMatch(/code|beta|connector|twring-connect|MCP|demo/i);
  });

  it('without a TestFlight link, iPhone people are asked to reply', () => {
    const { text } = inviteEmail({ links: { android: 'https://a.example/app.apk' } });
    expect(text).toMatch(/iPhone: reply to this email/);
  });
});

describe('requestDigest', () => {
  it('lists each request and how to approve', () => {
    const { subject, text } = requestDigest(
      [row('a@example.com'), row('b@example.com', { source: 'app' })],
      { pending: 5, failed: [] },
    );
    expect(subject).toBe('Twring: 2 new access requests');
    expect(text).toContain('a@example.com');
    expect(text).toContain('b@example.com');
    expect(text).toContain('5 waiting');
    expect(text).toContain('approve all');
    expect(text).not.toMatch(/CORD_PROD_HOST|ubuntu@|invites\.sh/);
  });
});

describe('InviteFlow.sendDigest', () => {
  it('tells the owner once about new requests, in one email', async () => {
    const t = await setup({ rows: [row('a@example.com'), row('b@example.com')] });
    await t.flow.sendDigest();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('support@twring.com');
    await t.flow.sendDigest();
    expect(t.sent).toHaveLength(1);
    expect((await t.records.read()).every((r) => r.notified_at !== undefined)).toBe(true);
  });

  it('a failed send is retried next round, nothing is skipped', async () => {
    const t = await setup({ rows: [row('a@example.com')], failSendTo: ['support@twring.com'] });
    await t.flow.sendDigest();
    expect((await t.records.read())[0]!.notified_at).toBeUndefined();
  });

  it('sends nothing when there is nothing new', async () => {
    const t = await setup({ rows: [row('a@example.com', { notified_at: T0 })] });
    await t.flow.sendDigest();
    expect(t.sent).toEqual([]);
  });
});

describe('InviteFlow.processApprovals', () => {
  it('"all" invites everyone who asked before the approval, once each', async () => {
    const t = await setup({
      rows: [
        row('a@example.com'),
        row('late@example.com', { created_at: '2026-10-22T11:00:00.000Z' }),
      ],
    });
    t.approve({ at: '2026-10-22T10:00:00.000Z', all: true });
    await t.flow.processApprovals();
    expect(t.sent.map((e) => e.to)).toEqual(['a@example.com']);
    expect(t.letIn).toEqual(['a@example.com']);
    await t.flow.processApprovals();
    expect(t.sent).toHaveLength(1);
    const rows = await t.records.read();
    expect(rows.find((r) => r.email === 'a@example.com')!.invited_at).toBeDefined();
    expect(rows.find((r) => r.email === 'late@example.com')!.invited_at).toBeUndefined();
  });

  it('named emails are matched without regard to case; unknown ones are left alone', async () => {
    const t = await setup({ rows: [row('a@example.com'), row('b@example.com')] });
    t.approve({ at: '2026-10-22T10:00:00.000Z', emails: ['A@Example.com', 'nobody@example.com'] });
    await t.flow.processApprovals();
    expect(t.sent.map((e) => e.to)).toEqual(['a@example.com']);
    expect((await t.records.read()).some((r) => r.email === 'nobody@example.com')).toBe(false);
  });

  it('a busy email service does not lose the invite: nobody is let in until their email went out', async () => {
    const busy = ['a@example.com'];
    const t = await setup({ rows: [row('a@example.com')], busyFor: busy });
    t.approve({ at: '2026-10-22T10:00:00.000Z', all: true });
    await t.flow.processApprovals();
    expect(t.sent).toEqual([]);
    expect(t.letIn).toEqual([]);
    busy.length = 0;
    await t.flow.processApprovals();
    expect(t.sent.map((e) => e.to)).toEqual(['a@example.com']);
    expect(t.letIn).toEqual(['a@example.com']);
  });

  it('someone already in gets no email', async () => {
    const t = await setup({ rows: [row('a@example.com')], members: ['a@example.com'] });
    t.approve({ at: '2026-10-22T10:00:00.000Z', all: true });
    await t.flow.processApprovals();
    expect(t.sent).toEqual([]);
    expect((await t.records.read())[0]!.invited_at).toBeDefined();
  });

  it('a failing address is retried, then marked failed after 3 tries and named to the owner', async () => {
    const t = await setup({ rows: [row('bad@example.com')], failSendTo: ['bad@example.com'] });
    t.approve({ at: '2026-10-22T10:00:00.000Z', all: true });
    for (let n = 0; n < 4; n += 1) await t.flow.processApprovals();
    const bad = (await t.records.read())[0]!;
    expect(bad.invited_at).toBeUndefined();
    expect(bad.invite_attempts).toBe(3);
    expect(bad.invite_failed_at).toBeDefined();
    await t.flow.sendDigest();
    expect(t.sent.at(-1)!.text).toContain("Couldn't email: bad@example.com");
  });
});

describe('readApprovalsFile', () => {
  it('a missing file is no approvals; a damaged one is reported and ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-approvals-'));
    try {
      const file = join(dir, 'invite-approvals.json');
      const bad: string[] = [];
      expect(await readApprovalsFile(file, () => bad.push('x'))).toEqual([]);
      await writeFile(
        file,
        '{"approvals":[{"id":"a1","at":"2026-10-22T10:00:00.000Z","all":true}]}',
      );
      expect(await readApprovalsFile(file, () => bad.push('x'))).toHaveLength(1);
      await writeFile(file, '{"approvals": oops');
      expect(await readApprovalsFile(file, () => bad.push('x'))).toEqual([]);
      expect(bad).toEqual(['x']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('review fixes', () => {
  it('a full or unavailable email service pauses the batch: nobody is burned', async () => {
    const t = await setup({
      rows: [row('a@example.com'), row('b@example.com'), row('c@example.com')],
      busyFor: ['b@example.com', 'c@example.com'],
    });
    t.approve({ at: '2026-10-22T10:00:00.000Z', all: true });
    for (let n = 0; n < 5; n += 1) await t.flow.processApprovals();
    const rows = await t.records.read();
    expect(rows.find((r) => r.email === 'a@example.com')!.invited_at).toBeDefined();
    for (const email of ['b@example.com', 'c@example.com']) {
      const r = rows.find((x) => x.email === email)!;
      expect(r.invite_failed_at).toBeUndefined();
      expect(r.invite_attempts ?? 0).toBe(0);
    }
  });

  it('naming a failed person in a newer approval tries them again', async () => {
    const t = await setup({
      rows: [row('bad@example.com', { invite_attempts: 3, invite_failed_at: T0 })],
    });
    t.approve({ at: '2026-10-22T10:00:00.000Z', emails: ['bad@example.com'] });
    await t.flow.processApprovals();
    const r = (await t.records.read())[0]!;
    expect(r.invited_at).toBeDefined();
    expect(r.invite_failed_at).toBeUndefined();
  });

  it('a failure is reported to the owner once, even after a restart', async () => {
    const t = await setup({
      rows: [row('bad@example.com', { notified_at: T0, invite_attempts: 3, invite_failed_at: T0 })],
    });
    await t.flow.sendDigest();
    expect(t.sent).toHaveLength(1);
    // A new InviteFlow on the same rows (a restart) does not report it again.
    const again = new InviteFlow({
      records: t.records,
      ownerTo: 'support@twring.com',
      send: (email) => {
        t.sent.push(email);
        return Promise.resolve('sent');
      },
      letIn: () => Promise.resolve(),
      isMember: () => Promise.resolve(false),
      readApprovals: () => Promise.resolve([]),
      links: {},
    });
    await again.sendDigest();
    expect(t.sent).toHaveLength(1);
  });

  it('the invite gives the Android install hint', () => {
    const { text } = inviteEmail({ links: { android: 'https://a.example/app.apk' } });
    expect(text).toContain('allow the install if your phone asks');
  });
});
