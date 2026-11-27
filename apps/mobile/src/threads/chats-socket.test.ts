import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

const handles: {
  stopped: boolean;
  reconnect: ReturnType<typeof vi.fn>;
  retryNow: ReturnType<typeof vi.fn>;
}[] = [];
const appListeners: ((state: string) => void)[] = [];
vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('./socket', () => ({
  connectThreadSocket: () => {
    const handle = {
      stopped: false,
      reconnect: vi.fn(() => {
        handle.stopped = false;
      }),
      retryNow: vi.fn(),
    };
    handles.push(handle);
    return {
      setFocus: () => undefined,
      close: () => undefined,
      stopped: () => handle.stopped,
      reconnect: handle.reconnect,
      retryNow: handle.retryNow,
    };
  },
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock('@/api', () => ({ ApiError }));
vi.mock('@/auth', () => ({
  addBeforeSignOut: () => undefined,
  authHeaders: () => ({}),
  apiAuth: () => undefined,
}));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));

import { ChatController } from './chats';

const agent = 'agt_abcdefghij0123456789';

describe('thread socket on return to the app', () => {
  it('reopens a stopped socket, and retries a disconnected one at once', async () => {
    const api = {
      listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
      markRead: vi.fn().mockResolvedValue(undefined),
    } as unknown as TwringApi;
    const controller = new ChatController(api, { url: 'wss://x', requireSecureMedia: true });
    await controller.open(agent);
    expect(handles).toHaveLength(1);
    appListeners.forEach((listener) => listener('active'));
    expect(handles[0].reconnect).not.toHaveBeenCalled();
    // A socket only waiting out a backoff (lost network) tries again at once.
    expect(handles[0].retryNow).toHaveBeenCalledTimes(1);
    handles[0].stopped = true;
    appListeners.forEach((listener) => listener('background'));
    expect(handles[0].reconnect).not.toHaveBeenCalled();
    appListeners.forEach((listener) => listener('active'));
    expect(handles[0].reconnect).toHaveBeenCalledTimes(1);
    expect(handles[0].retryNow).toHaveBeenCalledTimes(1);
    expect(handles).toHaveLength(1);
  });
});
