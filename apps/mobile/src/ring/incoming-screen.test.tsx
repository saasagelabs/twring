import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';

import { RING_RECHECK_MS } from './invite-state';

/**
 * The incoming ring screen as rendered, on a small stand-in for React's hooks: state and refs keep
 * their slot, effects run after a render when their deps change (cleanup first), like React.
 */

type Effect = { deps?: unknown[]; cleanup?: () => void; pending?: () => unknown };
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  effects: [] as Effect[],
  cursor: 0,
  effectCursor: 0,
  dirty: false,
  appListeners: [] as ((next: string) => void)[],
  api: undefined as Record<string, unknown> | undefined,
}));
const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
  a === undefined ||
  b === undefined ||
  a.length !== b.length ||
  a.some((v, i) => !Object.is(v, b[i]));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  const slot = <T,>(init: () => T): { value: T } => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = { value: init() };
    return hooks.slots[i] as { value: T };
  };
  const setter = (s: { value: unknown }) => (next: unknown) => {
    const value = typeof next === 'function' ? (next as (v: unknown) => unknown)(s.value) : next;
    if (!Object.is(value, s.value)) hooks.dirty = true;
    s.value = value;
  };
  return {
    ...actual,
    useState: (initial: unknown) => {
      const s = slot(() =>
        typeof initial === 'function' ? (initial as () => unknown)() : initial,
      );
      return [s.value, setter(s)];
    },
    useReducer: (reducer: (s: unknown, e: unknown) => unknown, initial: unknown) => {
      const s = slot(() => initial);
      return [s.value, (event: unknown) => setter(s)(reducer(s.value, event))];
    },
    useRef: (initial: unknown) => slot(() => ({ current: initial })).value,
    useCallback: (fn: unknown, deps: unknown[]) => {
      const s = slot(() => ({ fn, deps }));
      if (changed(s.value.deps, deps)) s.value = { fn, deps };
      return s.value.fn;
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const i = hooks.effectCursor++;
      const e = (hooks.effects[i] ??= {});
      if (e.pending === undefined && !changed(e.deps, deps) && e.deps !== undefined) return;
      e.pending = fn;
      e.deps = deps;
    },
  };
});
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: {
    addEventListener: (_: string, fn: (next: string) => void) => {
      hooks.appListeners.push(fn);
      return {
        remove: () => {
          hooks.appListeners = hooks.appListeners.filter((l) => l !== fn);
        },
      };
    },
  },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  cancelAnimation: () => undefined,
  Easing: { out: () => undefined, quad: undefined },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (value: number) => ({ value }),
  withRepeat: () => 0,
  withTiming: () => 0,
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }));
vi.mock('expo-haptics', () => ({
  notificationAsync: () => Promise.resolve(),
  impactAsync: () => Promise.resolve(),
  NotificationFeedbackType: {},
  ImpactFeedbackStyle: {},
}));
vi.mock('expo-router', () => ({
  router: { canGoBack: () => false, back: vi.fn(), replace: vi.fn() },
  useFocusEffect: () => undefined,
  useLocalSearchParams: () => ({ inviteId: 'inv_one' }),
}));
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
vi.mock('@/api', () => ({ twringApi: () => hooks.api }));
vi.mock('@/call/start', () => ({ startCall: vi.fn() }));
vi.mock('@/components/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/Sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/components/Waveform', () => ({ Waveform: 'Waveform' }));
vi.mock('@/platform/microphone', () => ({
  microphonePermission: { request: () => Promise.resolve() },
}));
vi.mock('@/platform/ring', () => ({
  ringPlatform: {
    setShowWhenLocked: () => undefined,
    onRingCancel: () => () => undefined,
    clearRing: () => undefined,
    endSystemCall: () => undefined,
    queueDecline: () => undefined,
  },
}));
vi.mock('@/ring/decline-note', async () => import('./decline-note'));
vi.mock('@/ring/invite-state', async () => import('./invite-state'));
vi.mock('@/ring/protocol', async () => import('./protocol'));
vi.mock('@/ring/declines', () => ({ sendDecline: vi.fn() }));
vi.mock('@/ring/service', () => ({
  answerDeviceId: () => Promise.resolve('dev'),
  markRingHandled: () => undefined,
  setShowingInvite: () => undefined,
}));
vi.mock('@/ring/answer-route', () => ({ chatAnswerRoute: () => undefined }));
vi.mock('@/theme/fonts', () => ({ font: {} }));
vi.mock('@/theme/tokens', () => {
  const of = (value: unknown) =>
    new Proxy({}, { get: (_, key) => (typeof key === 'symbol' ? undefined : value) });
  const flat = of(0);
  return { callPalette: flat, radius: flat, space: flat, type: of({}) };
});

