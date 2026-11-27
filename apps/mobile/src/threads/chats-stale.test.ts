import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

const sockets: { onState: (state: string) => void; onFrame: (frame: unknown) => void }[] = [];
const appListeners = vi.hoisted(() => [] as ((state: string) => void)[]);
vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('./socket', () => ({
  connectThreadSocket: (options: {
    onState: (state: string) => void;
    onFrame: (frame: unknown) => void;
  }) => {
    sockets.push(options);
    return {
      setFocus: () => undefined,
      close: () => undefined,
      stopped: () => false,
      reconnect: () => undefined,
    };
  },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => undefined },
}));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
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

describe('stale chat data', () => {
  const pageApi = (
    page: () => ThreadMessage[],
    listThreads = vi.fn().mockResolvedValue({ threads: [], files: false }),
  ) =>
    ({
      listMessages: vi.fn<TwringApi['listMessages']>((_agent, options) =>
        Promise.resolve(
          options?.afterRev !== undefined
            ? { messages: [], hasMore: false }
            : { messages: page(), hasMore: false },
        ),
      ),
      listThreads,
      markRead: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(() => new Promise<never>(() => undefined)),
    }) as unknown as TwringApi;

  it('drops cached messages deleted elsewhere when the chat opens again', async () => {
    let page = [message(1), message(2), message(3)];
    const controller = new ChatController(pageApi(() => page));
    await controller.open(agent);
    await settle();
    controller.closeChat(agent);
    page = [message(1), message(3)];
    await controller.open(agent);
    await settle();
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([1, 3]);
  });

  it('a clear on another device drops the draft and queued sends here', async () => {
    const controller = new ChatController(
      pageApi(() => [message(1)]),
      {
        url: 'wss://x',
        requireSecureMedia: true,
      },
    );
    await controller.open(agent);
    await settle();
    controller.setDraft(agent, 'half typed');
    controller.send(agent, 'queued');
    await settle();
    expect(controller.getPending(agent)).toHaveLength(1);
    sockets.at(-1)!.onFrame({ type: 'thread.cleared', agent_id: agent });
    await settle();
    expect(controller.getChat(agent).messages).toEqual([]);
    expect(controller.getPending(agent)).toEqual([]);
    expect(await controller.getDraft(agent)).toBe('');
  });

  it('asks again after chats were off, with a growing wait', async () => {
    let now = 0;
    const timers = { setTimeout: () => 0, clearTimeout: () => undefined, now: () => now };
    const listThreads = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('http', undefined, undefined, undefined, 404))
      .mockRejectedValueOnce(new ApiError('http', undefined, undefined, undefined, 404))
      .mockResolvedValue({ threads: [], files: false });
    const controller = new ChatController(
      pageApi(() => [], listThreads),
      undefined,
      {},
      timers,
    );
    await controller.refreshList();
    expect(controller.getAvailability()).toBe(false);
    await controller.refreshList();
    expect(listThreads).toHaveBeenCalledTimes(1);
    now = 20_000;
    await controller.refreshList();
    expect(listThreads).toHaveBeenCalledTimes(2);
    now = 50_000;
    await controller.refreshList();
    expect(listThreads).toHaveBeenCalledTimes(2);
    now = 60_000;
    await controller.refreshList();
    expect(listThreads).toHaveBeenCalledTimes(3);
    expect(controller.getAvailability()).toBe(true);
  });
});
