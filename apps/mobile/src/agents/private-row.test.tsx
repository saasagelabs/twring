import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import type * as PrivateStateModule from '../e2e/private-state';
import type * as AvailabilityModule from '../e2e/private-availability';
import { PrivateAvailabilityCache } from '../e2e/private-availability';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const typed: { status: 'on' | 'off' | 'unknown'; cache?: PrivateAvailabilityCache } = {
    status: 'on',
  };
  return {
    ...typed,
    state: [] as unknown[],
    cursor: 0,
    statusCalls: 0,
    scope: 'user-1',
    trusted: [] as unknown[],
    setPrivate: vi.fn(),
    turnOnPrivate: vi.fn(),
    push: vi.fn(),
    feedback: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (fn: () => unknown) => void fn(),
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
vi.mock('@/api', () => ({
  twringApi: () => ({
    privateChatsStatus: () => {
      mocks.statusCalls++;
      return Promise.resolve(mocks.status);
    },
    setPrivate: mocks.setPrivate,
  }),
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/SettingsGroup', () => ({
  SettingsGroup: 'SettingsGroup',
  SettingsRow: 'SettingsRow',
}));
vi.mock('@/components/Sheet', () => ({ Sheet: 'Sheet' }));
vi.mock('@/e2e/pairing', () => ({ loadTrusted: () => Promise.resolve(mocks.trusted) }));
vi.mock('@/e2e/private-state', async () => {
  const actual = await vi.importActual<typeof PrivateStateModule>('../e2e/private-state');
  return { ...actual, turnOnPrivate: mocks.turnOnPrivate };
});
vi.mock('@/e2e/private-availability', async () => {
  const actual = await vi.importActual<typeof AvailabilityModule>('../e2e/private-availability');
  return {
    get privateAvailability() {
      return mocks.cache;
    },
    PrivateAvailabilityCache: actual.PrivateAvailabilityCache,
  };
});
vi.mock('@/servers/active', () => ({ activeServerUrl: () => 'https://api.twring.invalid' }));
vi.mock('@/threads/chats', () => ({
  currentScope: () => mocks.scope,
  privateKeychain: () => ({}),
}));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('@/theme/tokens', () => ({
  type: { body: {} },
  usePalette: () => ({ textSecondary: '#aaa' }),
}));

import { PrivateChatsRow } from '../components/PrivateChatsRow';

type Props = { label?: string; title?: string; visible?: boolean; onPress?: () => unknown };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const onTurnedOn = vi.fn();

function render(
  agent = {
    id: 'a1',
    name: 'Claude',
    protocol: 'cord-connector' as const,
    endpoint_url: `cord-connector://con_${'a'.repeat(20)}/claude`,
  },
  extra: { isPrivate?: boolean; ask?: boolean } = {},
): ReactElement | null {
  mocks.cursor = 0;
  return PrivateChatsRow({
    agent,
    isPrivate: extra.isPrivate ?? false,
    ask: extra.ask ?? false,
    onTurnedOn,
  });
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode } & Props>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}
const find = (tree: ReactElement | null, label: string) =>
  elements(tree).find((e) => e.props.label === label);

async function loaded(...args: Parameters<typeof render>) {
  render(...args);
  await flush();
  return render(...args);
}

beforeEach(() => {
  mocks.state = [];
  mocks.status = 'on';
  mocks.statusCalls = 0;
  mocks.scope = 'user-1';
  mocks.cache = new PrivateAvailabilityCache();
  mocks.trusted = [];
  mocks.turnOnPrivate.mockReset().mockResolvedValue({ status: 'on' });
  mocks.feedback.mockReset();
  onTurnedOn.mockReset();
});

describe('Make chats private row', () => {
  it('is hidden while private chats are off for this account (any 404)', async () => {
    mocks.status = 'off';
    expect(await loaded()).toBeNull();
  });

  it('shows once /v1/e2e/devices answers 200, asking once per session', async () => {
    expect(await loaded()).not.toBeNull();
    mocks.state = [];
    expect(await loaded()).not.toBeNull();
    expect(mocks.statusCalls).toBe(1);
  });

  it('treats unknown as off for now and asks again next time', async () => {
    mocks.status = 'unknown';
    expect(await loaded()).toBeNull();
    await flush();
    mocks.status = 'on';
    mocks.state = [];
    expect(await loaded()).not.toBeNull();
    expect(mocks.cache).toBeInstanceOf(PrivateAvailabilityCache);
    expect(mocks.cache?.peek('https://api.twring.invalid|user-1')).toBe('on');
  });

  it('asks again for another account, never reusing its answer', async () => {
    mocks.status = 'off';
    expect(await loaded()).toBeNull();
    mocks.scope = 'user-2';
    mocks.status = 'on';
    mocks.state = [];
    expect(await loaded()).not.toBeNull();
    expect(mocks.statusCalls).toBe(2);
  });

  it('is hidden for an AI app connected online', async () => {
    expect(
      await loaded({ id: 'a1', name: 'Claude', protocol: 'mcp-app' as never, endpoint_url: '' }),
    ).toBeNull();
  });

  it('asks first, saying older messages stay as they are', async () => {
    const tree = await loaded();
    void find(tree, 'Make chats private')?.props.onPress?.();
    const sheet = elements(render()).find((e) => e.type === 'Sheet');
    expect(sheet?.props.visible).toBe(true);
    expect(JSON.stringify(render())).toContain('Older messages stay as they are.');
    expect(mocks.turnOnPrivate).not.toHaveBeenCalled();
  });

  it('turns on after the person agrees', async () => {
    await loaded();
    void find(render(), 'Make private')?.props.onPress?.();
    await flush();
    expect(mocks.turnOnPrivate).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
    expect(onTurnedOn).toHaveBeenCalled();
  });

  it('shows the plain reason when the computer is too old', async () => {
    mocks.turnOnPrivate.mockResolvedValue({
      status: 'failed',
      message: 'Update Twring on your computer first, then try again.',
    });
    await loaded();
    void find(render(), 'Make private')?.props.onPress?.();
    await flush();
    expect(JSON.stringify(render())).toContain(
      'Update Twring on your computer first, then try again.',
    );
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('opens the question at once when it comes back from pairing', async () => {
    const tree = await loaded(undefined, { ask: true });
    expect(elements(tree).find((e) => e.type === 'Sheet')?.props.visible).toBe(true);
  });

  it('shows a private chat as on, with nothing to press', async () => {
    const tree = await loaded(undefined, { isPrivate: true });
    expect(find(tree, 'Make chats private')).toBeUndefined();
    expect(find(tree, 'Private chats')).toBeDefined();
  });
});