const { default: IncomingCallScreen } = await import('../app/incoming/[inviteId]');

type Props = Record<string, unknown> & { children?: ReactNode };
function elements(node: ReactNode): ReactElement<Props>[] {
  const out: ReactElement<Props>[] = [];
  const walk = (n: ReactNode) => {
    Children.forEach(n, (child) => {
      if (!isValidElement<Props>(child)) return;
      out.push(child);
      walk(child.props.children);
    });
  };
  walk(node);
  return out;
}

let tree: ReactElement<Props>[] = [];
/** Renders until state settles, running effects after each render as React would. */
function render() {
  for (let pass = 0; pass < 20; pass++) {
    hooks.dirty = false;
    hooks.cursor = 0;
    hooks.effectCursor = 0;
    tree = elements(IncomingCallScreen());
    for (const e of hooks.effects) {
      if (e.pending === undefined) continue;
      const run = e.pending;
      e.pending = undefined;
      e.cleanup?.();
      const cleanup = run();
      e.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : undefined;
    }
    if (!hooks.dirty) return;
  }
  throw new Error('render did not settle');
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  render();
}
const texts = () =>
  tree
    .filter((e) => e.type === 'Text')
    .flatMap((e) => Children.toArray(e.props.children).filter((c) => typeof c === 'string'));
const tryAgain = () => tree.find((e) => e.type === 'GhostButton' && e.props.label === 'Try again');

const invite = (status: string) => ({
  invite_id: 'inv_one',
  agent_id: 'agt_one',
  agent_name: 'Ada',
  reason: 'Build done',
  status,
  expires_at: new Date(Date.now() + 40_000).toISOString(),
  server_time: new Date().toISOString(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  hooks.slots = [];
  hooks.effects = [];
  hooks.appListeners = [];
});
afterEach(() => {
  for (const e of hooks.effects) e.cleanup?.();
  vi.useRealTimers();
});

describe('incoming ring screen re-checks', () => {
  it('lets a slow re-check finish: no abort, no duplicate, and its "cancelled" ends the ring', async () => {
    const first = deferred<unknown>();
    const slow = deferred<unknown>();
    const signals: AbortSignal[] = [];
    const getInvite = vi.fn((_id: string, signal: AbortSignal) => {
      signals.push(signal);
      return getInvite.mock.calls.length === 1 ? first.promise : slow.promise;
    });
    hooks.api = { getInvite, getAgent: () => new Promise(() => undefined) };
    render();
    first.resolve(invite('pending'));
    await flush();
    expect(getInvite).toHaveBeenCalledTimes(1);

    // The re-check starts and hangs; the next tick and a return to the foreground both come.
    await vi.advanceTimersByTimeAsync(RING_RECHECK_MS);
    render();
    expect(getInvite).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RING_RECHECK_MS);
    for (const listener of hooks.appListeners) listener('active');
    render();
    expect(getInvite).toHaveBeenCalledTimes(2);
    expect(signals[1]?.aborted).toBe(false);

    slow.resolve(invite('cancelled'));
    await flush();
    expect(texts()).toContain('Your agent hung up');
  });

  it('keeps Try again when a re-check after a failed answer says answered', async () => {
    let status = 'pending';
    const getInvite = vi.fn(() => Promise.resolve(invite(status)));
    const answerInvite = vi.fn(() => Promise.reject(new ApiError('network')));
    hooks.api = { getInvite, answerInvite, getAgent: () => new Promise(() => undefined) };
    render();
    await flush();
    const answer = tree.find((e) => e.props.accessibilityLabel === 'Answer call from Ada');
    (answer?.props.onPress as () => void)();
    await flush();
    await flush();
    expect(tryAgain()).toBeDefined();

    status = 'answered';
    await vi.advanceTimersByTimeAsync(RING_RECHECK_MS);
    await flush();
    expect(getInvite.mock.calls.length).toBeGreaterThan(1);
    expect(tryAgain()).toBeDefined();
  });
});
