import { userRef } from '@twring/contracts';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthState } from '../auth/controller';

/**
 * The ring coordinator as the root layout drives it, on a stand-in for React's useEffect (it runs
 * again when its deps change, cleanup first) and a ring platform that records the stored ring
 * account: the value the ring gates (Android RingGate, iOS CordRingGate) and the iPhone's
 * notification service extension read.
 */

type Cleanup = (() => void) | undefined;
interface TestState {
  effect: { deps: unknown[]; cleanup: Cleanup } | undefined;
  beforeSignOut: (() => Promise<void>)[];
  auth: AuthState;
  authListeners: Set<() => void>;
  /** Every value written as the stored ring account, in order. */
  account: (string | null)[];
  registered: string[];
  unregistered: string[];
  tokensDeleted: number;
}
const t = vi.hoisted((): TestState => ({
  effect: undefined,
  beforeSignOut: [],
  auth: { status: 'loading' },
  authListeners: new Set(),
  account: [],
  registered: [],
  unregistered: [],
  tokensDeleted: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (run: () => Cleanup | void, deps: unknown[]) => {
      const last = t.effect;
      if (last !== undefined && deps.every((dep, i) => Object.is(dep, last.deps[i]))) return;
      last?.cleanup?.();
      const cleanup = run();
      t.effect = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    },
  };
});

