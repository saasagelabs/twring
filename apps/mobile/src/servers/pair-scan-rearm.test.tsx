import { buildPairLink } from '@twring/contracts';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pair screen with the REAL QrScanner, driven by a tiny hook runtime (state, refs and effects
 * per component) so the scanner's re-arm timer runs for real under fake timers.
 */
interface Instance {
  slots: unknown[];
  cursor: number;
  effects: { deps: unknown[] | undefined; cleanup?: () => void }[];
  effectCursor: number;
}

const mocks = vi.hoisted(() => ({
  current: null as Instance | null,
  checkServer: vi.fn(),
}));

const cur = () => mocks.current as Instance;

const authMocks = vi.hoisted(() => ({
  status: 'signed_out',
  signOut: vi.fn(),
  switchToHosted: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const inst = cur();
      const slot = inst.cursor++;
      if (!(slot in inst.slots)) inst.slots[slot] = initial;
      return [
        inst.slots[slot],
        (next: unknown) => {
          inst.slots[slot] =
            typeof next === 'function'
              ? (next as (value: unknown) => unknown)(inst.slots[slot])
              : next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const inst = cur();
      const slot = inst.cursor++;
      if (!(slot in inst.slots)) inst.slots[slot] = { current: initial };
      return inst.slots[slot];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const inst = cur();
      const slot = inst.effectCursor++;
      const prior = inst.effects[slot];
      const same =
        prior !== undefined &&
        deps !== undefined &&
        prior.deps !== undefined &&
        deps.every((dep, i) => Object.is(dep, prior.deps?.[i]));
      if (same) return;
      prior?.cleanup?.();
      const next: Instance['effects'][number] = { deps };
      inst.effects[slot] = next;
      pending.push(() => {
        next.cleanup = effect() ?? undefined;
      });
    },
  };
});
const pending: (() => void)[] = [];

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  cancelAnimation: vi.fn(),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: (value: number) => ({ value }),
  withRepeat: vi.fn(),
  withTiming: vi.fn(),
}));
vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: true, canAskAgain: true }, vi.fn()],
}));
vi.mock('expo-router', () => ({
  router: { replace: vi.fn(), push: vi.fn() },
  useLocalSearchParams: () => ({}),
}));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: true, env: { CORD_ENV: 'production' } } }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/QrScanner', async () => await import('../components/QrScanner'));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: vi.fn() }));
vi.mock('@/platform/seal-keys', () => ({ sealKeys: {} }));
vi.mock('@/servers/profiles', () => ({ profileStore: {} }));
vi.mock('@/servers/address', async () => await import('./address'));
vi.mock('@/servers/server-check', () => ({ checkServer: mocks.checkServer }));
vi.mock('@/auth', () => ({
  useAuth: () => ({ status: authMocks.status }),
  authController: () => ({ signOut: authMocks.signOut }),
}));
vi.mock('@/servers/switching', () => ({ switchToHosted: authMocks.switchToHosted }));
vi.mock('@/servers/pairing', () => ({ pairWithServer: vi.fn() }));
vi.mock('@/theme/fonts', () => ({ font: { display: 'd', body: 'b' } }));
vi.mock('@/theme/tokens', () => ({
  radius: new Proxy({}, { get: () => 0 }),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({
    textPrimary: '#fff',
    textSecondary: '#aaa',
    accent: '#0ff',
    border: '#333',
  }),
  space: { lg: 16 },
}));

import PairScreen from '../app/pair';

const ID = 'srv_' + 'a'.repeat(32);
const GOOD = buildPairLink({ server: 'https://home.example.com', code: 'ABCD-EFGH', serverId: ID });
const BAD = 'https://example.com/not-a-link';

type Props = {
  label?: string;
  onPress?: () => unknown;
  onScanned?: (data: string) => unknown;
  onBarcodeScanned?: (event: { data: string }) => void;
};

function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; footer?: ReactNode } & Props>;
  return [
    element as ReactElement<Props>,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
  ];
}

const fresh = (): Instance => ({ slots: [], cursor: 0, effects: [], effectCursor: 0 });
let pair = fresh();
let scanner = fresh();

function draw<T>(inst: Instance, build: () => T): T {
  mocks.current = inst;
  inst.cursor = 0;
  inst.effectCursor = 0;
  const out = build();
  pending.splice(0).forEach((run) => run());
  return out;
}

/** Renders the pair screen, then the scanner it shows (if any); returns the camera's handler. */
function renderAll(): { pressScan?: () => unknown; fire?: (data: string) => void } {
  const tree = draw(pair, () => PairScreen());
  const pressScan = elements(tree).find((e) => e.props.label === 'Scan the code')?.props.onPress;
  const qr = elements(tree).find((e) => typeof e.type === 'function');
  if (qr === undefined) return { pressScan };
  const type = qr.type as (props: unknown) => ReactElement;
  const shown = draw(scanner, () => type(qr.props));
  const camera = elements(shown).find((e) => e.type === 'CameraView');
  const handler = camera?.props.onBarcodeScanned;
  return { fire: handler === undefined ? undefined : (data) => handler({ data }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  pair = fresh();
  scanner = fresh();
  mocks.checkServer.mockReset();
  mocks.checkServer.mockResolvedValue({ ok: true, info: { server_id: ID }, publicKey: 'k' });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pair screen scanning with the real scanner', () => {
  it('still handles a good code after two identical bad ones', async () => {
    void renderAll().pressScan?.();
    renderAll();
    for (let i = 0; i < 2; i++) {
      renderAll().fire?.(BAD);
      renderAll();
      await vi.advanceTimersByTimeAsync(2_100);
      renderAll();
    }
    expect(mocks.checkServer).not.toHaveBeenCalled();
    renderAll().fire?.(GOOD);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.checkServer).toHaveBeenCalledTimes(1);
  });
});
