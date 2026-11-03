import { describe, expect, it } from 'vitest';

import { answeredRing, openedNotificationRoute } from './system-call';

const ring = {
  type: 'cord.ring',
  invite_id: 'inv_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  agent_name: 'Hermes',
  reason: 'The build failed',
  expires_at: '2026-10-20T10:00:30.000Z',
  server_time: '2026-10-20T10:00:00.000Z',
};

describe('iOS system call', () => {
  it('takes an answered ring from the VoIP payload, and ignores anything else', () => {
    expect(answeredRing({ ...ring, aps: {} })).toMatchObject({ invite_id: ring.invite_id });
    expect(answeredRing(null)).toBeUndefined();
    expect(answeredRing({ type: 'cord.message' })).toBeUndefined();
  });

  it('opens a message notification in its chat, and a missed call in Recents', () => {
    expect(openedNotificationRoute({ type: 'cord.message', agent_id: 'agt_1' })).toEqual({
      pathname: '/chats/[agentId]',
      params: { agentId: 'agt_1' },
    });
    expect(openedNotificationRoute({ type: 'cord.ring_cancel', status: 'missed' })).toEqual({
      pathname: '/history',
    });
    expect(openedNotificationRoute({ type: 'cord.message' })).toBeUndefined();
    expect(openedNotificationRoute(undefined)).toBeUndefined();
  });
});
