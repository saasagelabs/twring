import type { ThreadSummary } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => undefined },
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { ChatController } from './chats';
import { memoryStore } from './outbox-storage';

const summary = (agent: string, at: string): ThreadSummary => ({
  agent_id: agent,
  last_message: null,
  unread: 0,
  last_message_at: at,
  read_seq: 0,
});
const older = summary('agt_' + 'a'.repeat(20), '2026-11-20T00:00:00.000Z');
const newer = summary('agt_' + 'b'.repeat(20), '2026-11-26T00:00:00.000Z');

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the chat list from last time', () => {
  it('is shown before the server answers, then replaced and saved', async () => {
    const summaries = memoryStore();
    summaries.value = [newer, older];
    const reply = deferred<{ threads: ThreadSummary[]; files: boolean }>();
    const controller = new ChatController(
      { listThreads: () => reply.promise } as unknown as TwringApi,
      undefined,
      { summaries },
    );
    expect(controller.isListReady()).toBe(false);
    void controller.refreshList();
    await vi.waitFor(() => expect(controller.isListReady()).toBe(true));
    expect(controller.getSummaries()).toEqual([newer, older]);
    reply.resolve({ threads: [older], files: true });
    await vi.waitFor(() => expect(controller.getSummaries()).toEqual([older]));
    expect(summaries.value).toEqual([older]);
  });

  it('a saved copy that does not parse is dropped, not shown', async () => {
    const summaries = memoryStore();
    summaries.value = [{ agent_id: 'nope' }];
    const controller = new ChatController({} as unknown as TwringApi, undefined, { summaries });
    await vi.waitFor(() => expect(summaries.value).toBeUndefined());
    expect(controller.getSummaries()).toEqual([]);
    expect(controller.isListReady()).toBe(false);
  });

  it('a failed load is ready (rows show) and sign-out removes the saved copy', async () => {
    const summaries = memoryStore();
    const controller = new ChatController(
      {
        listThreads: vi.fn().mockRejectedValue(new ApiError('network', undefined)),
      } as unknown as TwringApi,
      undefined,
      { summaries },
    );
    await controller.refreshList();
    expect(controller.isListReady()).toBe(true);
    summaries.value = [older];
    await controller.clear();
    expect(summaries.value).toEqual([older]);
    await controller.clear({ forget: true });
    expect(summaries.value).toBeUndefined();
    expect(controller.isListReady()).toBe(false);
  });

  it('a reply that lands after a switch is neither shown nor saved', async () => {
    const summaries = memoryStore();
    const reply = deferred<{ threads: ThreadSummary[]; files: boolean }>();
    const controller = new ChatController(
      { listThreads: () => reply.promise } as unknown as TwringApi,
      undefined,
      { summaries },
    );
    const loading = controller.refreshList();
    await controller.clear();
    reply.resolve({ threads: [newer], files: true });
    await loading;
    expect(controller.getSummaries()).toEqual([]);
    expect(summaries.value).toBeUndefined();
  });

  it('chats off counts as ready', async () => {
    const controller = new ChatController({
      listThreads: vi
        .fn()
        .mockRejectedValue(new ApiError('http', undefined, undefined, undefined, 404)),
    } as unknown as TwringApi);
    await controller.refreshList();
    expect(controller.isListReady()).toBe(true);
  });
});
