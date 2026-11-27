import { describe, expect, it, vi } from 'vitest';

import type * as OutboxStorage from './outbox-storage';

const hooks = vi.hoisted(() => ({
  beforeSignOut: [] as (() => Promise<void>)[],
  removed: [] as string[],
}));

vi.mock('./search-store', () => ({
  sqliteSearchStore: () => undefined,
  deleteSearchDatabase: () => Promise.resolve(),
}));
vi.mock('./socket', () => ({
  connectThreadSocket: () => ({ setFocus: () => undefined, close: () => undefined }),
}));
vi.mock('./sealed-file-cache', () => ({
  clearSealedFiles: () => Promise.resolve(),
  deviceSealedFiles: () => undefined,
  openSealedFile: () => undefined,
  sweepShareCopiesOnce: () => Promise.resolve(),
}));
vi.mock('../e2e/private-chats', () => ({
  forgetPrivateDevice: () => Promise.resolve(),
  PrivateChats: class {
    onRemoved() {}
    onTrustedChanged() {}
    forget() {
      return Promise.resolve();
    }
  },
}));
vi.mock('./outbox-storage', async () => {
  const actual = await vi.importActual<typeof OutboxStorage>('./outbox-storage');
  return {
    ...actual,
    fileStore: (kind: string, scope: string) => ({
      ...actual.memoryStore(),
      remove: () => {
        hooks.removed.push(`${kind}-${scope}`);
        return Promise.resolve();
      },
    }),
  };
});
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('@react-native-community/netinfo', () => ({
  default: { addEventListener: () => () => undefined },
}));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('@/api', () => ({ ApiError: class extends Error {}, twringApi: () => ({}) }));
vi.mock('@/auth', () => ({
  addBeforeSignOut: (hook: () => Promise<void>) => hooks.beforeSignOut.push(hook),
  apiAuth: () => undefined,
  authController: () => undefined,
  authHeaders: () => ({}),
}));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: true, env: { CORD_ENV: 'development' } } }));
vi.mock('@/hooks/useResource', () => ({ STATUS_POLL_MS: 20_000 }));
vi.mock('../servers/active', () => ({
  activeServerUrl: () => 'https://twring.example',
  onActiveServerChanged: () => undefined,
}));
vi.mock('../servers/profiles', () => ({
  profileStore: {
    active: () => ({ kind: 'selfhost', serverId: 's1', person: { id: 'p1' } }),
  },
}));

import { chatController } from './chats';

describe('sign-out', () => {
  it('removes the saved agent list with the rest of the account state', async () => {
    expect(chatController()).toBeDefined();
    expect(hooks.beforeSignOut).toHaveLength(1);
    await hooks.beforeSignOut[0]();
    expect(hooks.removed).toEqual(
      expect.arrayContaining([
        'outbox-selfhost_s1_p1',
        'agents-selfhost_s1_p1',
        'summaries-selfhost_s1_p1',
      ]),
    );
  });
});
