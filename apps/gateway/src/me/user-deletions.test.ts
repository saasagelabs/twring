import { describe, expect, it } from 'vitest';

import { UserDeletions } from './user-deletions';

describe('UserDeletions', () => {
  it('reports a running deletion and one that started since a read', () => {
    const deletions = new UserDeletions();
    const before = deletions.epoch('alice');
    expect(deletions.interrupted('alice', before)).toBe(false);
    deletions.begin('alice');
    expect(deletions.interrupted('alice', deletions.epoch('alice'))).toBe(true);
    deletions.end('alice');
    expect(deletions.interrupted('alice', before)).toBe(true);
    expect(deletions.interrupted('alice', deletions.epoch('alice'))).toBe(false);
    expect(deletions.interrupted('bob', deletions.epoch('bob'))).toBe(false);
  });

  it('stays running until every overlapping deletion ends', () => {
    const deletions = new UserDeletions();
    deletions.begin('alice');
    deletions.begin('alice');
    deletions.end('alice');
    const now = deletions.epoch('alice');
    expect(deletions.interrupted('alice', now)).toBe(true);
    deletions.end('alice');
    expect(deletions.interrupted('alice', now)).toBe(false);
  });
});
