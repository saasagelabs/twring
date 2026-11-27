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
import { memoryStore } from './outbox-storage';

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

describe('going to the background', () => {
  it('writes a pending outbox save at once', async () => {
    const store = memoryStore();
    const never = () => new Promise<never>(() => undefined);
    const api = {
      listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
      markRead: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn(never),
    } as unknown as TwringApi;
    // Timers that never fire: only the background flush can write.
    const timers = { setTimeout: () => 0, clearTimeout: () => undefined, now: () => Date.now() };
    const controller = new ChatController(
      api,
      { url: 'wss://x', requireSecureMedia: true },
      { outbox: store },
      timers,
    );
    await controller.open(agent);
    await settle();
    controller.send(agent, 'hello');
    await settle();
    expect(store.saves).toBe(0);
    appListeners.at(-1)!('background');
    await settle();
    expect(store.saves).toBe(1);
  });
});

describe('reopening a cached chat after a long gap', () => {
  it.each([false, true])(
    'pages down from the newest page instead of leaving a hole (live frame: %s)',
    async (live) => {
      const numbered = (seq: number): ThreadMessage => ({
        ...message(1),
        id: `msg_${String(seq).padStart(20, '0')}`,
        seq,
        rev: seq,
      });
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) => numbered(from + i));
      let held = range(1, 60);
      const listMessages = vi.fn<TwringApi['listMessages']>((_agent, options) => {
        if (options?.afterRev !== undefined)
          return Promise.resolve({
            messages: held.filter((entry) => entry.rev > (options.afterRev ?? 0)),
            hasMore: false,
          });
        const below =
          options?.beforeSeq !== undefined
            ? held.filter((entry) => entry.seq < (options.beforeSeq ?? 0))
            : held;
        return Promise.resolve({ messages: below.slice(-50), hasMore: below.length > 50 });
      });
      const api = {
        listMessages,
        listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
        markRead: vi.fn().mockResolvedValue(undefined),
      } as unknown as TwringApi;
      const controller = new ChatController(api, { url: 'wss://x', requireSecureMedia: true });
      await controller.open(agent);
      await settle();
      controller.closeChat(agent);
      held = range(1, 140);
      if (live) sockets.at(-1)?.onFrame({ type: 'message.upserted', message: numbered(140) });
      await controller.open(agent);
      await settle();
      for (let i = 0; i < 5 && controller.getChat(agent).hasOlder; i++)
        await controller.loadOlder(agent);
      expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual(
        range(1, 140).map((entry) => entry.seq),
      );
    },
  );
});
