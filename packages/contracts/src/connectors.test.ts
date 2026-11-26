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
  CAN_SEAL_HEADER,
  MAX_SEALED_REPLY_CHUNKS,
  SEALED_FILES_FEATURE,
} from './index';

const envelope = {
  v: 1,
  sender_device: 'dev_aaaaaaaaaaaaaaaaaaaa',
  sender_seq: 1,
  nonce: 'AAAA',
  body: 'BBBB',
  keys: [{ device: 'dev_bbbbbbbbbbbbbbbbbbbb', wrapped: 'CC' }],
};

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
  it('parses a working frame and refuses extra fields', () => {
    const ok = { type: 'sealed.working', agent: 'claude-code', turn_id: `msg_${'a'.repeat(20)}` };
    expect(relayConnectorMessageSchema.parse(ok)).toEqual(ok);
    expect(() => relayConnectorMessageSchema.parse({ ...ok, text: 'x' })).toThrow();
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
  it('a sealed reply may name up to 5 file ids', () => {
    const reply = {
      type: 'sealed.reply',
      agent: 'claude-code',
      turn_id: 'turn-1',
      sealed: envelope,
      final: true,
    };
    const id = (c: string) => `fil_${c.repeat(20)}`;
    const ids = ['a', 'b', 'c', 'd', 'e'].map(id);
    expect(relayConnectorMessageSchema.safeParse(reply).success).toBe(true);
    expect(relayConnectorMessageSchema.safeParse({ ...reply, file_ids: ids }).success).toBe(true);
    expect(
      relayConnectorMessageSchema.safeParse({ ...reply, file_ids: [...ids, id('f')] }).success,
    ).toBe(false);
    expect(relayConnectorMessageSchema.safeParse({ ...reply, file_ids: ['bad'] }).success).toBe(
      false,
    );
  });
  describe('connector message post body, sealed', () => {
    const plain = { local_agent: 'claude-code', text: 'Done', origin: 'agent' };
    const sealedBody = { local_agent: 'claude-code', sealed: [envelope], origin: 'agent' };
    const fileId = 'fil_abcdefghijklmnopqrst';
    it('still parses an old body with only text', () => {
      expect(connectorMessageRequestSchema.parse(plain)).toEqual(plain);
      expect(
        connectorMessageRequestSchema.safeParse({ ...plain, text: '', file_ids: [fileId] }).success,
      ).toBe(true);
    });
    it('parses sealed, with file ids', () => {
      expect(connectorMessageRequestSchema.safeParse(sealedBody).success).toBe(true);
      expect(
        connectorMessageRequestSchema.safeParse({ ...sealedBody, file_ids: [fileId] }).success,
      ).toBe(true);
    });
    it('needs exactly one of text or sealed', () => {
      expect(
        connectorMessageRequestSchema.safeParse({ ...sealedBody, text: 'readable' }).success,
      ).toBe(false);
      expect(
        connectorMessageRequestSchema.safeParse({ local_agent: 'claude-code', origin: 'agent' })
          .success,
      ).toBe(false);
    });
    it('bounds the sealed chunks and refuses unknown fields', () => {
      expect(connectorMessageRequestSchema.safeParse({ ...sealedBody, sealed: [] }).success).toBe(
        false,
      );
      expect(
        connectorMessageRequestSchema.safeParse({
          ...sealedBody,
          sealed: Array.from({ length: MAX_SEALED_REPLY_CHUNKS + 1 }, () => envelope),
        }).success,
      ).toBe(false);
      expect(connectorMessageRequestSchema.safeParse({ ...plain, extra: 1 }).success).toBe(false);
      expect(connectorMessageRequestSchema.safeParse({ ...sealedBody, extra: 1 }).success).toBe(
        false,
      );
    });
  });
  it('names the sealed files feature word and the can-seal header', () => {
    expect(SEALED_FILES_FEATURE).toBe('sealed_files');
    expect(SEALED_FILES_FEATURE.length).toBeLessThanOrEqual(32);
    expect(CAN_SEAL_HEADER).toBe('twring-can-seal');
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
