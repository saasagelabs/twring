import { describe, expect, it } from 'vitest';
import {
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
      threadMessageSchema.parse({ ...common, kind: 'sealed', author: 'user', sealed }).kind,
    ).toBe('sealed');
  });
  it('has no text field to leak', () => {
    const parsed = threadMessageSchema.parse({
      ...common,
      kind: 'sealed',
      author: 'agent',
      sealed,
    });
    expect('text' in parsed).toBe(false);
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
