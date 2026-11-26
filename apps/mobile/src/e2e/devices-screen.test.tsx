import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { devicesStateFrom } from './devices';

/** The devices screen as rendered (C3 #11, Task 26): hooks are stubbed, state is set directly. */

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  push: vi.fn(),
  claimWaiting: vi.fn(),
  approveWaiting: vi.fn(),
  denyWaiting: vi.fn(),
}));

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
vi.mock('@/e2e/device-key', () => ({ loadDeviceKey: vi.fn() }));
vi.mock('@/e2e/approve', async () => ({
  ...(await import('./approve')),
  claimWaiting: mocks.claimWaiting,
  approveWaiting: mocks.approveWaiting,
  denyWaiting: mocks.denyWaiting,
}));
vi.mock('@/e2e/pair-api', () => ({ approveApi: () => ({}) }));
vi.mock('@/e2e/devices', async () => import('./devices'));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: vi.fn() }));
vi.mock('@/e2e/share-history', () => ({ shareHistory: vi.fn() }));
vi.mock('@/threads/chats', () => ({
  chatController: () => undefined,
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
// useState slots in the screen: state, error, removing, busy, selfId, waiting, approving.
const STATE = 0;
const ERROR = 1;
const REMOVING = 2;
const WAITING = 5;
const APPROVING = 6;
const CONNECTING = 7;

beforeEach(() => {
  mocks.state = [];
  mocks.push.mockReset();
  mocks.claimWaiting.mockReset();
  mocks.approveWaiting.mockReset().mockResolvedValue({ ok: true });
  mocks.denyWaiting.mockReset().mockResolvedValue({ ok: true });
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

describe('waiting for approval (C3 #11, Task 27)', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const approval = { id: 'pap_x', name: 'New phone', device_id: 'dev_n', public_key: 'k' };
  const claimed = { approval, nonce: 'n' };
  const checked = { approval: { ...approval, reveal: 'r' }, code: '123 456' };

  it('lists waiting phones and opens a sheet with the code and both choices', async () => {
    mocks.state[STATE] = devicesStateFrom([dev(0, 'phone', 'Pixel')], dev(0, 'phone', 'Pixel').id);
    mocks.state[WAITING] = [{ id: 'pap_x', name: 'New phone' }];
    mocks.claimWaiting.mockResolvedValue({ ok: true, claimed });
    const all = render();
    expect(all.filter((e) => e.type === 'SettingsGroup').map((e) => e.props.title)).toContain(
      'Waiting for approval',
    );
    const row = all.find((e) => e.type === 'SettingsRow' && e.props.label === 'New phone')!;
    (row.props.onPress as () => void)();
    await flush();
    expect(mocks.claimWaiting.mock.calls[0]?.[1]).toBe('pap_x');
    // No code until the new phone sent what it needs: a short waiting state, and Deny.
    const waitingSheet = render();
    expect(waitingSheet.filter((e) => e.type === 'Sheet')[1]?.props).toMatchObject({
      visible: true,
      title: 'New phone',
    });
    expect(texts(waitingSheet)).toContain('Waiting for New phone. Keep Twring open on it.');
    expect(texts(waitingSheet)).not.toContain('123 456');
    expect(waitingSheet.filter((e) => e.type === 'GhostButton').map((e) => e.props.label)).toEqual([
      'Deny',
    ]);
    mocks.state[APPROVING] = { claimed, checked };
    const opened = render();
    const sheets = opened.filter((e) => e.type === 'Sheet');
    expect(sheets[1]?.props).toMatchObject({ visible: true, title: 'New phone' });
    expect(texts(opened)).toEqual(
      expect.arrayContaining(['123 456', 'Make sure New phone shows the same 6 digits.']),
    );
    const buttons = opened.filter((e) => e.type === 'GhostButton').map((e) => e.props.label);
    expect(buttons).toEqual(['Codes match, approve', 'Deny']);
    expect(JSON.stringify(texts(opened))).not.toMatch(/device id|trust note|\bkey\b/i);
  });

  it('approves or denies with the choice made', async () => {
    mocks.state[STATE] = devicesStateFrom([dev(0, 'phone', 'Pixel')]);
    mocks.state[APPROVING] = { claimed, checked };
    const approve = render().find(
      (e) => e.type === 'GhostButton' && e.props.label === 'Codes match, approve',
    )!;
    (approve.props.onPress as () => void)();
    await flush();
    expect(mocks.approveWaiting.mock.calls[0]?.[1]).toEqual(checked);
    mocks.state[APPROVING] = { claimed, checked };
    const deny = render().find((e) => e.type === 'GhostButton' && e.props.label === 'Deny')!;
    (deny.props.onPress as () => void)();
    await flush();
    expect(mocks.denyWaiting.mock.calls[0]?.[1]).toBe('pap_x');
  });

  it('tells the person to update the new phone when its app is too old', async () => {
    mocks.state[STATE] = devicesStateFrom([dev(0, 'phone', 'Pixel')]);
    mocks.state[WAITING] = [{ id: 'pap_x', name: 'New phone' }];
    mocks.claimWaiting.mockResolvedValue({ ok: false, code: 'outdated' });
    const row = render().find((e) => e.type === 'SettingsRow' && e.props.label === 'New phone')!;
    (row.props.onPress as () => void)();
    await flush();
    expect(mocks.state[APPROVING]).toBeUndefined();
    expect(JSON.stringify(mocks.state)).toContain('Update Twring on the new phone');
    // Turned down, so the older app stops showing a code no phone will match.
    expect(mocks.denyWaiting.mock.calls[0]?.[1]).toBe('pap_x');
  });
});

describe('phones this phone has not approved (P5b)', () => {
  const me = dev(0, 'phone', 'Pixel');
  const other = dev(1, 'phone', 'iPhone');
  const setup = () => {
    mocks.state[STATE] = devicesStateFrom([me, other], me.id, new Set([me.id]));
  };

  it('shows the value and offers to connect, in plain words', () => {
    setup();
    const all = render();
    const row = all.find((e) => e.type === 'SettingsRow' && e.props.label === 'iPhone')!;
    expect(row.props.value).toBe('Phone, not connected to this phone');
    (row.props.onPress as () => void)();
    expect(mocks.state[CONNECTING]).toMatchObject({ name: 'iPhone' });
    const opened = render();
    expect(opened.filter((e) => e.type === 'Sheet')[2]?.props).toMatchObject({
      visible: true,
      title: 'Connect with iPhone?',
    });
    expect(texts(opened)).toContain(
      'So both phones can read the same private chats. Tap Start, then open Twring on iPhone and approve this phone in Devices.',
    );
    expect(opened.filter((e) => e.type === 'GhostButton').map((e) => e.props.label)).toEqual([
      'Start',
      'Remove iPhone',
      'Cancel',
    ]);
  });

  it('Start goes to the pair screen in approve mode', () => {
    setup();
    mocks.state[CONNECTING] = { ...other, thisPhone: false, kind: 'Phone', added: 'x' };
    const start = render().find((e) => e.type === 'GhostButton' && e.props.label === 'Start')!;
    (start.props.onPress as () => void)();
    expect(mocks.push).toHaveBeenCalledWith('/private/pair?approve=1');
    expect(mocks.state[CONNECTING]).toBeUndefined();
  });

  it('Remove still works from the sheet', () => {
    setup();
    mocks.state[CONNECTING] = { ...other, thisPhone: false, kind: 'Phone', added: 'x' };
    const rm = render().find((e) => e.type === 'GhostButton' && e.props.label === 'Remove iPhone')!;
    (rm.props.onPress as () => void)();
    expect(mocks.state[CONNECTING]).toBeUndefined();
    expect(mocks.state[REMOVING]).toMatchObject({ name: 'iPhone' });
  });
});
