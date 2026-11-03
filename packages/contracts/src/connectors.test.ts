import { describe, expect, it } from 'vitest';

import {
  claimRequestSchema,
  connectorWordsRequestSchema,
  ringRequestSchema,
  connectorMessageRequestSchema,
  errorCodeSchema,
  relayConnectorMessageSchema,
  relayGatewayMessageSchema,
  sessionScopeSchema,
  createLinkRequestSchema,
  linkQrPayload,
  normalizePairingCode,
  parseLinkInput,
} from './index';

describe('typed code dashes', () => {
  it.each([
    ['hyphen', '‐'],
    ['non-breaking hyphen', '‑'],
    ['figure dash', '‒'],
    ['en dash', '–'],
    ['em dash', String.fromCodePoint(0x2014)],
    ['horizontal bar', '―'],
    ['minus sign', '−'],
    ['ASCII dash', '-'],
  ])('reads a code typed with a %s', (_name, dash) => {
    expect(normalizePairingCode(`abcd${dash}efgh`)).toBe('ABCD-EFGH');
    expect(parseLinkInput(`ABCD${dash}EFGH`)).toEqual({ code: 'ABCD-EFGH' });
  });

  it('still refuses other punctuation', () => {
    expect(normalizePairingCode('ABCD_EFGH')).toBeUndefined();
    expect(normalizePairingCode('ABCD‖EFGH')).toBeUndefined();
  });
});

describe('link QR codes', () => {
  it('round-trips a code and server', () => {
    const payload = linkQrPayload('ABCD-EFGH', 'https://203-0-113-7.sslip.io/');
    expect(payload).toBe('cord://link?code=ABCDEFGH&server=https%3A%2F%2F203-0-113-7.sslip.io');
    expect(parseLinkInput(payload)).toEqual({
      code: 'ABCD-EFGH',
      server: 'https://203-0-113-7.sslip.io',
    });
  });

  it('accepts a typed code in any case, with or without the dash', () => {
    expect(parseLinkInput('abcd efgh')).toEqual({ code: 'ABCD-EFGH' });
    expect(parseLinkInput('ABCDEFGH')).toEqual({ code: 'ABCD-EFGH' });
    expect(parseLinkInput(' abcd-efgh ')).toEqual({ code: 'ABCD-EFGH' });
  });

  it('rejects look-alike letters, wrong lengths, and QR codes without a server', () => {
    expect(parseLinkInput('ABCD-EFG0')).toBeUndefined();
    expect(parseLinkInput('ABCDEFG')).toBeUndefined();
    expect(parseLinkInput('cord://link?code=ABCDEFGH')).toBeUndefined();
    expect(parseLinkInput('cord://link?code=ABCDEFGH&server=%E0%A4%A')).toBeUndefined();
    expect(parseLinkInput('https://example.com/?code=ABCDEFGH')).toBeUndefined();
  });
});

describe('createLinkRequestSchema', () => {
  const agent = { local_agent: 'claude-code', kind: 'claude-code', label: 'Claude Code' };

  it('caps the computer name and the agent list', () => {
    expect(
      createLinkRequestSchema.safeParse({ computer_name: 'x'.repeat(41), agents: [agent] }).success,
    ).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...agent, local_agent: `a${i}` }));
    expect(createLinkRequestSchema.safeParse({ computer_name: 'Mac', agents: nine }).success).toBe(
      false,
    );
    expect(
      createLinkRequestSchema.safeParse({ computer_name: 'Mac', agents: [agent, agent] }).success,
    ).toBe(false);
    expect(
      createLinkRequestSchema.safeParse({ computer_name: 'Mac\u202e', agents: [agent] }).success,
    ).toBe(false);
    expect(
      createLinkRequestSchema.safeParse({ computer_name: ' Mac ', agents: [agent] }).data
        ?.computer_name,
    ).toBe('Mac');
  });
});

describe('claimRequestSchema shared', () => {
  const claim = {
    code: 'K7QM-2XPA',
    name: 'Server',
    agents: [{ id: 'claude-code', label: 'Claude Code', kind: 'claude-code' }],
  };
  it('accepts an optional boolean shared flag', () => {
    expect(claimRequestSchema.safeParse(claim).success).toBe(true);
    expect(claimRequestSchema.safeParse({ ...claim, shared: true }).success).toBe(true);
    expect(claimRequestSchema.safeParse({ ...claim, shared: 'yes' }).success).toBe(false);
  });
});

describe('per-person sessions on shared agents', () => {
  const scope = 'a'.repeat(32);
  it('a session scope is 32 lowercase hex characters', () => {
    expect(sessionScopeSchema.safeParse(scope).success).toBe(true);
    expect(sessionScopeSchema.safeParse('A'.repeat(32)).success).toBe(false);
    expect(sessionScopeSchema.safeParse('a'.repeat(31)).success).toBe(false);
  });
  it('channel.open carries an optional session_scope', () => {
    const open = { type: 'channel.open', channel: 'ch_1', agent: 'claude-code' };
    expect(relayGatewayMessageSchema.safeParse(open).success).toBe(true);
    const scoped = relayGatewayMessageSchema.parse({ ...open, session_scope: scope });
    expect(scoped).toMatchObject({ session_scope: scope });
    expect(relayGatewayMessageSchema.safeParse({ ...open, session_scope: 'x' }).success).toBe(
      false,
    );
  });
  it('connector.hello advertises optional features', () => {
    const hello = {
      type: 'connector.hello',
      protocol: 'cord-relay/1',
      agent_protocol: 'cord-agent/1',
      agents: [{ id: 'claude-code', label: 'Claude Code', kind: 'claude-code' }],
    };
    expect(
      relayConnectorMessageSchema.parse({ ...hello, features: ['scoped_sessions'] }),
    ).toMatchObject({ features: ['scoped_sessions'] });
  });
  it('a connector message may name a session scope', () => {
    const message = { local_agent: 'claude-code', text: 'Done', origin: 'call_turn' };
    expect(
      connectorMessageRequestSchema.safeParse({ ...message, session_scope: scope }).success,
    ).toBe(true);
    expect(
      connectorMessageRequestSchema.safeParse({ ...message, session_scope: 'x' }).success,
    ).toBe(false);
  });
  it('has the computer_link_outdated error code', () => {
    expect(errorCodeSchema.safeParse('computer_link_outdated').success).toBe(true);
  });
});

describe('agent-run ring and words carry a session scope', () => {
  const scope = 'a'.repeat(32);
  it('accepts session_scope on ring and words requests', () => {
    expect(
      ringRequestSchema.safeParse({ local_agent: 'codex', reason: 'Done', session_scope: scope })
        .success,
    ).toBe(true);
    expect(
      connectorWordsRequestSchema.safeParse({
        local_agent: 'codex',
        words: ['Gowri'],
        session_scope: scope,
      }).success,
    ).toBe(true);
    expect(
      ringRequestSchema.safeParse({ local_agent: 'codex', reason: 'Done', session_scope: 'x' })
        .success,
    ).toBe(false);
  });
});
