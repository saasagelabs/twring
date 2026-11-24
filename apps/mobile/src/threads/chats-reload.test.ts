import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

const sockets: { onState: (state: string) => void }[] = [];
vi.mock('./socket', () => ({
  connectThreadSocket: (options: { onState: (state: string) => void }) => {
    sockets.push(options);
    return { setFocus: () => undefined, close: () => undefined };
  },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { ChatController } from './chats';

const agent = 'agt_abcdefghij0123456789';
const message = (seq: number): ThreadMessage => ({
  id: `msg_${String.fromCharCode(97 + seq).repeat(20)}`,
  agent_id: agent,
  seq,
  rev: seq,
  kind: 'user_text',
  text: 'hello',
  status: 'answered',
  client_id: '123e4567-e89b-42d3-a456-426614174000',
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('missed deletes', () => {
  it('reloads the open chat once per reconnect, not on the first connection', async () => {
    let page = [message(1), message(2)];
    const listMessages = vi.fn<TwringApi['listMessages']>((_agent, options) =>
      Promise.resolve(
        options?.afterRev !== undefined
          ? { messages: [], hasMore: false }
          : { messages: page, hasMore: false },
      ),
    );
    const api = {
      listMessages,
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
      markRead: vi.fn().mockResolvedValue(undefined),
    } as unknown as TwringApi;
    const controller = new ChatController(api, { url: 'wss://x', requireSecureMedia: true });
    await controller.open(agent);
    await settle();
    const latestPages = () =>
      listMessages.mock.calls.filter((call) => call[1]?.afterRev === undefined).length;
    expect(latestPages()).toBe(1);
    sockets[0].onState('connected');
    await settle();
    expect(latestPages()).toBe(1);
    // Deleted on another phone while this one was offline.
    page = [message(1)];
    sockets[0].onState('disconnected');
    sockets[0].onState('connected');
    await settle();
    expect(latestPages()).toBe(2);
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([1]);
    await settle();
    expect(latestPages()).toBe(2);
  });

  it('drops a message it deleted, and passes a refusal on', async () => {
    const deleteMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new ApiError('http', 'message_in_progress', undefined, undefined, 409),
      );
    const controller = new ChatController({
      deleteMessage,
      listMessages: vi
        .fn()
        .mockResolvedValue({ messages: [message(1), message(2)], hasMore: false }),
    } as unknown as TwringApi);
    await controller.catchUp(agent);
    await controller.deleteMessage(agent, message(1).id);
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([2]);
    await expect(controller.deleteMessage(agent, message(2).id)).rejects.toMatchObject({
      code: 'message_in_progress',
    });
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([2]);
  });
});

describe('delete failures', () => {
  it('a network failure leaves the message in place', async () => {
    const controller = new ChatController({
      deleteMessage: vi.fn().mockRejectedValue(new ApiError('network')),
      listMessages: vi.fn().mockResolvedValue({ messages: [message(1)], hasMore: false }),
    } as unknown as TwringApi);
    await controller.catchUp(agent);
    await expect(controller.deleteMessage(agent, message(1).id)).rejects.toBeInstanceOf(ApiError);
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([1]);
  });
});
