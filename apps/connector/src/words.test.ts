import { describe, expect, it } from 'vitest';

import type { ConnectorConfig } from './config';
import type { FetchFn } from './ring';
import { WORDS_EXIT, addWords } from './words';

const TOKEN = `cct_${'t'.repeat(43)}`;

function config(): ConnectorConfig {
  return {
    server: 'https://cord.example.com',
    connector_id: `con_${'d'.repeat(20)}`,
    token: TOKEN,
    name: 'Laptop',
    agents: [
      {
        id: 'claude-code',
        label: 'Claude Code',
        kind: 'claude-code',
        command: 'claude',
        args: [],
        cwd: '/w',
      },
      { id: 'codex', label: 'Codex', kind: 'codex', command: 'codex', args: [], cwd: '/w' },
    ],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function run(words: string[], reply: Response | Error, agent?: string) {
  const calls: { url: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, init });
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  const result = addWords(
    config(),
    { words, ...(agent !== undefined && { agent }) },
    { fetch, print: (line) => lines.push(line) },
  );
  return { result, calls, lines };
}

describe('twring-connect words', () => {
  it('sends the words for the chosen agent with the computer’s key, and says what calls hear', async () => {
    const r = run(
      ['Gowri', ' Lightsail '],
      json(200, { words: ['Gowri', 'Lightsail'], not_added: [] }),
      'codex',
    );
    expect(await r.result).toBe(WORDS_EXIT.added);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe('https://cord.example.com/v1/connectors/words');
    expect(r.calls[0]!.init.method).toBe('POST');
    expect(r.calls[0]!.init.redirect).toBe('error');
    expect((r.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({
      local_agent: 'codex',
      words: ['Gowri', 'Lightsail'],
    });
    expect(r.lines).toEqual([
      'From the next call or voice note, Twring will listen for: Gowri, Lightsail.',
    ]);
  });

  it('says which words did not fit a full list', async () => {
    const r = run(['Kubernetes'], json(200, { words: ['a'], not_added: ['Kubernetes'] }));
    expect(await r.result).toBe(WORDS_EXIT.added);
    expect(r.lines[1]).toBe(
      'The list is full (40 words); not added: Kubernetes. Remove words on the agent’s Words page in the Twring app.',
    );
  });

  it('needs at least one word and a known agent, without calling the server', async () => {
    const none = run(['  '], json(200, {}));
    expect(await none.result).toBe(WORDS_EXIT.error);
    expect(none.calls).toHaveLength(0);
    expect(none.lines[0]).toMatch(/^Say which words/);
    const unknown = run(['Gowri'], json(200, {}), 'gemini');
    expect(await unknown.result).toBe(WORDS_EXIT.error);
    expect(unknown.calls).toHaveLength(0);
    expect(unknown.lines[0]).toMatch(/No agent "gemini"/);
  });

  it('passes on the server’s reason when it refuses', async () => {
    const r = run(
      ['Gowri'],
      json(404, {
        error: { code: 'agent_not_saved', message: 'Save this agent first.', request_id: 'r' },
      }),
    );
    expect(await r.result).toBe(WORDS_EXIT.error);
    expect(r.lines).toEqual(['Save this agent first.']);
  });

  it('says plainly when the server is out of reach or too old', async () => {
    const offline = run(['Gowri'], new Error('offline'));
    expect(await offline.result).toBe(WORDS_EXIT.error);
    expect(offline.lines[0]).toMatch(/Could not reach https:\/\/cord\.example\.com/);
    // What a gateway without this route answers (its not-found handler).
    const old = run(
      ['Gowri'],
      json(404, { error: { code: 'not_found', message: 'No such endpoint.', request_id: 'r' } }),
    );
    expect(await old.result).toBe(WORDS_EXIT.error);
    expect(old.lines).toEqual([
      "This Twring server can't take words yet. Update it, or ask its owner.",
    ]);
  });
});
