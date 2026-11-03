import type { Agent, ThreadSummary } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { agentStatusLine, orderAgents, totalUnread } from './order';

const agent = (id: string, name: string, online?: boolean): Agent =>
  ({
    id,
    name,
    protocol: online === undefined ? 'cord-rest' : 'cord-connector',
    connector_online: online,
  }) as Agent;
const thread = (agentId: string, at: string | null, unread = 0): ThreadSummary =>
  ({ agent_id: agentId, last_message_at: at, unread }) as ThreadSummary;

describe('Agents home presentation', () => {
  it('puts online computer agents first, then recent activity, then name without mutating input', () => {
    const agents = [
      agent('a', 'Zulu'),
      agent('b', 'Beta', false),
      agent('c', 'Alpha', true),
      agent('d', 'Able'),
    ];
    const sorted = orderAgents(agents, [
      thread('a', '2026-10-18T00:00:00Z'),
      thread('b', '2026-10-19T00:00:00Z'),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(agents[0].id).toBe('a');
    expect(
      orderAgents([agent('z', 'Zulu'), agent('a', 'Alpha')], []).map((item) => item.id),
    ).toEqual(['a', 'z']);
  });

  it('uses plain status words for computer and server agents', () => {
    expect(agentStatusLine(agent('a', 'A', true))).toBe('Online');
    expect(agentStatusLine(agent('a', 'A', false))).toBe('Offline');
    expect(agentStatusLine(agent('a', 'A'))).toBe('Server agent');
    expect(agentStatusLine({ ...agent('a', 'A', true), connector_removed: true })).toBe('Offline');
  });

  it('sums unread threads and leaves zero for a hidden badge', () => {
    expect(totalUnread([thread('a', null, 2), thread('b', null, 3)])).toBe(5);
    expect(totalUnread([thread('a', null)])).toBe(0);
    expect(totalUnread([])).toBe(0);
  });
});
