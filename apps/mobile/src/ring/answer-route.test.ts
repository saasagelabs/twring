import { describe, expect, it } from 'vitest';
import { chatAnswerRoute } from './answer-route';

describe('ring answer route', () => {
  it('opens chat with one-time Listen for a chat answer', () => {
    expect(chatAnswerRoute({ mode: 'chat', agentId: 'agt_abcdefghij0123456789' })).toEqual({
      pathname: '/chats/[agentId]',
      params: { agentId: 'agt_abcdefghij0123456789', listen: '1' },
    });
  });
  it('leaves call answers on the call path', () => {
    expect(chatAnswerRoute({ mode: 'call', session: {} as never })).toBeUndefined();
  });
});