const off = () => () => undefined;
vi.mock('@/platform/ring', () => ({
  ringPlatform: {
    supported: true,
    getPushToken: () => Promise.resolve('fcm-1'),
    deletePushToken: () => {
      t.tokensDeleted += 1;
      return Promise.resolve();
    },
    setRingAccount: (ref: string | null) => t.account.push(ref),
    permissions: () => ({ notifications: true, fullScreen: true, channel: true }),
    requestNotifications: () => Promise.resolve(true),
    takePendingDeclines: () => [],
    queueDecline: () => undefined,
    onRing: off,
    onRingCancel: off,
    onRingDeclined: off,
    onPushToken: off,
  },
}));
vi.mock('./hosted-seal', () => ({
  hostedSealCalls: () => ({
    register: (id: string) => {
      t.registered.push(id);
      return Promise.resolve();
    },
    unregister: (id: string) => {
      t.unregistered.push(id);
      return Promise.resolve();
    },
  }),
}));
vi.mock('@/auth', () => ({
  addBeforeSignOut: (hook: () => Promise<void>) => t.beforeSignOut.push(hook),
  authController: () => ({
    getState: () => t.auth,
    subscribe: (listener: () => void) => {
      t.authListeners.add(listener);
      return () => t.authListeners.delete(listener);
    },
  }),
  hostedApiAuth: () => undefined,
}));
vi.mock('@/platform/secure-store', () => ({
  secureStore: {
    getItemAsync: (key: string) =>
      Promise.resolve(
        key === 'cord.push_device_id'
          ? 'device-1'
          : key === 'cord.ring_notifications_asked'
            ? '1'
            : null,
      ),
    setItemAsync: () => Promise.resolve(),
    deleteItemAsync: () => Promise.resolve(),
  },
}));
// The real registration (and PushRegistration under it): the '@/' alias only resolves when mocked.
vi.mock('@/servers/ring-registration', () => import('../servers/ring-registration'));
vi.mock('@/servers/profiles', () => ({ profileStore: { active: () => ({ kind: 'hosted' }) } }));
vi.mock('@/servers/auth', () => ({
  selfhost: {
    state: () => ({ status: 'signed_out' }),
    subscribe: off,
    api: { token: () => undefined },
  },
}));
vi.mock('@/servers/active', () => ({ onActiveServerChanged: off }));
vi.mock('@/servers/switching', () => ({
  serverChecked: () => Promise.resolve(),
  setServerRingHooks: () => undefined,
}));
vi.mock('@/servers/sealed-push', () => ({
  isSealedPush: () => false,
  openedSealedRoute: () => Promise.resolve(undefined),
}));
vi.mock('@/servers/ready', () => ({ answerWhenReady: () => Promise.resolve() }));
vi.mock('react-native', () => ({
  Alert: { alert: () => undefined },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('expo-router', () => ({ router: { push: () => undefined } }));
vi.mock('@twring/config/mobile', () => ({ relayUrl: () => '' }));
vi.mock('@/api', () => ({ twringApi: () => undefined }));
vi.mock('@/api/client', () => ({ ApiError: class extends Error {}, createTwringApi: () => ({}) }));
vi.mock('@/api/app-version', () => ({ appVersionLabel: () => 'test' }));
vi.mock('@/auth/random-values', () => ({ installRandomValues: () => undefined }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/observability/sentry', () => ({ reportSealSelfTestFailed: () => undefined }));
vi.mock('@/platform/seal-keys', () => ({ sealKeys: { selfTest: () => Promise.resolve(true) } }));
vi.mock('@/call/session', () => ({ callController: () => undefined }));
vi.mock('@/call/start', () => ({ startCall: () => Promise.resolve() }));
vi.mock('@/threads/auto-listen', () => ({ autoListenTarget: () => undefined }));
vi.mock('./system-answer', () => ({ answerSystemRing: () => Promise.resolve() }));

/** The facts the root layout has on each render (_layout.tsx). */
interface Layout {
  loading: boolean;
  signedIn: boolean;
  member: boolean;
  waitlist: boolean;
}
const COLD_START: Layout = { loading: true, signedIn: false, member: false, waitlist: false };
/** Signed in, access still unknown, being checked, or the check failed (offline). */
const ACCESS_PENDING: Layout = { loading: false, signedIn: true, member: false, waitlist: false };
const MEMBER: Layout = { loading: false, signedIn: true, member: true, waitlist: false };
const WAITLIST: Layout = { loading: false, signedIn: true, member: false, waitlist: true };
const SIGNED_OUT: Layout = { loading: false, signedIn: false, member: false, waitlist: false };

const settle = () => new Promise((done) => setTimeout(done, 0));

/** A fresh app start: the service module (and its registration) loaded anew. */
async function start(): Promise<(layout: Layout) => void> {
  vi.resetModules();
  t.effect = undefined;
  t.beforeSignOut = [];
  t.auth = { status: 'loading' };
  t.authListeners.clear();
  t.account = [];
  t.registered = [];
  t.unregistered = [];
  t.tokensDeleted = 0;
  const { ringState, useRingCoordinator } = await import('./service');
  return (layout) => useRingCoordinator(ringState(layout));
}

describe('the stored ring account across sign-in, access and sign-out', () => {
  let render: (layout: Layout) => void;
  beforeEach(async () => {
    render = await start();
  });

  it('is left alone while sign-in is still loading at a cold start', async () => {
    render(COLD_START);
    await settle();

    expect(t.account).toEqual([]);
    expect(t.unregistered).toEqual([]);
    expect(t.tokensDeleted).toBe(0);
  });

  it('is left alone while access is checked (or could not be checked) for the account', async () => {
    t.auth = { status: 'signed_in', userId: 'user-1' };
    render(COLD_START);
    render(ACCESS_PENDING);
    await settle();

    expect(t.account).toEqual([]);
    expect(t.registered).toEqual([]);
  });

  it('is cleared when the cold start finds nobody signed in (a session that ended while closed)', async () => {
    render(COLD_START);
    t.auth = { status: 'signed_out' };
    render(SIGNED_OUT);
    await settle();

    expect(t.account).toEqual([null]);
  });

  it('names a member once access is known, and is cleared on a real sign-out', async () => {
    t.auth = { status: 'signed_in', userId: 'user-1' };
    render(COLD_START);
    render(ACCESS_PENDING);
    render(MEMBER);
    await settle();
    expect(t.account).toEqual([userRef('user-1')]);
    expect(t.registered).toEqual(['device-1']);

    // The session ended: the auth listener stops the rings, then the layout re-renders signed out.
    t.auth = { status: 'signed_out' };
    t.authListeners.forEach((listener) => listener());
    render(SIGNED_OUT);
    await settle();

    expect(t.account.at(-1)).toBeNull();
    expect(t.unregistered).toEqual(['device-1']);
    expect(t.tokensDeleted).toBe(1);
  });

  it('is cleared before signing out from the app, while the session still works', async () => {
    t.auth = { status: 'signed_in', userId: 'user-1' };
    render(MEMBER);
    await settle();

    expect(t.beforeSignOut).toHaveLength(1);
    await t.beforeSignOut[0]();

    expect(t.account).toEqual([userRef('user-1'), null]);
    expect(t.unregistered).toEqual(['device-1']);
  });

  it('is cleared for an account on the waitlist, which is not rung', async () => {
    t.auth = { status: 'signed_in', userId: 'user-1' };
    render(COLD_START);
    render(ACCESS_PENDING);
    render(WAITLIST);
    await settle();

    expect(t.account).toEqual([null]);
    expect(t.registered).toEqual([]);
  });

  it('keeps a member registered while access is checked again', async () => {
    t.auth = { status: 'signed_in', userId: 'user-1' };
    render(MEMBER);
    await settle();
    render(ACCESS_PENDING);
    await settle();

    expect(t.account).toEqual([userRef('user-1')]);
    expect(t.unregistered).toEqual([]);
    expect(t.tokensDeleted).toBe(0);
  });
});
