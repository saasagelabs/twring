import type { NetInfoState } from '@react-native-community/netinfo';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type TwringApi } from '../api/client';

const handles: {
  stopped: boolean;
  reconnect: ReturnType<typeof vi.fn>;
  retryNow: ReturnType<typeof vi.fn>;
}[] = [];
const appListeners: ((state: string) => void)[] = [];
const netListeners: ((state: NetInfoState) => void)[] = [];
const stopNet = vi.fn();
// The library's own jest mock, with its addEventListener recording listeners.
vi.mock('@react-native-community/netinfo', async () => {
  vi.stubGlobal('jest', vi);
  // @ts-expect-error The library ships its jest mock without types.
  const imported: unknown = await import('@react-native-community/netinfo/jest/netinfo-mock.js');
  const mock = (imported as { default: { addEventListener: ReturnType<typeof vi.fn> } }).default;
  mock.addEventListener.mockImplementation((listener: (state: NetInfoState) => void) => {
    netListeners.push(listener);
    return stopNet;
  });
  return { default: mock };
});
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

const net = (type: string, isConnected: boolean, ipAddress?: string) =>
  ({ type, isConnected, details: ipAddress ? { ipAddress } : null }) as unknown as NetInfoState;

describe('thread socket on network changes', () => {
  it('retries when the network returns or changes, and stops listening on sign-out', async () => {
    handles.length = 0;
    netListeners.length = 0;
    const api = {
      listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
      markRead: vi.fn().mockResolvedValue(undefined),
    } as unknown as TwringApi;
    const controller = new ChatController(api, { url: 'wss://x', requireSecureMedia: true });
    await controller.open(agent);
    expect(netListeners).toHaveLength(1);
    const emit = (state: NetInfoState) => netListeners.forEach((listener) => listener(state));
    const { retryNow } = handles[0];
    // The first report on subscribe is the starting point, not a change.
    emit(net('wifi', true, '10.0.0.2'));
    expect(retryNow).not.toHaveBeenCalled();
    emit(net('none', false));
    expect(retryNow).not.toHaveBeenCalled();
    emit(net('wifi', true, '10.0.0.2'));
    expect(retryNow).toHaveBeenLastCalledWith();
    emit(net('cellular', true));
    expect(retryNow).toHaveBeenLastCalledWith({ networkChanged: true });
    emit(net('cellular', true));
    expect(retryNow).toHaveBeenCalledTimes(2);
    await controller.clear();
    expect(stopNet).toHaveBeenCalled();
    // A late event for the signed-out account does nothing.
    emit(net('none', false));
    emit(net('wifi', true, '10.0.0.3'));
    expect(retryNow).toHaveBeenCalledTimes(2);
  });
});

describe('thread socket when the network returns as a different one', () => {
  it('replaces the socket after offline when the new network differs from the last connected one', async () => {
    handles.length = 0;
    netListeners.length = 0;
    const api = {
      listMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      listThreads: vi.fn().mockResolvedValue({ threads: [], files: false }),
      markRead: vi.fn().mockResolvedValue(undefined),
    } as unknown as TwringApi;
    const controller = new ChatController(api, { url: 'wss://x', requireSecureMedia: true });
    await controller.open(agent);
    const emit = (state: NetInfoState) => netListeners.forEach((listener) => listener(state));
    const { retryNow } = handles[0];
    emit(net('wifi', true, '10.0.0.2'));
    // Wi-Fi off with a short gap before mobile data: the socket opened on Wi-Fi may still look open,
    // and a plain retryNow() returns early while a socket exists.
    emit(net('none', false));
    emit(net('cellular', true, '100.64.1.9'));
    expect(retryNow).toHaveBeenLastCalledWith({ networkChanged: true });
    await controller.clear();
  });
});
