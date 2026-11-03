import { describe, expect, it } from 'vitest';

import { deletionSummary } from './deletion';

const result = (agents: number, credentials: number, calls: number, live = 0) => ({
  deleted: { agents, credentials, call_history: calls },
  live_calls_ended: live,
});

describe('deletionSummary', () => {
  it('lists what was removed, with plurals', () => {
    expect(deletionSummary(result(2, 1, 7))).toBe(
      'Deleted 2 agents, 1 saved key and 7 call summaries. Twring no longer keeps any of your data.',
    );
    expect(deletionSummary(result(1, 0, 0))).toBe(
      'Deleted 1 agent. Twring no longer keeps any of your data.',
    );
    expect(deletionSummary(result(0, 0, 1))).toBe(
      'Deleted 1 call summary. Twring no longer keeps any of your data.',
    );
  });

  it('says so when there was nothing to delete', () => {
    expect(deletionSummary(result(0, 0, 0))).toBe(
      'Twring had nothing stored for you, so there was nothing to delete.',
    );
  });

  it('mentions calls that were ended', () => {
    expect(deletionSummary(result(1, 1, 0, 1))).toContain(
      'A call that was still running was ended.',
    );
    expect(deletionSummary(result(1, 1, 0, 2))).toContain('2 calls that were still running');
  });
});
