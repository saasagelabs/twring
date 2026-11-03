import { describe, expect, it } from 'vitest';

import { applyInvitesOp } from './invites-admin';

const NOW = new Date('2026-10-22T10:00:00.000Z');
const list = JSON.stringify([
  { email: 'a@example.com', created_at: '2026-10-21T09:00:00.000Z', source: 'beta' },
  {
    email: 'b@example.com',
    created_at: '2026-10-21T09:05:00.000Z',
    source: 'app',
    invited_at: '2026-10-21T12:00:00.000Z',
  },
  {
    email: 'c@example.com',
    created_at: '2026-10-21T09:10:00.000Z',
    source: 'landing',
    invite_failed_at: '2026-10-21T12:00:00.000Z',
  },
]);

describe('applyInvitesOp', () => {
  it('pending lists who is waiting; status counts everyone', () => {
    const pending = applyInvitesOp(list, undefined, { kind: 'pending' }, NOW);
    expect(pending.next).toBeUndefined();
    expect(pending.lines).toEqual(['a@example.com  (twring.com/beta, 2026-10-21 09:00 UTC)']);
    const status = applyInvitesOp(list, undefined, { kind: 'status' }, NOW);
    expect(status.lines).toEqual(['3 requests: 1 waiting, 1 invited, 1 could not be emailed.']);
  });

  it('approve --all appends one approval covering everyone so far', () => {
    const out = applyInvitesOp(list, undefined, { kind: 'approve', all: true }, NOW);
    const file = JSON.parse(out.next!) as { approvals: { at: string; emails?: string[] }[] };
    expect(file.approvals).toHaveLength(1);
    expect(file.approvals[0]).toMatchObject({ at: NOW.toISOString(), emails: ['a@example.com'] });
    expect(out.lines).toEqual(['Approved 1 waiting request. Invites go out within a minute.']);
  });

  it('approve <email> keeps earlier approvals and says which emails are not on the list', () => {
    const before = JSON.stringify({
      approvals: [{ id: 'old', at: '2026-10-21T00:00:00.000Z', emails: ['x@example.com'] }],
    });
    const out = applyInvitesOp(
      list,
      before,
      { kind: 'approve', emails: ['A@example.com', 'zz@example.com'] },
      NOW,
    );
    const file = JSON.parse(out.next!) as { approvals: { id: string; emails?: string[] }[] };
    expect(file.approvals.map((a) => a.id)[0]).toBe('old');
    expect(file.approvals[1]!.emails).toEqual(['a@example.com']);
    expect(out.lines).toEqual([
      'Approved 1 waiting request. Invites go out within a minute.',
      'Not on the request list (ask them to request access first): zz@example.com',
    ]);
  });

  it('drops approvals older than 30 days, and approves nothing when nobody matches', () => {
    const before = JSON.stringify({
      approvals: [{ id: 'old', at: '2026-09-01T00:00:00.000Z', all: true }],
    });
    const out = applyInvitesOp(list, before, { kind: 'approve', emails: ['b@example.com'] }, NOW);
    expect(out.next).toBeUndefined();
    expect(out.lines).toEqual(['Nobody to invite: b@example.com was already invited.']);
    const all = applyInvitesOp(list, before, { kind: 'approve', all: true }, NOW);
    const file = JSON.parse(all.next!) as { approvals: { id: string }[] };
    expect(file.approvals.map((a) => a.id)).not.toContain('old');
  });

  it('a damaged list or approvals file is an error, never overwritten', () => {
    expect(() => applyInvitesOp('[oops', undefined, { kind: 'pending' }, NOW)).toThrow(/waitlist/);
    expect(() => applyInvitesOp(list, '{bad', { kind: 'approve', all: true }, NOW)).toThrow(
      /invite-approvals/,
    );
  });
});

describe('review fixes (admin)', () => {
  it('approve --all names each waiting person, so neither clock matters', () => {
    const out = applyInvitesOp(list, undefined, { kind: 'approve', all: true }, NOW);
    const file = JSON.parse(out.next!) as { approvals: { all?: boolean; emails?: string[] }[] };
    expect(file.approvals[0]!.all).toBeUndefined();
    expect(file.approvals[0]!.emails).toEqual(['a@example.com']);
  });

  it('a person who could not be emailed can be approved again by name', () => {
    const out = applyInvitesOp(
      list,
      undefined,
      { kind: 'approve', emails: ['c@example.com'] },
      NOW,
    );
    expect(out.lines[0]).toBe('Approved 1 waiting request. Invites go out within a minute.');
  });
});
