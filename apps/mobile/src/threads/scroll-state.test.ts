import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it } from 'vitest';
import {
  firstUnreadSeq,
  initialPill,
  nextPill,
  pillLabel,
  replyIds,
  shouldAnnounce,
  type PillState,
} from './scroll-state';

const base = {
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  rev: 1,
  created_at: '2026-11-24T10:00:00.000Z',
  updated_at: '2026-11-24T10:00:00.000Z',
};
const reply = (seq: number, text = 'hi'): ThreadMessage =>
  ({ ...base, kind: 'agent_text', id: `msg_reply${seq}`, seq, text }) as ThreadMessage;
const mine = (seq: number): ThreadMessage =>
  ({
    ...base,
    kind: 'user_text',
    id: `msg_user${seq}`,
    seq,
    client_id: '123e4567-e89b-42d3-a456-426614174000',
    text: 'q',
    status: 'answered',
  }) as ThreadMessage;

const viewport = 800;
const far = { distanceFromBottom: 2000, viewportHeight: viewport };
const step = (state: PillState, messages: ThreadMessage[], distanceFromBottom = 2000) =>
  nextPill(state, { ids: replyIds(messages), distanceFromBottom, viewportHeight: viewport });

describe('new reply pill', () => {
  it('stays hidden at the bottom', () => {
    const state = step(initialPill, [reply(1), reply(2)], 0);
    expect(state).toEqual(initialPill);
  });

  it('shows and counts replies that arrive while scrolled up', () => {
    let state = step(initialPill, [reply(1)]);
    expect(state.show).toBe(false);
    state = step(state, [reply(1), reply(2)]);
    expect(state).toMatchObject({ count: 1, show: true });
    state = step(state, [reply(1), reply(2), mine(3), reply(4)]);
    expect(state.count).toBe(2);
    expect(pillLabel(state.count)).toBe('2 new replies');
    expect(pillLabel(1)).toBe('New reply');
  });

  it('does not count a streaming reply growing as new', () => {
    let state = step(initialPill, [reply(1)]);
    state = step(state, [reply(1), reply(2, 'Hel')]);
    const grown = step(state, [reply(1), reply(2, 'Hello there')]);
    expect(grown.count).toBe(1);
    expect(grown).toBe(state);
  });

  it('does not inflate the count when a reconnect replays messages', () => {
    let state = step(initialPill, [reply(1)]);
    state = step(state, [reply(1), reply(2)]);
    state = step(state, [reply(1), reply(2), reply(2)]);
    expect(state.count).toBe(1);
  });

  it('does not count my own messages', () => {
    let state = step(initialPill, [reply(1)]);
    state = step(state, [reply(1), mine(2)]);
    expect(state.show).toBe(false);
  });

  it('hides when the reader reaches the bottom', () => {
    let state = step(initialPill, [reply(1)]);
    state = step(state, [reply(1), reply(2)]);
    state = step(state, [reply(1), reply(2)], 10);
    expect(state).toEqual(initialPill);
  });

  it('counts but stays hidden within a screen of the bottom', () => {
    let state = step(initialPill, [reply(1)], 300);
    state = step(state, [reply(1), reply(2)], 300);
    expect(state).toMatchObject({ count: 1, show: false });
  });

  it('hides when the new reply is deleted or the chat is cleared', () => {
    let state = step(initialPill, [reply(1)]);
    state = step(state, [reply(1), reply(2)]);
    expect(step(state, [reply(1)]).show).toBe(false);
    expect(step(state, []).show).toBe(false);
  });

  it('handles an empty chat', () => {
    const state = nextPill(initialPill, { ids: [], ...far });
    expect(state.show).toBe(false);
    expect(state.count).toBe(0);
  });

  it('announces once per burst', () => {
    let state = step(initialPill, [reply(1)]);
    const shown = step(state, [reply(1), reply(2)]);
    expect(shouldAnnounce(state, shown)).toBe(true);
    state = step(shown, [reply(1), reply(2), reply(3)]);
    expect(shouldAnnounce(shown, state)).toBe(false);
  });
});

describe('unread start', () => {
  it('starts at the first unread agent message', () => {
    expect(firstUnreadSeq([reply(1), mine(2), reply(3), reply(4)], 2)).toBe(3);
  });

  it('ignores my own messages after the marker', () => {
    expect(firstUnreadSeq([reply(1), mine(2), reply(3)], 1)).toBe(3);
  });

  it('starts at the bottom when everything is read', () => {
    expect(firstUnreadSeq([reply(1), reply(2)], 2)).toBeUndefined();
  });

  it('starts at the bottom for an empty chat or an unknown marker', () => {
    expect(firstUnreadSeq([], 0)).toBeUndefined();
    expect(firstUnreadSeq([reply(1)], undefined)).toBeUndefined();
  });
});
