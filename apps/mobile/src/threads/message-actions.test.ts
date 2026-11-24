import type { ThreadMessage } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { replaceLatest, emptyChat, upsert } from './chat-store';
import { DELETE_CONFIRM, deleteFailureCopy, messageActions, quoteLine } from './message-actions';
import { Outbox } from './outbox';
import { memoryStore } from './outbox-storage';

const agent = 'agt_abcdefghij0123456789';
const user = (status: string, seq = 1): ThreadMessage =>
  ({
    id: `msg_${String.fromCharCode(97 + seq).repeat(20)}`,
    agent_id: agent,
    seq,
    rev: seq,
    kind: 'user_text',
    text: 'hello',
    status,
    client_id: '123e4567-e89b-42d3-a456-426614174000',
    created_at: '2026-11-24T00:00:00.000Z',
    updated_at: '2026-11-24T00:00:00.000Z',
  }) as ThreadMessage;
const agentText: ThreadMessage = {
  id: 'msg_zzzzzzzzzzzzzzzzzzzz',
  agent_id: agent,
  seq: 9,
  rev: 9,
  kind: 'agent_text',
  text: 'Sure',
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
} as ThreadMessage;

describe('message actions offered', () => {
  it('offers everything on an answered message and on an agent reply', () => {
    expect(messageActions({ kind: 'message', message: user('answered') })).toEqual([
      'reply',
      'copy',
      'share',
      'delete',
    ]);
    expect(messageActions({ kind: 'message', message: agentText })).toEqual([
      'reply',
      'copy',
      'share',
      'delete',
    ]);
  });
  it('does not offer delete while the agent is still on it', () => {
    for (const status of ['sent', 'working'])
      expect(messageActions({ kind: 'message', message: user(status) })).toEqual([
        'reply',
        'copy',
        'share',
      ]);
  });
  it('offers only copy and share on a message still only on this phone', () => {
    expect(messageActions({ kind: 'pending', text: 'hi' })).toEqual(['copy', 'share']);
    expect(messageActions({ kind: 'pending', text: '' })).toEqual([]);
  });
  it('offers nothing on calls or notices', () => {
    expect(
      messageActions({
        kind: 'message',
        message: { ...agentText, kind: 'notice', code: 'new_session' } as ThreadMessage,
      }),
    ).toEqual([]);
  });
});

describe('copy', () => {
  it('explains a 409 in plain words', () => {
    const error = new ApiError('http', 'message_in_progress', undefined, undefined, 409);
    expect(deleteFailureCopy(error)).toBe(
      'Your agent is still working on this message. You can delete it once it has finished.',
    );
    expect(deleteFailureCopy(new ApiError('network'))).not.toContain('working on this message');
  });
  it('has no em dash and takes the first line of a quote', () => {
    expect(DELETE_CONFIRM).not.toContain(String.fromCharCode(0x2014));
    expect(quoteLine('\n first line\nsecond')).toBe('first line');
    expect(quoteLine('')).toBe('Voice note');
  });
});

describe('reload of the newest page', () => {
  it('drops messages the page no longer holds and keeps newer ones', () => {
    const state = upsert(emptyChat(), [user('answered', 1), user('answered', 2), user('sent', 3)]);
    const next = replaceLatest(state, { messages: [user('answered', 1)], hasMore: false }, 2);
    expect(next.messages.map((message) => message.seq)).toEqual([1, 3]);
  });
  it('leaves messages older than a partial page alone', () => {
    const state = upsert(emptyChat(), [user('answered', 1), user('answered', 2)]);
    const next = replaceLatest(state, { messages: [user('answered', 2)], hasMore: true }, 2);
    expect(next.messages.map((message) => message.seq)).toEqual([1, 2]);
  });
});

