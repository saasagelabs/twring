import type { Agent } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import type { HistoryEntry } from '../ring/protocol';

import { pickHero } from './hero';

function agent(id: string, online = true): Agent {
  return {
    id,
    name: id,
    protocol: 'cord-connector',
    endpoint_url: 'cord-connector://test',
    voice_id: 'janvi',
    keyterms: [],
    has_credential: false,
    status: 'ready',
    connector_online: online,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function call(agentId: string, time: string): HistoryEntry {
  return {
    call_id: 'call-test',
    agent_id: agentId,
    agent_name: agentId,
    started_at: time,
    duration_s: 12,
    outcome: 'completed',
  };
}

const older = '2026-10-01T00:00:00.000Z';
const newer = '2026-10-02T00:00:00.000Z';

describe('pickHero', () => {
  it('picks the last called online agent, preserving the rest order', () => {
    const agents = [agent('a'), agent('b'), agent('c')];
    expect(pickHero(agents, [call('a', older), call('b', newer)])).toEqual({
      hero: agents[1],
      rest: [agents[0], agents[2]],
    });
  });
  it('falls to the first callable when the last called is offline', () => {
    const agents = [agent('a'), agent('b', false), agent('c')];
    expect(pickHero(agents, [call('b', newer)])).toEqual({
      hero: agents[0],
      rest: [agents[1], agents[2]],
    });
  });
  it('shows the first disabled agent when nobody is callable', () => {
    const agents = [agent('a', false), agent('b', false)];
    expect(pickHero(agents, [call('b', newer)])).toEqual({ hero: agents[0], rest: [agents[1]] });
  });
  it('handles an empty agent list', () => {
    expect(pickHero([], [call('deleted', newer)])).toEqual({ hero: undefined, rest: [] });
  });
  it('ignores a deleted history agent', () => {
    const agents = [agent('a'), agent('b')];
    expect(pickHero(agents, [call('deleted', newer), call('b', older)])).toEqual({
      hero: agents[1],
      rest: [agents[0]],
    });
  });
});
