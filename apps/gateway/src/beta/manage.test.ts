import { describe, expect, it } from 'vitest';

import { applyMembersOp } from './manage';
import { membersSchema } from './members';

describe('applyMembersOp', () => {
  it('adds to a missing file, normalizes and deduplicates, and produces a valid file', () => {
    const result = applyMembersOp(undefined, {
      kind: 'add',
      emails: [' Z@Example.com ', 'a@example.com', 'z@example.com'],
    });
    expect(result.emails).toEqual(['a@example.com', 'z@example.com']);
    expect(result.added).toEqual(result.emails);
    expect(result.unchanged).toEqual([]);
    expect(membersSchema.parse(JSON.parse(result.next!))).toEqual({ emails: result.emails });
  });

  it('does not rewrite an existing member', () => {
    expect(
      applyMembersOp('{"emails":["a@example.com"]}', { kind: 'add', emails: ['A@EXAMPLE.COM'] }),
    ).toEqual({
      emails: ['a@example.com'],
      added: [],
      removed: [],
      unchanged: ['a@example.com'],
    });
  });

  it('removes a member and reports an absent member as unchanged', () => {
    const result = applyMembersOp('{"emails":["b@example.com","a@example.com"]}', {
      kind: 'remove',
      emails: ['A@example.com', 'absent@example.com'],
    });
    expect(result.emails).toEqual(['b@example.com']);
    expect(result.removed).toEqual(['a@example.com']);
    expect(result.unchanged).toEqual(['absent@example.com']);
  });

  it('refuses to remove the last member', () => {
    expect(() =>
      applyMembersOp('{"emails":["a@example.com"]}', { kind: 'remove', emails: ['a@example.com'] }),
    ).toThrow('refusing to remove every member: the beta would lock everyone out');
  });

  it('rejects invalid input with the original value', () => {
    expect(() => applyMembersOp(undefined, { kind: 'add', emails: [' bad address '] })).toThrow(
      'not a valid email:  bad address ',
    );
  });

  it.each(['{broken', '{"emails":["not-an-email"]}', '{"emails":[],"x":1}'])(
    'rejects invalid current text without echoing it',
    (current) => {
      expect(() => applyMembersOp(current, { kind: 'list' })).toThrowError(
        new Error('beta-members.json is invalid; fix it on the server before changing it'),
      );
    },
  );

  it('lists members sorted without a rewrite', () => {
    const result = applyMembersOp('{"emails":["z@example.com","a@example.com"]}', { kind: 'list' });
    expect(result).toEqual({
      emails: ['a@example.com', 'z@example.com'],
      added: [],
      removed: [],
      unchanged: [],
    });
  });

  it('formats next exactly', () => {
    const result = applyMembersOp(undefined, {
      kind: 'add',
      emails: ['b@example.com', 'a@example.com'],
    });
    expect(result.next).toBe(
      `${JSON.stringify({ emails: ['a@example.com', 'b@example.com'] }, null, 2)}\n`,
    );
  });

  it('requires an email for mutations', () => {
    expect(() => applyMembersOp(undefined, { kind: 'add', emails: [] })).toThrow(
      'name at least one email',
    );
    expect(() => applyMembersOp(undefined, { kind: 'remove', emails: [] })).toThrow(
      'name at least one email',
    );
  });
});
