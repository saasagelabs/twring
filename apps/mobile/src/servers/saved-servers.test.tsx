import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerProfile } from './profiles';

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  list: [] as ServerProfile[],
  switchToServer: vi.fn(),
  forgetServer: vi.fn(),
  alert: vi.fn(),
  feedback: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
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
  Alert: { alert: mocks.alert },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('./profiles', () => ({
  profileStore: { list: () => mocks.list, subscribe: () => () => undefined },
}));
vi.mock('./switching', () => ({
  switchToServer: mocks.switchToServer,
  forgetServer: mocks.forgetServer,
}));
vi.mock('../components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('../components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('../platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('../theme/tokens', () => ({
  usePalette: () => ({ textSecondary: '#aaa' }),
  space: { xs: 4, sm: 8, md: 12 },
  type: { body: {}, caption: {} },
}));

import { SavedServers } from './saved-servers';

const home: ServerProfile = {
  kind: 'selfhost',
  serverId: 'srv_1',
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'per_1', displayName: 'Ann', role: 'admin' },
  deviceId: 'dev1',
  audio: 'own',
};

type Props = {
  label?: string;
  onPress?: () => unknown;
  error?: { message: string };
  children?: ReactNode;
};

function render(): ReactElement | null {
  mocks.cursor = 0;
  return SavedServers();
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.state = [];
  mocks.list = [home];
  mocks.switchToServer.mockReset();
  mocks.forgetServer.mockReset();
  mocks.alert.mockReset();
  mocks.feedback.mockReset();
});

describe('saved servers on the sign-in screen', () => {
  it('shows nothing without saved servers', () => {
    mocks.list = [];
    expect(render()).toBeNull();
  });

  it('lists a saved server and uses it when tapped', async () => {
    mocks.switchToServer.mockResolvedValue({ ok: true });
    const use = elements(render()).find((e) => e.props.label === 'Use Home');
    expect(use).toBeDefined();
    use?.props.onPress?.();
    await flush();
    expect(mocks.switchToServer).toHaveBeenCalledWith('srv_1');
    expect(elements(render()).some((e) => e.type === 'ErrorNotice')).toBe(false);
  });

  it('shows the message when the server cannot be used', async () => {
    const message =
      "Couldn't reach that server. Check the address, and that the server is running.";
    mocks.switchToServer.mockResolvedValue({ ok: false, reason: 'unreachable', message });
    elements(render())
      .find((e) => e.props.label === 'Use Home')
      ?.props.onPress?.();
    await flush();
    const notice = elements(render()).find((e) => e.type === 'ErrorNotice');
    expect(notice?.props.error?.message).toBe(message);
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('forgets a server only after confirming', async () => {
    mocks.forgetServer.mockResolvedValue(undefined);
    elements(render())
      .find((e) => e.props.label === 'Forget')
      ?.props.onPress?.();
    expect(mocks.forgetServer).not.toHaveBeenCalled();
    const [title, body, buttons] = mocks.alert.mock.calls[0] as [
      string,
      string,
      { text: string; onPress?: () => void }[],
    ];
    expect(`${title} ${body}`).toBe('Forget Home? You can pair this phone again with a new code.');
    buttons.find((b) => b.text === 'Forget')?.onPress?.();
    await flush();
    expect(mocks.forgetServer).toHaveBeenCalledWith('srv_1');
  });
});
