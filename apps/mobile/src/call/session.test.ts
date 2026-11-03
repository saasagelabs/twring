import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    listeners,
    removeAppState: vi.fn(),
    offEnd: vi.fn(),
    offRefused: vi.fn(),
    signOutHooks: [] as (() => Promise<void>)[],
    controllers: [] as {
      view: { call: { status: string }; muted: boolean };
      hangUp: ReturnType<typeof vi.fn>;
      offView: ReturnType<typeof vi.fn>;
    }[],
  };
});

vi.mock('react', () => ({ useSyncExternalStore: vi.fn() }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: h.removeAppState }) },
}));
vi.mock('@twring/contracts', () => ({
  isActive: (c: { status: string }) => c.status === 'ACTIVE',
}));
vi.mock('@/auth', () => ({
  apiAuth: () => undefined,
  setBeforeSignOut: (hook: () => Promise<void>) => void h.signOutHooks.push(hook),
}));
vi.mock('@/api', () => ({ twringApi: () => ({}) }));
vi.mock('@/config/env', () => ({
  mobileEnv: { ok: true, env: { CORD_ENV: 'development', API_BASE_URL: 'http://build.example' } },
}));
vi.mock('@/servers/active', () => ({
  activeServerUrl: () => 'http://build.example',
  onActiveServerChanged: (l: () => void) => {
    h.listeners.add(l);
    return () => h.listeners.delete(l);
  },
  useActiveServer: () => ({ kind: 'hosted' }),
}));
vi.mock('@/observability/sentry', () => ({ callBreadcrumb: () => undefined }));
vi.mock('@/platform/audio-route', () => ({ audioRoutePlatform: {} }));
vi.mock('@/platform/call-service', () => ({
  callBackgroundService: { stop: () => Promise.resolve() },
  onBackgroundEndPressed: () => h.offEnd,
  onBackgroundStartRefused: () => h.offRefused,
}));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: () => undefined }));
vi.mock('@/platform/microphone', () => ({ microphonePermission: {} }));
vi.mock('./api', () => ({ createCallApi: () => ({}) }));
vi.mock('./audio-routes', () => ({ AudioRoutes: class {} }));
vi.mock('./feedback', () => ({ feedbackFor: () => undefined }));
vi.mock('./livekit-transport', () => ({ LiveKitCallTransport: class {} }));
vi.mock('./timers', () => ({ systemTimers: {} }));
vi.mock('./controller', () => ({
  CallController: class {
    view = { call: { status: 'IDLE' }, muted: false };
    hangUp = vi.fn(() => Promise.resolve());
    offView = vi.fn();
    constructor() {
      h.controllers.push(this);
    }
    getView = () => this.view;
    subscribe = () => this.offView;
    retryBackground() {}
    backgroundStartRefused() {}
  },
}));

import { callController } from './session';

const switchServer = () => {
  for (const l of [...h.listeners]) l();
};

describe('callController across a server switch', () => {
  beforeEach(() => {
    switchServer(); // drop whatever an earlier test left cached
    h.controllers.length = 0;
    h.signOutHooks.length = 0;
    vi.clearAllMocks();
  });

  it('builds a new controller and disposes the old one', () => {
    const first = callController();
    expect(callController()).toBe(first);
    switchServer();
    expect(h.removeAppState).toHaveBeenCalledTimes(1);
    expect(h.offEnd).toHaveBeenCalledTimes(1);
    expect(h.offRefused).toHaveBeenCalledTimes(1);
    expect(h.controllers[0].offView).toHaveBeenCalledTimes(1);
    const second = callController();
    expect(second).not.toBe(first);
    expect(h.controllers).toHaveLength(2);
  });

  it('hangs up a live call on the old controller and swallows a rejection', async () => {
    callController();
    const old = h.controllers[0];
    old.view = { call: { status: 'ACTIVE' }, muted: false };
    old.hangUp.mockRejectedValue(new Error('boom'));
    const unhandled = vi.fn();
    const proc = process as unknown as {
      on(e: string, f: () => void): void;
      off(e: string, f: () => void): void;
    };
    proc.on('unhandledRejection', unhandled);
    switchServer();
    await new Promise((r) => setTimeout(r, 0));
    proc.off('unhandledRejection', unhandled);
    expect(old.hangUp).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('the old sign-out hook does nothing once disposed', async () => {
    callController();
    const old = h.controllers[0];
    const hook = h.signOutHooks[0];
    switchServer();
    old.view = { call: { status: 'ACTIVE' }, muted: false };
    await hook();
    expect(old.hangUp).not.toHaveBeenCalled();
  });
});