describe('replies in the outbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
  type Send = (
    agentId: string,
    request: { clientId: string; text: string; replyTo?: string },
    signal: AbortSignal,
  ) => Promise<ThreadMessage>;
  const echo = (clientId: string) => ({ ...user('sent'), client_id: clientId }) as ThreadMessage;

  it('saves replyTo and resends it with the same clientId after a restart', async () => {
    const store = memoryStore();
    const first = new Outbox(
      vi.fn<Send>(() => new Promise(() => undefined)),
      () => undefined,
      timers,
      undefined,
      { store },
    );
    await first.hydrated;
    const clientId = first.send(agent, 'yes', 'msg_bbbbbbbbbbbbbbbbbbbb');
    await vi.advanceTimersByTimeAsync(300);
    expect((store.value as { items: { replyTo?: string }[] }).items[0].replyTo).toBe(
      'msg_bbbbbbbbbbbbbbbbbbbb',
    );
    const send = vi.fn<Send>((_agent, request) => Promise.resolve(echo(request.clientId)));
    const second = new Outbox(send, () => undefined, timers, undefined, { store });
    await second.hydrated;
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[0][1]).toMatchObject({ clientId, replyTo: 'msg_bbbbbbbbbbbbbbbbbbbb' });
  });

  it('still loads a queue saved before replies existed', async () => {
    const store = memoryStore();
    store.value = {
      version: 1,
      items: [
        {
          clientId: '123e4567-e89b-42d3-a456-426614174001',
          agentId: agent,
          text: 'old',
          state: 'sending',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    };
    const send = vi.fn<Send>((_agent, request) => Promise.resolve(echo(request.clientId)));
    const outbox = new Outbox(send, () => undefined, timers, undefined, { store });
    await outbox.hydrated;
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1].replyTo).toBeUndefined();
  });

  it('sends once more without the reply when the quoted message was deleted', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(new ApiError('http', 'reply_to_not_found', undefined, undefined, 400))
      .mockImplementation((_agent, request) => Promise.resolve(echo(request.clientId)));
    const outbox = new Outbox(send, () => undefined, timers);
    const clientId = outbox.send(agent, 'yes', 'msg_bbbbbbbbbbbbbbbbbbbb');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual({ clientId, text: 'yes' });
    expect(outbox.list(agent)).toEqual([]);
  });

  it('fails rather than loops if the server still refuses without a reply', async () => {
    const refusal = new ApiError('http', 'reply_to_not_found', undefined, undefined, 400);
    const send = vi.fn<Send>().mockRejectedValue(refusal);
    const outbox = new Outbox(send, () => undefined, timers);
    outbox.send(agent, 'yes', 'msg_bbbbbbbbbbbbbbbbbbbb');
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(outbox.list(agent)[0].state).toBe('failed');
  });
});

describe('reload of the newest page: edges', () => {
  const three = () =>
    upsert(emptyChat(), [user('answered', 1), user('answered', 2), user('answered', 3)]);
  it('an empty full page means every known message was deleted, but keeps newer arrivals', () => {
    const next = replaceLatest(three(), { messages: [], hasMore: false }, 2);
    expect(next.messages.map((message) => message.seq)).toEqual([3]);
  });
  it('an empty partial page changes nothing', () => {
    const state = three();
    expect(replaceLatest(state, { messages: [], hasMore: true }, 3)).toBe(state);
  });
  it('the same page applied twice (overlapping reloads) is stable', () => {
    const page = { messages: [user('answered', 2), user('answered', 3)], hasMore: true };
    const once = replaceLatest(three(), page, 3);
    const twice = replaceLatest(once, page, 3);
    expect(twice.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
  });
});

describe('replies in the outbox: voice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('a voice reply whose quote was deleted resends once without it', async () => {
    const calls: { replyTo?: string }[] = [];
    const send = vi.fn((_agent: string, request: { clientId: string; replyTo?: string }) => {
      calls.push({ replyTo: request.replyTo });
      return calls.length === 1
        ? Promise.reject(new ApiError('http', 'reply_to_not_found', undefined, undefined, 400))
        : Promise.resolve({ ...user('sent'), client_id: request.clientId } as ThreadMessage);
    });
    const outbox = new Outbox(send, () => undefined, {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    });
    outbox.sendVoice(agent, 'file:///a.m4a', 2000, 'msg_bbbbbbbbbbbbbbbbbbbb');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ replyTo: 'msg_bbbbbbbbbbbbbbbbbbbb' }, { replyTo: undefined }]);
    expect(outbox.list(agent)).toEqual([]);
  });
});
