import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { devicesStateFrom } from './devices';

/** The devices screen as rendered (C3 #11, Task 26): hooks are stubbed, state is set directly. */

const mocks = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, push: vi.fn() }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: () => undefined,
    useCallback: (fn: unknown) => fn,
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] = next;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-router', () => ({ router: { push: mocks.push } }));
vi.mock('@/api', () => ({ twringApi: () => undefined }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/SettingsGroup', () => ({
  SettingsGroup: 'SettingsGroup',
  SettingsRow: 'SettingsRow',
}));
vi.mock('@/components/Sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/e2e/device-key', () => ({ readDeviceId: vi.fn() }));
vi.mock('@/e2e/devices', async () => import('./devices'));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: vi.fn() }));
vi.mock('@/threads/chats', () => ({
  forgetThisPhonePrivateKeys: vi.fn(),
  privateKeychain: () => ({}),
}));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16, md: 12 },
}));

const { default: PrivateDevicesScreen } = await import('../app/private/devices');

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
function render() {
  mocks.cursor = 0;
  return elements(PrivateDevicesScreen());
}
const texts = (all: ReactElement<Props>[]) =>
  all
    .filter((e) => e.type === 'Text')
    .flatMap((e) => Children.toArray(e.props.children).filter((c) => typeof c === 'string'));

const at = '2026-11-20T10:00:00.000Z';
const dev = (n: number, kind: 'phone' | 'computer', name: string) => ({
  id: `dev_${String.fromCharCode(97 + n).repeat(20)}`,
  kind,
  name,
  public_key: 'k',
  added_at: at,
});
// useState slots in the screen: state, error, removing, busy, selfId.
const STATE = 0;
const ERROR = 1;
const REMOVING = 2;

beforeEach(() => {
  mocks.state = [];
  mocks.push.mockReset();
});

describe('devices screen', () => {
  it('lists active devices with "This phone" and the count', () => {
    mocks.state[STATE] = devicesStateFrom(
      [dev(0, 'phone', 'Pixel'), dev(1, 'computer', 'Laptop')],
      dev(0, 'phone', 'Pixel').id,
    );
    const all = render();
    expect(all.find((e) => e.type === 'SettingsGroup')?.props.title).toBe('2 of 5 devices');
    const rows = all
      .filter((e) => e.type === 'SettingsRow' && e.props.label !== 'Save a recovery key')
      .map((e) => [e.props.label, e.props.value]);
    expect(rows).toEqual([
      ['Pixel (This phone)', 'Phone, added 2026-11-20'],
      ['Laptop', 'Computer, added 2026-11-20'],
    ]);
    expect(texts(all)).not.toContain('Remove a device to add a new one.');
  });

  it('at the cap says what to do next', () => {
    mocks.state[STATE] = devicesStateFrom([0, 1, 2, 3, 4].map((n) => dev(n, 'phone', 'Pixel')));
    const all = render();
    expect(all.find((e) => e.type === 'SettingsGroup')?.props.title).toBe('5 of 5 devices');
    expect(texts(all)).toContain('Remove a device to add a new one.');
  });

  it('asks before removing, in plain words', () => {
    mocks.state[STATE] = devicesStateFrom([dev(1, 'computer', 'Laptop')]);
    render();
    const row = render().find((e) => e.type === 'SettingsRow')!;
    (row.props.onPress as () => void)();
    expect(mocks.state[REMOVING]).toMatchObject({ name: 'Laptop' });
    const all = render();
    const sheet = all.find((e) => e.type === 'Sheet')!;
    expect(sheet.props).toMatchObject({ visible: true, title: 'Remove Laptop?' });
    expect(all.filter((e) => e.type === 'GhostButton').map((e) => e.props.label)).toEqual([
      'Remove computer',
      'Cancel',
    ]);
  });

  it('offers the recovery key below the devices', () => {
    mocks.state[STATE] = devicesStateFrom([dev(0, 'phone', 'Pixel')], dev(0, 'phone', 'Pixel').id);
    const all = render();
    const groups = all.filter((e) => e.type === 'SettingsGroup').map((e) => e.props.title);
    expect(groups).toEqual(['1 of 5 devices', 'Recovery key']);
    const row = all.find(
      (e) => e.type === 'SettingsRow' && e.props.label === 'Save a recovery key',
    )!;
    expect(row.props.value).toBe('Lets a new phone read old private messages');
    (row.props.onPress as () => void)();
    expect(mocks.push).toHaveBeenCalledWith('/private/recovery');
  });

  it('a list that failed to load says so and offers to try again', () => {
    mocks.state[ERROR] = 'Twring could not load your devices. Check your connection and try again.';
    const all = render();
    const notice = all.find((e) => e.type === 'ErrorNotice')!;
    expect(notice.props.error).toMatchObject({
      message: 'Twring could not load your devices. Check your connection and try again.',
      retryable: true,
    });
    expect(all.some((e) => e.type === 'SettingsGroup')).toBe(false);
    expect(all.some((e) => e.type === 'ActivityIndicator')).toBe(false);
  });
});
