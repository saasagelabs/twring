import { describe, expect, it } from 'vitest';
import {
  MAX_SEALED_BODY_CHARS,
  MAX_SEALED_REPLY_CHUNKS,
  MAX_SEALED_REPLY_TOTAL_CHARS,
  relayConnectorMessageSchema,
  relayGatewayMessageSchema,
  threadMessageSchema,
} from './index';

const sealed = {
  v: 1,
  sender_device: 'dev_aaaaaaaaaaaaaaaaaaaa',
  sender_seq: 1,
  nonce: 'AAAA',
  body: 'BBBB',
  keys: [{ device: 'dev_bbbbbbbbbbbbbbbbbbbb', wrapped: 'CC' }],
};
const common = {
  id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  seq: 1,
  rev: 1,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
};

describe('sealed kind', () => {
  it('parses a sealed user message', () => {
    expect(
      threadMessageSchema.parse({ ...common, kind: 'sealed', author: 'user', sealed: [sealed] })
        .kind,
    ).toBe('sealed');
  });
  it('has no text field to leak', () => {
    const parsed = threadMessageSchema.parse({
      ...common,
      kind: 'sealed',
      author: 'agent',
      sealed: [sealed],
    });
    expect('text' in parsed).toBe(false);
  });
  it('holds every chunk of an agent reply, in a bounded list', () => {
    const agent = (list: unknown[]) =>
      threadMessageSchema.safeParse({ ...common, kind: 'sealed', author: 'agent', sealed: list })
        .success;
    const chunk = (index: number, body = 'BBBB') => ({
      ...sealed,
      body,
      chunk: { index, final: false },
    });
    expect(agent([chunk(0), chunk(1), chunk(2)])).toBe(true);
    expect(agent([])).toBe(false);
    expect(agent(Array.from({ length: MAX_SEALED_REPLY_CHUNKS + 1 }, (_, i) => chunk(i)))).toBe(
      false,
    );
    const big = 'A'.repeat(Math.ceil(MAX_SEALED_REPLY_TOTAL_CHARS / 2) + 1);
    expect(agent([chunk(0, big), chunk(1, big)])).toBe(false);
  });
  it('a user message is a list of one at the user cap', () => {
    const user = (list: unknown[]) =>
      threadMessageSchema.safeParse({ ...common, kind: 'sealed', author: 'user', sealed: list })
        .success;
    expect(user([sealed, sealed])).toBe(false);
    expect(user([{ ...sealed, body: 'A'.repeat(MAX_SEALED_BODY_CHARS + 1) }])).toBe(false);
    expect(user([sealed])).toBe(true);
  });
  it('carries sealed frames both ways', () => {
    expect(
      relayGatewayMessageSchema.parse({
        type: 'sealed.message',
        agent: 'claude',
        message_id: common.id,
        sealed,
      }).type,
    ).toBe('sealed.message');
    expect(
      relayConnectorMessageSchema.parse({
        type: 'sealed.reply',
        agent: 'claude',
        turn_id: 't1',
        sealed,
        final: true,
      }).type,
    ).toBe('sealed.reply');
  });
});
