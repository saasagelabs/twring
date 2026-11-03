import { describe, expect, it } from 'vitest';

import {
  phoneSocketFrameSchema,
  sendMessageRequestSchema,
  threadMessageSchema,
  threadSocketFrameSchema,
} from './threads';

it('accepts only phone focus frames', () => {
  expect(
    phoneSocketFrameSchema.safeParse({ type: 'focus', agent_id: common.agent_id }).success,
  ).toBe(true);
  expect(phoneSocketFrameSchema.safeParse({ type: 'focus', agent_id: null }).success).toBe(true);
  expect(phoneSocketFrameSchema.safeParse({ type: 'focus', agent_id: 'bad' }).success).toBe(false);
  expect(
    phoneSocketFrameSchema.safeParse({ type: 'focus', agent_id: null, extra: 1 }).success,
  ).toBe(false);
  expect(phoneSocketFrameSchema.safeParse({ type: 'message.upserted' }).success).toBe(false);
});

const common = {
  id: `msg_${'a'.repeat(20)}`,
  agent_id: `agt_${'a'.repeat(20)}`,
  seq: 1,
  rev: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const client_id = 'be8f4ca2-54aa-4aaa-8a6b-4b7e348834ed';

describe('thread messages', () => {
  it.each([
    { kind: 'user_text', text: 'hello', status: 'queued', client_id },
    { kind: 'agent_text', text: 'reply', cut: false, partial: false },
    { kind: 'call', call_id: 'call_1', duration_s: 12, outcome: 'completed' },
    { kind: 'ring', invite_id: `inv_${'a'.repeat(26)}`, reason: 'hello', outcome: 'missed' },
    { kind: 'notice', code: 'new_session' },
  ])('parses $kind', (variant) => {
    expect(threadMessageSchema.parse({ ...common, ...variant }).kind).toBe(variant.kind);
  });

  it('rejects an unknown kind', () => {
    expect(threadMessageSchema.safeParse({ ...common, kind: 'unknown' }).success).toBe(false);
  });
});

describe('send message request', () => {
  it('trims text', () => {
    expect(sendMessageRequestSchema.parse({ client_id, text: ' hello \n' }).text).toBe('hello');
  });

  it.each(['', '  \n ', 'x'.repeat(4_001), 'hi\u0000there', 'hi\u001bthere'])(
    'rejects invalid text',
    (text) => {
      expect(sendMessageRequestSchema.safeParse({ client_id, text }).success).toBe(false);
    },
  );

  it('rejects unknown keys and invalid UUIDs', () => {
    expect(sendMessageRequestSchema.safeParse({ client_id, text: 'hi', extra: 1 }).success).toBe(
      false,
    );
    expect(sendMessageRequestSchema.safeParse({ client_id: 'bad', text: 'hi' }).success).toBe(
      false,
    );
  });
});

it('validates phone socket frames and bounds progress', () => {
  const message = threadMessageSchema.parse({
    ...common,
    kind: 'user_text',
    text: 'hello',
    status: 'sent',
    client_id,
  });
  expect(threadSocketFrameSchema.parse({ type: 'message.upserted', message })).toEqual({
    type: 'message.upserted',
    message,
  });
  expect(
    threadSocketFrameSchema.safeParse({
      type: 'turn.progress',
      agent_id: common.agent_id,
      message_id: common.id,
      text: 'reply',
      activity: 'Working',
    }).success,
  ).toBe(true);
  expect(
    threadSocketFrameSchema.safeParse({
      type: 'turn.progress',
      agent_id: common.agent_id,
      message_id: common.id,
      text: 'x'.repeat(20_001),
    }).success,
  ).toBe(false);
  expect(
    threadSocketFrameSchema.safeParse({ type: 'thread.cleared', agent_id: common.agent_id })
      .success,
  ).toBe(true);
});
