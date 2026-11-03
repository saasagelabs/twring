import type { CallState } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { callError } from './controller';
import { feedbackFor } from './feedback';

const s = (
  status: 'CONNECTING' | 'LISTENING' | 'RECONNECTING' | 'USER_SPEAKING' | 'ENDING' | 'ENDED',
) => ({ status }) as CallState;

describe('feedbackFor', () => {
  it('marks connect, reconnect, end, and failure', () => {
    expect(feedbackFor(s('CONNECTING'), s('LISTENING'))).toBe('connected');
    expect(feedbackFor(s('RECONNECTING'), s('LISTENING'))).toBe('reconnected');
    expect(feedbackFor(s('ENDING'), s('ENDED'))).toBe('ended');
    expect(
      feedbackFor(s('LISTENING'), {
        status: 'FAILED',
        error: callError('NETWORK_LOST'),
      }),
    ).toBe('error');
  });

  it('stays quiet for ordinary turn-taking and repeated states', () => {
    expect(feedbackFor(s('USER_SPEAKING'), s('LISTENING'))).toBeUndefined();
    expect(feedbackFor(s('LISTENING'), s('USER_SPEAKING'))).toBeUndefined();
    expect(feedbackFor(s('ENDED'), s('ENDED'))).toBeUndefined();
  });
});
