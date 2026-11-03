import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  url: 'http://build.example',
}));

vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError: class extends Error {}, twringApi: () => ({}) }));
vi.mock('@/auth', () => ({ addBeforeSignOut: () => undefined, authHeaders: () => ({}) }));
vi.mock('@/config/env', () => ({
  mobileEnv: { ok: true, env: { CORD_ENV: 'development', API_BASE_URL: 'http://build.example' } },
}));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));
vi.mock('../servers/active', () => ({
  activeServerUrl: () => h.url,
  onActiveServerChanged: (l: () => void) => {
    h.listeners.add(l);
    return () => h.listeners.delete(l);
  },
}));

import { ChatController, chatController } from './chats';

describe('chatController across a server switch', () => {
  it('clears the old controller and rebuilds one for the new address', () => {
    const first = chatController();
    expect(first).toBeInstanceOf(ChatController);
    expect(chatController()).toBe(first);
    const clear = vi.spyOn(first!, 'clear');
    h.url = 'https://home.example.com';
    for (const l of [...h.listeners]) l();
    expect(clear).toHaveBeenCalledTimes(1);
    const second = chatController();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(ChatController);
  });
});
