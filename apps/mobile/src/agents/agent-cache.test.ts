import { describe, expect, it, vi } from 'vitest';

vi.mock('../threads/chats', () => ({ currentScope: () => undefined }));
vi.mock('../threads/outbox-storage', async () => {
  const actual = await vi.importActual<object>('../threads/outbox-storage');
  return { ...actual, fileStore: vi.fn() };
});
vi.mock('expo-file-system', () => ({}));

import { memoryStore } from '../threads/outbox-storage';

import { agentCache, parseSavedAgents } from './agent-cache';

const agent = {
  id: 'agt_abcdefghij0123456789',
  name: 'Operator',
  protocol: 'cord-native',
  endpoint_url: 'wss://agent.example.com/cord',
  voice_id: 'flux-thalia-en',
  keyterms: [],
  has_credential: true,
  status: 'ready',
  created_at: '2026-09-20T10:00:00.000Z',
  updated_at: '2026-09-20T10:00:00.000Z',
};

function stores() {
  const files = new Map<string, ReturnType<typeof memoryStore>>();
  const store = (scope: string) => {
    if (!files.has(scope)) files.set(scope, memoryStore());
    return files.get(scope)!;
  };
  return { files, store };
}

describe('agent cache', () => {
  it('saves and loads per account and server', async () => {
    const { store } = stores();
    let scope = 'hosted_u1';
    const cache = agentCache(() => scope, store);
    cache.save([agent] as never);
    await Promise.resolve();
    expect(await cache.load()).toHaveLength(1);
    scope = 'hosted_u2';
    expect(await cache.load()).toBeUndefined();
    scope = 'selfhost_s1_p1';
    expect(await cache.load()).toBeUndefined();
  });

  it('reads and writes nothing before the account is known', async () => {
    const { files, store } = stores();
    const cache = agentCache(() => undefined, store);
    cache.save([agent] as never);
    expect(await cache.load()).toBeUndefined();
    expect(files.size).toBe(0);
  });

  it('ignores a malformed or unreadable saved file', async () => {
    const { store } = stores();
    store('hosted_u1').value = { agents: [{ id: 3 }] };
    expect(await agentCache(() => 'hosted_u1', store).load()).toBeUndefined();
    const broken = () => ({ ...memoryStore(), load: () => Promise.reject(new Error('bad')) });
    expect(await agentCache(() => 'hosted_u1', broken).load()).toBeUndefined();
    expect(parseSavedAgents('nope')).toBeUndefined();
    expect(parseSavedAgents({ agents: [agent] })).toHaveLength(1);
  });
});
