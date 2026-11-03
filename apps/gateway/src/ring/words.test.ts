import {
  MAX_AGENT_KEYTERMS,
  connectorWordsResponseSchema,
  errorResponseSchema,
} from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startConnectorGateway, type ConnectorGateway } from '../connectors/harness';

/** An agent on a linked computer teaches Twring words to listen for (names, places, projects). */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function setup() {
  const g = await startConnectorGateway({ ring: { push: false } });
  gateways.push(g);
  const { token, connectorId } = await g.pair('alice');
  const agentId = await g.createAgent('alice', connectorId);
  return { g, token, agentId };
}

function addWords(g: ConnectorGateway, token: string | undefined, body: unknown) {
  return g.send('POST', '/v1/connectors/words', {
    ...(token !== undefined && { headers: { authorization: `Bearer ${token}` } }),
    body,
  });
}

const code = (res: { json(): unknown }) => errorResponseSchema.parse(res.json()).error.code;

describe('agents add words', () => {
  it('adds words after the owner’s own, once each, and the app shows them', async () => {
    const { g, token, agentId } = await setup();
    const owner = await g.send('PATCH', `/v1/agents/${agentId}`, {
      user: 'alice',
      body: { keyterms: ['Gowri'] },
    });
    expect(owner.statusCode).toBe(200);
    const res = await addWords(g, token, {
      local_agent: 'claude-code',
      words: ['Lightsail', 'gowri', ' Twring ', 'lightsail'],
    });
    expect(res.statusCode).toBe(200);
    expect(connectorWordsResponseSchema.parse(res.json())).toEqual({
      words: ['Gowri', 'Lightsail', 'Twring'],
      not_added: [],
    });
    const shown = await g.send('GET', `/v1/agents/${agentId}`, { user: 'alice' });
    expect(shown.json()).toMatchObject({ keyterms: ['Gowri', 'Lightsail', 'Twring'] });
  });

  it('stops at the list’s limit and says which words did not fit', async () => {
    const { g, token, agentId } = await setup();
    const full = Array.from({ length: MAX_AGENT_KEYTERMS - 1 }, (_, i) => `word${i}`);
    await g.send('PATCH', `/v1/agents/${agentId}`, { user: 'alice', body: { keyterms: full } });
    const res = await addWords(g, token, {
      local_agent: 'claude-code',
      words: ['Kubernetes', 'Lightsail'],
    });
    expect(res.statusCode).toBe(200);
    const body = connectorWordsResponseSchema.parse(res.json());
    expect(body.words).toHaveLength(MAX_AGENT_KEYTERMS);
    expect(body.words.at(-1)).toBe('Kubernetes');
    expect(body.not_added).toEqual(['Lightsail']);
  });

  it('keeps a change the owner makes at the same moment', async () => {
    const { g, token, agentId } = await setup();
    const agents = g.stores.agents;
    const update = agents.update.bind(agents);
    let raced = false;
    agents.update = async (userId, id, patch, at) => {
      if (!raced) {
        raced = true;
        // The owner saves their own word between the agent's read and its write.
        await update(userId, id, { keyterms: ['Gowri'] }, at);
      }
      return update(userId, id, patch, at);
    };
    const res = await addWords(g, token, { local_agent: 'claude-code', words: ['Lightsail'] });
    expect(res.statusCode).toBe(200);
    expect(connectorWordsResponseSchema.parse(res.json()).words).toEqual(['Gowri', 'Lightsail']);
    expect((await agents.get('alice', agentId))?.keyterms).toEqual(['Gowri', 'Lightsail']);
  });

  it('says to try again when the list keeps changing, and loses nothing', async () => {
    const { g, token, agentId } = await setup();
    const agents = g.stores.agents;
    agents.update = () => Promise.resolve(undefined);
    const res = await addWords(g, token, { local_agent: 'claude-code', words: ['Lightsail'] });
    expect(res.statusCode).toBe(503);
    expect(code(res)).toBe('service_unavailable');
    expect((await agents.get('alice', agentId))?.keyterms ?? []).toEqual([]);
  });

  it('writes nothing when every word is already on the list', async () => {
    const { g, token, agentId } = await setup();
    await g.send('PATCH', `/v1/agents/${agentId}`, {
      user: 'alice',
      body: { keyterms: ['Gowri'] },
    });
    const before = await g.stores.agents.get('alice', agentId);
    const res = await addWords(g, token, { local_agent: 'claude-code', words: ['gowri'] });
    expect(connectorWordsResponseSchema.parse(res.json())).toEqual({
      words: ['Gowri'],
      not_added: [],
    });
    expect((await g.stores.agents.get('alice', agentId))?.revision).toBe(before?.revision);
  });

  it('needs the computer’s own key', async () => {
    const { g } = await setup();
    const res = await addWords(g, undefined, { local_agent: 'claude-code', words: ['Gowri'] });
    expect(res.statusCode).toBe(401);
    const wrong = await addWords(g, `cct_${'a'.repeat(43)}`, {
      local_agent: 'claude-code',
      words: ['Gowri'],
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('reaches only an agent the owner saved from this computer', async () => {
    const { g, token } = await setup();
    const res = await addWords(g, token, { local_agent: 'codex', words: ['Gowri'] });
    expect(res.statusCode).toBe(404);
    expect(code(res)).toBe('agent_not_saved');
    // Bob's computer cannot reach Alice's agent.
    const bob = await g.pair('bob');
    const theirs = await addWords(g, bob.token, { local_agent: 'claude-code', words: ['x'] });
    expect(theirs.statusCode).toBe(404);
  });

  it('refuses anything that is not a short plain word or phrase', async () => {
    const { g, token } = await setup();
    for (const words of [[], [''], ['a\nb'], ['x'.repeat(51)], Array(41).fill('w'), 'Gowri']) {
      const res = await addWords(g, token, { local_agent: 'claude-code', words });
      expect(res.statusCode, JSON.stringify(words)).toBe(400);
      expect(code(res)).toBe('bad_request');
    }
  });
});
