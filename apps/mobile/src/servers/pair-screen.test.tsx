import { buildPairLink } from '@twring/contracts';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  params: {},
  replace: vi.fn(),
  checkServer: vi.fn(),
  pairWithServer: vi.fn(),
  feedback: vi.fn(),
}));

const authMocks = vi.hoisted(() => {
  const active: { kind: string } = { kind: 'hosted' };
  return { status: 'signed_out', active, signOut: vi.fn(), switchToHosted: vi.fn() };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state))
        mocks.state[slot] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] =
            typeof next === 'function'
              ? (next as (value: unknown) => unknown)(mocks.state[slot])
              : next;
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
vi.mock('expo-router', () => ({
  router: { replace: mocks.replace, push: vi.fn() },
  useLocalSearchParams: () => mocks.params,
}));
vi.mock('@/config/env', () => ({
  mobileEnv: { ok: true, env: { CORD_ENV: 'production' } },
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/QrScanner', () => ({ QrScanner: 'QrScanner' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('@/platform/seal-keys', () => ({ sealKeys: {} }));
vi.mock('@/servers/profiles', () => ({
  profileStore: { active: () => authMocks.active },
}));
vi.mock('@/servers/address', async () => await import('./address'));
vi.mock('@/servers/server-check', () => ({ checkServer: mocks.checkServer }));
vi.mock('@/auth', () => ({
  useAuth: () => ({ status: authMocks.status }),
  authController: () => ({ signOut: authMocks.signOut }),
}));
vi.mock('@/servers/switching', () => ({ switchToHosted: authMocks.switchToHosted }));
vi.mock('@/servers/pairing', () => ({ pairWithServer: mocks.pairWithServer }));
vi.mock('@/theme/fonts', () => ({ font: { display: 'd', body: 'b' } }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16 },
  type: { display: {}, body: {}, title: {} },
}));

import PairScreen from '../app/pair';

const ID = 'srv_' + 'a'.repeat(32);
const NOT_A_PAIR_LINK = "That code didn't work. Ask for a new one.";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(): ReactElement {
  mocks.cursor = 0;
  return PairScreen();
}

type Props = {
  label?: string;
  onPress?: () => unknown;
  disabled?: boolean;
  onChangeText?: (value: string) => void;
  onScanned?: (data: string) => unknown;
  value?: string;
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

function labelled(tree: ReactElement, label: string): ReactElement<Props> {
  const found = elements(tree).find((element) => element.props.label === label);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

const scanner = (tree: ReactElement) => elements(tree).find((e) => e.type === 'QrScanner');

beforeEach(() => {
  authMocks.status = 'signed_out';
  authMocks.active = { kind: 'hosted' };
  authMocks.signOut.mockReset();
  authMocks.switchToHosted.mockReset();
  mocks.state = [];
  mocks.params = {};
  mocks.replace.mockReset();
  mocks.feedback.mockReset();
  mocks.checkServer.mockReset();
  mocks.pairWithServer.mockReset();
});

const link = buildPairLink({ server: 'https://home.example.com', code: 'ABCD-EFGH', serverId: ID });

async function scanOk(): Promise<ReactElement> {
  mocks.checkServer.mockResolvedValue({ ok: true, info: { server_id: ID }, publicKey: 'k' });
  void labelled(render(), 'Scan the code').props.onPress?.();
  void scanner(render())?.props.onScanned?.(link);
  await flush();
  return render();
}

describe('pair screen', () => {
  it('asks for the camera only after the person taps to scan', () => {
    const tree = render();
    expect(JSON.stringify(tree)).toContain('Scan the code your server printed');
    expect(scanner(tree)).toBeUndefined();
    void labelled(tree, 'Scan the code').props.onPress?.();
    expect(scanner(render())).toBeDefined();
  });

  it('checks a scanned pair link against its server id, then asks for a name', async () => {
    const tree = await scanOk();
    expect(mocks.checkServer).toHaveBeenCalledWith(
      'https://home.example.com',
      { serverId: ID },
      expect.anything(),
    );
    expect(JSON.stringify(tree)).toContain('Your name on this server');
    labelled(tree, 'Done');
  });

  it('says a scanned text that is not a pair link did not work, and keeps scanning', async () => {
    void labelled(render(), 'Scan the code').props.onPress?.();
    void scanner(render())?.props.onScanned?.('https://example.com/not-a-link');
    await flush();
    const tree = render();
    expect(mocks.checkServer).not.toHaveBeenCalled();
    expect(JSON.stringify(tree)).toContain(NOT_A_PAIR_LINK);
    expect(scanner(tree)).toBeDefined();
  });

  it('shows what the server check said and keeps scanning when the server is wrong', async () => {
    mocks.checkServer.mockResolvedValue({
      ok: false,
      reason: 'wrong_server',
      message: 'Wrong one.',
    });
    void labelled(render(), 'Scan the code').props.onPress?.();
    void scanner(render())?.props.onScanned?.(link);
    await flush();
    const tree = render();
    expect(JSON.stringify(tree)).toContain('Wrong one.');
    expect(scanner(tree)).toBeDefined();
  });

  it('refuses an http address from the typed form before any request', async () => {
    void labelled(render(), 'Type the address instead').props.onPress?.();
    labelled(render(), 'Server address').props.onChangeText?.('http://home.example.com');
    labelled(render(), 'Code').props.onChangeText?.('ABCD-EFGH');
    void labelled(render(), 'Continue').props.onPress?.();
    await flush();
    expect(JSON.stringify(render())).toContain('The address must start with https://');
    expect(mocks.checkServer).not.toHaveBeenCalled();
  });

  it('keeps Done disabled while the name is empty', async () => {
    const tree = await scanOk();
    expect(labelled(tree, 'Done').props.disabled).toBe(true);
    labelled(tree, 'Your name').props.onChangeText?.('Sam');
    expect(labelled(render(), 'Done').props.disabled).toBe(false);
  });

  it('lands on the agents tab after pairing', async () => {
    const tree = await scanOk();
    labelled(tree, 'Your name').props.onChangeText?.(' Sam ');
    mocks.pairWithServer.mockResolvedValue({ ok: true, profile: {} });
    void labelled(render(), 'Done').props.onPress?.();
    await flush();
    expect(mocks.pairWithServer).toHaveBeenCalledWith(
      { address: 'https://home.example.com', code: 'ABCD-EFGH', serverId: ID, displayName: 'Sam' },
      expect.anything(),
    );
    expect(mocks.replace).toHaveBeenCalledWith('/');
  });

  it('shows the pairing failure in the notice with a haptic', async () => {
    const tree = await scanOk();
    labelled(tree, 'Your name').props.onChangeText?.('Sam');
    mocks.pairWithServer.mockResolvedValue({
      ok: false,
      message: 'Code expired.',
      retryable: false,
    });
    void labelled(render(), 'Done').props.onPress?.();
    await flush();
    expect(JSON.stringify(render())).toContain('Code expired.');
    expect(mocks.feedback).toHaveBeenCalledWith('error');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('opens a deep link with the address and code filled in', () => {
    mocks.params = { server: 'https://home.example.com', code: 'ABCD-EFGH', id: ID };
    const tree = render();
    expect(labelled(tree, 'Server address').props.value).toBe('https://home.example.com');
    expect(labelled(tree, 'Code').props.value).toBe('ABCD-EFGH');
  });

  it('gives the scanner a new attempt value after every failed scan, so it listens again', async () => {
    void labelled(render(), 'Scan the code').props.onPress?.();
    const seen: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      void scanner(render())?.props.onScanned?.('not a pair link');
      await flush();
      seen.push((scanner(render())?.props as { attempt?: unknown }).attempt);
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('shows which server is being joined on the name step', async () => {
    mocks.checkServer.mockResolvedValue({ ok: true, info: { server_id: ID }, publicKey: 'k' });
    const other = buildPairLink({
      server: 'https://203-0-113-8.sslip.io',
      code: 'ABCD-EFGH',
      serverId: ID,
    });
    void labelled(render(), 'Scan the code').props.onPress?.();
    void scanner(render())?.props.onScanned?.(other);
    await flush();
    const text = JSON.stringify(render());
    expect(text).toContain('203-0-113-8.sslip.io');
    expect(text).not.toContain('https://203-0');
  });
});

describe('pair link opened while signed in', () => {
  const opened = { server: 'https://home.example.com', code: 'ABCD-EFGH', id: ID };

  it("asks to sign out of Twring's service first, then shows the filled-in form", async () => {
    authMocks.status = 'signed_in';
    mocks.params = opened;
    authMocks.signOut.mockImplementation(() => {
      authMocks.status = 'signed_out';
      return Promise.resolve();
    });
    const tree = render();
    expect(JSON.stringify(tree)).toContain('To join this server, sign out first.');
    void labelled(tree, 'Sign out and continue').props.onPress?.();
    await flush();
    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
    expect(authMocks.switchToHosted).not.toHaveBeenCalled();
    const form = render();
    expect(labelled(form, 'Server address').props.value).toBe('https://home.example.com');
    expect(labelled(form, 'Code').props.value).toBe('ABCD-EFGH');
  });

  it("on a person's own server, switches to Twring's service keeping it saved", async () => {
    authMocks.status = 'signed_in';
    authMocks.active = { kind: 'selfhost' };
    mocks.params = opened;
    authMocks.switchToHosted.mockResolvedValue(undefined);
    void labelled(render(), 'Sign out and continue').props.onPress?.();
    await flush();
    expect(authMocks.switchToHosted).toHaveBeenCalledTimes(1);
    expect(authMocks.signOut).not.toHaveBeenCalled();
  });

  it('signed out, opens straight on the filled-in form', () => {
    mocks.params = opened;
    const tree = render();
    expect(JSON.stringify(tree)).not.toContain('sign out first');
    expect(labelled(tree, 'Code').props.value).toBe('ABCD-EFGH');
  });
});
