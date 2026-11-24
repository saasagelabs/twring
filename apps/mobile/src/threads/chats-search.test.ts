import type { ThreadMessage } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TwringApi } from '../api/client';

vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('./socket', () => ({
  connectThreadSocket: () => ({ setFocus: () => undefined, close: () => undefined }),
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError: class extends Error {} }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { ChatController } from './chats';
import { memorySearchStore, SearchIndex, type SearchStore } from './search-index';

const agent = 'agt_abcdefghij0123456789';
const message = (seq: number, text = `hello ${seq}`): ThreadMessage => ({
  id: `msg_${String.fromCharCode(97 + seq).repeat(20)}`,
  agent_id: agent,
  seq,
  rev: seq,
  kind: 'user_text',
  text,
  status: 'answered',
  client_id: '123e4567-e89b-42d3-a456-426614174000',
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function setup(store: SearchStore = memorySearchStore()) {
  const listMessages = vi.fn<TwringApi['listMessages']>();
  const listThreads = vi.fn<TwringApi['listThreads']>();
  listThreads.mockResolvedValue({ threads: [], files: false });
  const api = {
    listMessages: listMessages.mockResolvedValue({
      messages: [message(1), message(2)],
      hasMore: false,
    }),
    listThreads,
    markRead: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(),
  } as unknown as TwringApi;
  const controller = new ChatController(api, undefined, {
    search: new SearchIndex(store, () => undefined),
  });
  return { listMessages, listThreads, controller, store };
}

describe('chat search sync', () => {
  it('keeps loaded pages and live messages, and drops deleted ones', async () => {
    const store = memorySearchStore();
    const { controller } = setup(store);
    await controller.open(agent);
    await settle();
    expect(store.rows.size).toBe(2);

    controller.frame({ type: 'message.upserted', message: message(3, 'live words') });
    await settle();
    expect((await controller.searchChats('live')).map((row) => row.seq)).toEqual([3]);

    controller.frame({ type: 'message.deleted', agent_id: agent, message_id: message(3).id });
    await settle();
    expect(await controller.searchChats('live')).toEqual([]);

    await controller.deleteMessage(agent, message(1).id);
    await settle();
    expect([...store.rows.keys()]).toEqual([message(2).id]);
  });

  it('a cleared chat and a deleted agent leave the phone', async () => {
    const store = memorySearchStore();
    const { controller } = setup(store);
    await controller.open(agent);
    await settle();
    controller.frame({ type: 'thread.cleared', agent_id: agent });
    await settle();
    expect(store.rows.size).toBe(0);
    await controller.catchUp(agent);
    await settle();
    expect(store.rows.size).toBe(2);
    await controller.forgetAgent(agent);
    expect(store.rows.size).toBe(0);
  });

  it('signing out wipes the copy; switching servers keeps it', async () => {
    const store = memorySearchStore();
    const { controller } = setup(store);
    await controller.open(agent);
    await settle();
    await controller.clear();
    expect(store.rows.size).toBe(2);
    await controller.clear({ forget: true });
    expect(store.rows.size).toBe(0);
  });

  it('a broken store never stops messages from showing', async () => {
    const fail = () => Promise.reject(new Error('disk'));
    const { controller } = setup({
      upsert: fail,
      remove: fail,
      removeAgent: fail,
      wipe: fail,
      search: fail,
      isComplete: fail,
      setComplete: fail,
    });
    await controller.open(agent);
    await settle();
    expect(controller.getChat(agent).messages.map((entry) => entry.seq)).toEqual([1, 2]);
    await expect(controller.deleteMessage(agent, message(1).id)).resolves.toBeUndefined();
    await expect(controller.clear({ forget: true })).resolves.toBeUndefined();
  });

  it('fills older messages of every listed chat through the chat API', async () => {
    const store = memorySearchStore();
    const { listMessages, listThreads, controller } = setup(store);
    listThreads.mockResolvedValue({
      threads: [
        { agent_id: agent, last_message: null, unread: 0, last_message_at: null, read_seq: 0 },
      ],
      files: false,
    });
    await controller.refreshList();
    const signal = new AbortController().signal;
    await controller.fillSearch(signal);
    expect(listMessages).toHaveBeenCalledWith(agent, { limit: 100 }, expect.any(AbortSignal));
    expect(store.rows.size).toBe(2);
    expect(await store.isComplete(agent)).toBe(true);
  });
});
