import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { applyFrame, emptyChat, upsert } from './chat-store';

const agent = 'agt_abcdefghij0123456789';
const other = 'agt_abcdefghij0123456780';
const id = (letter: string) => `msg_${letter.repeat(20)}`;
const message = (seq: number, rev = seq, overrides: Partial<ThreadMessage> = {}): ThreadMessage =>
  ({
    id: id(String.fromCharCode(97 + seq)),
    agent_id: agent,
    seq,
    rev,
    kind: 'user_text',
    text: 'hello',
    status: 'working',
    client_id: '123e4567-e89b-42d3-a456-426614174000',
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z',
    ...overrides,
  }) as ThreadMessage;

describe('chat store', () => {
  it('sorts by sequence and keeps the highest revision', () => {
    const state = upsert(emptyChat(), [message(3), message(1, 8), message(2)]);
    expect(state.messages.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(upsert(state, [message(1, 7, { text: 'old' })]).messages[0]).toEqual(state.messages[0]);
    expect(state.maxRev).toBe(8);
  });
  it('ignores other agents and preserves the revision cursor on clear', () => {
    const state = upsert(emptyChat(), [message(1, 5)]);
    expect(applyFrame(state, agent, { type: 'thread.cleared', agent_id: other })).toBe(state);
    expect(applyFrame(state, agent, { type: 'thread.cleared', agent_id: agent })).toMatchObject({
      messages: [],
      maxRev: 5,
    });
  });
  it('clears progress on final user status or an answer for its turn', () => {
    const user = message(1, 1, { turn_id: 'turn-1' });
    const progress = applyFrame(upsert(emptyChat(), [user]), agent, {
      type: 'turn.progress',
      agent_id: agent,
      message_id: user.id,
      text: 'typing',
    });
    expect(
      upsert(progress, [message(1, 2, { status: 'answered', turn_id: 'turn-1' })]).progress,
    ).toBeUndefined();
    const answer = message(2, 2, {
      kind: 'agent_text',
      text: 'done',
      turn_id: 'turn-1',
      cut: false,
      partial: false,
    });
    expect(upsert(progress, [answer]).progress).toBeUndefined();
  });
});
