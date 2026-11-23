import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import type { SharedAgents } from './shared';
import type { AgentRecord, Stores } from '../store/repositories';

import { savedAgentResolver } from './routes';
import { liveCallWords } from './words';

const record = (id: string, user_id: string, keyterms: string[]) =>
  ({
    id,
    user_id,
    name: `Agent ${id}`,
    protocol: 'native-ws',
    endpoint_url: 'https://agent.example.com/ws',
    voice_id: 'x',
    keyterms,
  }) as unknown as AgentRecord;

const owned = [record('a1', 'owner', ['SaaSage']), record('a2', 'owner', ['Rishflips'])];
const stores = {
  agents: {
    get: (userId: string, id: string) =>
      Promise.resolve(owned.find((a) => a.user_id === userId && a.id === id)),
    list: (userId: string) => Promise.resolve(owned.filter((a) => a.user_id === userId)),
  },
  credentials: {},
} as unknown as Stores;
const shared = {
  find: (_userId: string, id: string) => Promise.resolve(owned.find((a) => a.id === id)),
  callerFor: () => undefined,
} as unknown as SharedAgents;
const policy = { env: 'development' as const, lookup: () => Promise.resolve([]) } as never;
const req = (user: string) => ({ user }) as unknown as FastifyRequest;
const userFor = (r: FastifyRequest) => (r as unknown as { user: string }).user;

describe('savedAgentResolver account words (ADR-042)', () => {
  it('gives the owner their name and words from all their agents', async () => {
    const resolve = savedAgentResolver(stores, policy, userFor, shared, () => ({
      name: 'Ada Lovelace',
    }));
    const call = await resolve(req('owner'), 'a1');
    expect(call?.account).toEqual({ ownerName: 'Ada Lovelace', words: ['SaaSage', 'Rishflips'] });
  });

  it('gives a team member on a shared agent no account words and no owner name', async () => {
    const resolve = savedAgentResolver(stores, policy, userFor, shared, () => ({
      name: 'Bob',
    }));
    const call = await resolve(req('member'), 'a1');
    expect(call).toBeDefined();
    expect(call?.account).toBeUndefined();
    expect(call?.agentOwnerId).toBe('owner');
  });

  it('keeps the call when profileFor throws, just without a name', async () => {
    const resolve = savedAgentResolver(stores, policy, userFor, shared, () => {
      throw new Error('no profile');
    });
    const call = await resolve(req('owner'), 'a1');
    expect(call?.account).toEqual({ words: ['SaaSage', 'Rishflips'] });
  });
});

describe('liveCallWords: a mid-call refresh (wordsAdded)', () => {
  it('rebuilds the owner call with account words', () => {
    const out = liveCallWords(owned, {
      agentId: 'a1',
      userId: 'owner',
      keyterms: ['old'],
      account: { ownerName: 'Ada', words: [] },
    });
    expect(out).toEqual({
      agentTerms: ['SaaSage'],
      account: { ownerName: 'Ada', words: ['SaaSage', 'Rishflips'] },
    });
  });

  it('never gives a team member the owner account words on a refresh', () => {
    const out = liveCallWords(owned, { agentId: 'a1', userId: 'member', keyterms: ['old'] });
    expect(out).toEqual({ agentTerms: ['SaaSage'] });
  });

  it('falls back to the call list when the agent was deleted', () => {
    expect(
      liveCallWords([], {
        agentId: 'gone',
        userId: 'owner',
        keyterms: ['old'],
        account: { words: [] },
      }),
    ).toEqual({
      agentTerms: ['old'],
      account: { words: [] },
    });
  });
});
