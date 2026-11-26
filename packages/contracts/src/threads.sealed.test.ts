import { describe, expect, it } from 'vitest';
import {
  MAX_SEALED_BODY_CHARS,
  MAX_SEALED_REPLY_CHUNKS,
  MAX_SEALED_REPLY_TOTAL_CHARS,
  relayConnectorMessageSchema,
  relayGatewayMessageSchema,
  sendSealedMessageRequestSchema,
  threadMessageSchema,
} from './index';
import { newMessageKey, sealBody } from './message-seal';

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
  it('fits a whole 20,000-character reply at 6 JSON bytes a character, split into chunks', () => {
    // Escaped control characters are the worst case: 6 bytes each in the sealed JSON.
    const control = String.fromCharCode(1);
    const key = newMessageKey();
    const aad = new Uint8Array(8);
    const total = (pieces: number) => {
      const size = Math.ceil(20_000 / pieces);
      let sum = 0;
      for (let left = 20_000; left > 0; left -= size)
        sum += sealBody(key, { text: control.repeat(Math.min(size, left)) }, aad).body.length;
      return sum;
    };
    for (const pieces of [3, 4, 16, MAX_SEALED_REPLY_CHUNKS])
      expect(total(pieces)).toBeLessThanOrEqual(MAX_SEALED_REPLY_TOTAL_CHARS);
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

describe('sealed send request files', () => {
  const body = { client_id: 'be8f4ca2-54aa-4aaa-8a6b-4b7e348834ed', sealed };
  const id = (c: string) => `fil_${c.repeat(20)}`;
  it('parses without and with attachment ids', () => {
    expect(sendSealedMessageRequestSchema.safeParse(body).success).toBe(true);
    expect(
      sendSealedMessageRequestSchema.safeParse({ ...body, attachment_ids: [id('a')] }).success,
    ).toBe(true);
  });
  it('allows at most 5 attachment ids, refuses bad ids and unknown fields', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(id);
    expect(
      sendSealedMessageRequestSchema.safeParse({ ...body, attachment_ids: six.slice(0, 5) })
        .success,
    ).toBe(true);
    expect(sendSealedMessageRequestSchema.safeParse({ ...body, attachment_ids: six }).success).toBe(
      false,
    );
    expect(
      sendSealedMessageRequestSchema.safeParse({ ...body, attachment_ids: ['x'] }).success,
    ).toBe(false);
    expect(sendSealedMessageRequestSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});
