import { describe, expect, it } from 'vitest';

import {
  agentKeytermsSchema,
  agentProtocolSchema,
  agentSchema,
  createAgentRequestSchema,
  openAiChatEndpoint,
  updateAgentRequestSchema,
} from './agents';

it('accepts a positive photo version only when present', () => {
  const agent = {
    id: `agt_${'a'.repeat(20)}`,
    name: 'Agent',
    protocol: 'cord-rest',
    endpoint_url: 'https://example.com/agent',
    voice_id: 'flux-haley-en',
    has_credential: false,
    status: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  expect(agentSchema.safeParse(agent).success).toBe(true);
  expect(agentSchema.safeParse({ ...agent, avatar_version: 1 }).success).toBe(true);
  expect(agentSchema.safeParse({ ...agent, avatar_version: 0 }).success).toBe(false);
});

it('reads a missing shared flag as not shared', () => {
  const agent = {
    id: `agt_${'a'.repeat(20)}`,
    name: 'Agent',
    protocol: 'cord-rest',
    endpoint_url: 'https://example.com/agent',
    voice_id: 'flux-haley-en',
    has_credential: false,
    status: 'ready',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  expect(agentSchema.parse(agent).shared ?? false).toBe(false);
  expect(agentSchema.parse({ ...agent, shared: true }).shared).toBe(true);
  expect(agentSchema.safeParse({ ...agent, shared: 'yes' }).success).toBe(false);
});

describe('OpenAI-compatible agent contract', () => {
  it('accepts the protocol and normalizes base or full endpoints', () => {
    expect(agentProtocolSchema.parse('openai-chat')).toBe('openai-chat');
    expect(openAiChatEndpoint('https://agent.example.com/v1/')).toBe(
      'https://agent.example.com/v1/chat/completions',
    );
    expect(openAiChatEndpoint('https://agent.example.com/v1/chat/completions')).toBe(
      'https://agent.example.com/v1/chat/completions',
    );
    expect(openAiChatEndpoint('https://agent.example.com/v1?token=a?b')).toBe(
      'https://agent.example.com/v1/chat/completions?token=a?b',
    );
    expect(() => openAiChatEndpoint('wss://agent.example.com/v1')).toThrow();
    expect(() => openAiChatEndpoint('https://agent.example.com/v1#fragment')).toThrow();
  });

  it('bounds and trims the optional model on create and update', () => {
    const create = {
      name: 'Agent',
      protocol: 'openai-chat',
      endpoint_url: 'https://agent.example.com/v1',
      model: ' openclaw:main ',
    };
    expect(createAgentRequestSchema.parse(create).model).toBe('openclaw:main');
    expect(createAgentRequestSchema.safeParse({ ...create, model: ' '.repeat(2) }).success).toBe(
      false,
    );
    expect(createAgentRequestSchema.safeParse({ ...create, model: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(createAgentRequestSchema.safeParse({ ...create, protocol: 'cord-rest' }).success).toBe(
      false,
    );
    expect(updateAgentRequestSchema.parse({ model: ' main ' }).model).toBe('main');
    expect(updateAgentRequestSchema.safeParse({ model: 'x'.repeat(201) }).success).toBe(false);
    expect(updateAgentRequestSchema.parse({ model: null }).model).toBeNull();
  });
});

describe('agent keyterms', () => {
  it('trims and de-duplicates case-insensitively, keeping the first spelling', () => {
    expect(agentKeytermsSchema.parse([' Chennai ', 'chennai', 'Priya', 'PRIYA'])).toEqual([
      'Chennai',
      'Priya',
    ]);
  });

  it('rejects blank, too-long, control, and bidi terms', () => {
    expect(agentKeytermsSchema.safeParse(['  ']).success).toBe(false);
    expect(agentKeytermsSchema.safeParse(['x'.repeat(51)]).success).toBe(false);
    expect(agentKeytermsSchema.safeParse([` ${'x'.repeat(50)} `]).success).toBe(true);
    expect(agentKeytermsSchema.safeParse(['a\nb']).success).toBe(false);
    expect(agentKeytermsSchema.safeParse(['a‮b']).success).toBe(false);
  });

  // Milestone 9 verifier. Invisible characters are built from code points so the source stays plain.
  const cp = (...points: number[]) => String.fromCodePoint(...points);

  it('de-duplicates canonically equivalent spellings (NFC and NFD) and stores NFC', () => {
    const composed = `Caf${cp(0xe9)}`;
    const decomposed = `Cafe${cp(0x301)}`;
    expect(agentKeytermsSchema.parse([decomposed, composed])).toEqual([composed]);
    expect(agentKeytermsSchema.parse([decomposed])).toEqual([composed]);
  });

  it('keeps Indic and other scripts, including the ZWJ/ZWNJ joiners they need', () => {
    const chillu = `${cp(0xd28, 0xd4d, 0x200d)}`; // Malayalam chillu via ZWJ
    const halfForm = `${cp(0x915, 0x94d, 0x200c, 0x937)}`; // Devanagari with ZWNJ
    for (const term of ['சென்னை', 'कोयंबटूर', chillu, halfForm, 'Zürich', '東京']) {
      expect(agentKeytermsSchema.safeParse([term]).success, term).toBe(true);
    }
  });

  it('rejects every bidi control, C1 control, and line/paragraph separator', () => {
    for (const point of [0x200e, 0x200f, 0x61c, 0x2028, 0x2029, 0x85, 0x9b, 0x202e, 0x2067]) {
      expect(agentKeytermsSchema.safeParse([`a${cp(point)}b`]).success, point.toString(16)).toBe(
        false,
      );
    }
  });

  it('allows at most 40 terms', () => {
    const terms = (n: number) => Array.from({ length: n }, (_, i) => `term${i}`);
    expect(agentKeytermsSchema.safeParse(terms(40)).success).toBe(true);
    expect(agentKeytermsSchema.safeParse(terms(41)).success).toBe(false);
  });

  it('is optional on create and accepted alone on update', () => {
    const base = { name: 'A', protocol: 'cord-rest', endpoint_url: 'https://a.example' };
    expect(createAgentRequestSchema.parse(base).keyterms).toBeUndefined();
    expect(createAgentRequestSchema.parse({ ...base, keyterms: ['Madurai'] }).keyterms).toEqual([
      'Madurai',
    ]);
    expect(updateAgentRequestSchema.parse({ keyterms: [] })).toEqual({ keyterms: [] });
  });
});
