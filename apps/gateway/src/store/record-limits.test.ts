import { describe, expect, it } from 'vitest';

import { newAgentId } from '../calls/ids';
import { hashConnectorToken, newConnectorId, newConnectorToken } from '../connectors/pairing';
import { CollectionConnectorRepository, type ConnectorRecord } from '../connectors/store';

import { MemoryCollection } from './collection';
import { MAX_AGENTS_PER_USER, MAX_CONNECTORS_PER_USER, RecordLimitError } from './record-limits';
import { CollectionAgentRepository, type AgentRecord } from './repositories';

const AT = '2026-11-17T00:00:00.000Z';

function agent(userId: string): AgentRecord {
  return {
    id: newAgentId(),
    user_id: userId,
    name: 'Agent',
    protocol: 'cord-rest',
    endpoint_url: 'https://agent.example.com/turns',
    voice_id: 'flux-haley-en',
    keyterms: [],
    status: 'untested',
    created_at: AT,
    updated_at: AT,
    revision: 0,
  };
}

function connector(userId: string): ConnectorRecord {
  return {
    id: newConnectorId(),
    user_id: userId,
    name: 'Laptop',
    token_hash: hashConnectorToken(newConnectorToken()),
    agents: [],
    created_at: AT,
  };
}

describe('per-account record limits', () => {
  it(`refuses agent ${MAX_AGENTS_PER_USER + 1} for one account, not for another`, async () => {
    const agents = new CollectionAgentRepository(new MemoryCollection());
    for (let i = 0; i < MAX_AGENTS_PER_USER; i += 1) await agents.create(agent('u1'));

    await expect(agents.create(agent('u1'))).rejects.toMatchObject({
      name: 'RecordLimitError',
      code: 'account_limit_reached',
      kind: 'agents',
      statusCode: 409,
    });
    expect(await agents.list('u1')).toHaveLength(MAX_AGENTS_PER_USER);
    await expect(agents.create(agent('u2'))).resolves.toMatchObject({ user_id: 'u2' });
  });

  it('holds the agent limit under parallel creates', async () => {
    const agents = new CollectionAgentRepository(new MemoryCollection());
    const results = await Promise.allSettled(
      Array.from({ length: MAX_AGENTS_PER_USER + 5 }, () => agents.create(agent('u1'))),
    );
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
    expect(await agents.list('u1')).toHaveLength(MAX_AGENTS_PER_USER);
  });

  it(`refuses computer ${MAX_CONNECTORS_PER_USER + 1} for one account, not for another`, async () => {
    const connectors = new CollectionConnectorRepository(new MemoryCollection());
    for (let i = 0; i < MAX_CONNECTORS_PER_USER; i += 1) await connectors.create(connector('u1'));

    const refused = connectors.create(connector('u1'));
    await expect(refused).rejects.toBeInstanceOf(RecordLimitError);
    await expect(refused).rejects.toMatchObject({
      code: 'account_limit_reached',
      kind: 'computers',
      statusCode: 409,
    });
    expect(await connectors.list('u1')).toHaveLength(MAX_CONNECTORS_PER_USER);
    await expect(connectors.create(connector('u2'))).resolves.toMatchObject({ user_id: 'u2' });
  });

  it('frees a place when one is removed', async () => {
    const agents = new CollectionAgentRepository(new MemoryCollection());
    const first = await agents.create(agent('u1'));
    for (let i = 1; i < MAX_AGENTS_PER_USER; i += 1) await agents.create(agent('u1'));
    await agents.delete('u1', first.id);
    await expect(agents.create(agent('u1'))).resolves.toMatchObject({ user_id: 'u1' });
  });
});
