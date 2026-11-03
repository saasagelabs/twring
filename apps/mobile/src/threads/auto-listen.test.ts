import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';
import { autoListenTarget } from './auto-listen';

describe('auto Listen', () => {
  it('selects the newest agent text with speech content', () => {
    const messages = [
      { id: 'first', kind: 'agent_text', text: 'Reason' },
      { id: 'blank', kind: 'agent_text', text: '' },
    ] as ThreadMessage[];
    expect(autoListenTarget(messages, true)).toBe('first');
    expect(autoListenTarget(messages, false)).toBeUndefined();
  });
});
