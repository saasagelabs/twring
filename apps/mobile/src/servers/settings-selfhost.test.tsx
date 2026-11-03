import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from './profiles';

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  active: { kind: 'hosted' },
  deleteMyData: vi.fn(),
  leaveServer: vi.fn(),
  forget: vi.fn(),
  alert: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: () => undefined,
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
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: mocks.alert },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/api', () => ({
  apiErrorCopy: () => ({}),
  twringApi: () => ({ deleteMyData: mocks.deleteMyData }),
}));
vi.mock('@/auth', () => ({
  authController: () => undefined,
  deleteSignInAccount: vi.fn(),
  useAuth: () => ({ status: 'signed_in', email: 'a@example.com' }),
}));
vi.mock('@/auth/apple-sign-in', () => ({ appleAuthorizationCode: vi.fn() }));
vi.mock('@/call/start', () => ({ startCall: vi.fn() }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: false } }));
vi.mock('@/privacy/account-deletion', () => ({
  ACCOUNT_NOT_DELETED: '',
  accountToDeleteLabel: () => '',
  deleteAccount: vi.fn(),
  endAppleSignIn: vi.fn(),
}));
vi.mock('@/privacy/deletion', () => ({ deletionSummary: () => 'Deleted.' }));
vi.mock('@/ring/service', () => ({ pushRegistration: { forget: mocks.forget } }));
vi.mock('@/threads/chats', () => ({ useChatList: () => ({ available: true }) }));
vi.mock('@/usage/copy', () => ({ usageResetLine: () => undefined, usageSummary: () => '' }));
vi.mock('@/servers/active', () => ({
  activeServerUrl: () => 'https://api.example.com',
  useActiveServer: () => mocks.active,
}));
vi.mock('@/servers/switching', () => ({ leaveServer: mocks.leaveServer }));
vi.mock('@/servers/your-server', () => ({ YourServer: 'YourServer' }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  type: new Proxy({}, { get: () => ({}) }),
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/RingSettings', () => ({ RingSettings: 'RingSettings' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/SettingsGroup', () => ({
  SettingsGroup: 'SettingsGroup',
  SettingsRow: 'SettingsRow',
}));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));

vi.stubGlobal('__DEV__', false);

import SettingsScreen from '../app/(tabs)/settings';

type Props = { label?: string; title?: string; children?: ReactNode; onPress?: () => void };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}
function render(): ReactElement<Props> {
  mocks.cursor = 0;
  return SettingsScreen() as ReactElement<Props>;
}
const labels = (tree: ReactElement<Props>) =>
  elements(tree).flatMap((e) => [e.props.label, e.props.title].filter((v) => v !== undefined));

const selfhost: ServerProfile = {
  kind: 'selfhost',
  serverId: 'srv_' + 'a'.repeat(32),
  address: 'https://home.example.com',
  name: 'Home server',
  publicKey: 'k',
  person: { id: 'p1', displayName: 'Asha', role: 'member' },
  deviceId: 'd1',
  audio: 'own',
};

async function deleteMyData() {
  mocks.deleteMyData.mockResolvedValue({});
  elements(render())
    .find((e) => e.props.label === 'Delete my data')
    ?.props.onPress?.();
  const buttons = mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
  buttons.find((b) => b.text === 'Delete')?.onPress?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mocks.state = [];
  mocks.active = { kind: 'hosted' };
  mocks.deleteMyData.mockReset();
  mocks.leaveServer.mockReset();
  mocks.leaveServer.mockResolvedValue(undefined);
  mocks.forget.mockReset();
  mocks.alert.mockReset();
});

describe('Settings with Twring service', () => {
  it('shows every row as before and no Your server', () => {
    const out = labels(render());
    expect(out).toEqual(
      expect.arrayContaining([
        'Account',
        'Signed in as',
        'Sign out',
        'AI apps',
        'Connected AI apps',
        'Help',
        'Send feedback',
        'Delete my data',
        'Delete account',
      ]),
    );
    expect(elements(render()).some((e) => e.type === 'YourServer')).toBe(false);
  });

  it('Delete my data resets the push registration and does not leave a server', async () => {
    await deleteMyData();
    expect(mocks.forget).toHaveBeenCalledTimes(1);
    expect(mocks.leaveServer).not.toHaveBeenCalled();
  });
});

describe('Settings on your own server', () => {
  beforeEach(() => {
    mocks.active = selfhost;
  });

  it('shows Your server and hides the Twring-only rows', () => {
    const tree = render();
    const out = labels(tree);
    expect(elements(tree).some((e) => e.type === 'YourServer')).toBe(true);
    for (const gone of [
      'Account',
      'Signed in as',
      'Sign out',
      'AI apps',
      'Connected AI apps',
      'Help',
      'Send feedback',
      'Delete account',
    ]) {
      expect(out).not.toContain(gone);
    }
    expect(out).toContain('Delete my data');
    expect(out).toContain('Privacy');
  });

  it('Delete my data leaves the server after it answers, without a push reset', async () => {
    await deleteMyData();
    expect(mocks.deleteMyData).toHaveBeenCalledTimes(1);
    expect(mocks.leaveServer).toHaveBeenCalledTimes(1);
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it('a failed leave after Delete my data is caught (the profile goes locally anyway)', async () => {
    const failed = Promise.reject(new Error('keychain'));
    const handled = vi.spyOn(failed, 'catch');
    mocks.leaveServer.mockReturnValue(failed);
    await deleteMyData();
    expect(mocks.leaveServer).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalled();
    failed.catch(() => undefined);
  });

  it('a failed Delete my data stays on the server', async () => {
    mocks.deleteMyData.mockRejectedValue(new Error('offline'));
    elements(render())
      .find((e) => e.props.label === 'Delete my data')
      ?.props.onPress?.();
    const buttons = mocks.alert.mock.calls[0]?.[2] as { text: string; onPress?: () => void }[];
    buttons.find((b) => b.text === 'Delete')?.onPress?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.leaveServer).not.toHaveBeenCalled();
  });
});
