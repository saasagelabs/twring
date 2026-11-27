import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resource: {},
  replace: vi.fn(),
  chatsReady: true,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: (effect: () => void) => effect(),
    useState: (initial: unknown) => [initial, () => undefined],
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: mocks.replace },
  useFocusEffect: () => undefined,
}));
vi.mock('@/agents/agent-cache', () => ({
  agentCache: () => ({}),
  OFFLINE_SAVED_AGENTS: 'No connection. Showing your agents from last time.',
}));
vi.mock('@/agents/home-rows', () => ({
  homeRow: () => ({ aiApp: false, offline: false, call: 'enabled', accessibilityLabel: 'row' }),
}));
vi.mock('@/api', () => ({ twringApi: () => undefined }));
vi.mock('@/call/start', () => ({ startCall: vi.fn() }));
vi.mock('@/config/env', () => ({ mobileEnv: { ok: true } }));
vi.mock('@/hooks/useResource', () => ({
  STATUS_POLL_MS: 1,
  useResource: () => ({ ...mocks.resource, reload: () => undefined }),
}));
vi.mock('@/onboarding/state', () => ({
  onboardingSeen: () => false,
  shouldShowOnboarding: () => true,
}));
vi.mock('@/ring/missed', () => ({ unseenMissed: () => [] }));
vi.mock('@/ring/missed-seen', () => ({ markMissedSeen: vi.fn(), missedLastSeen: vi.fn() }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({}),
  space: { sm: 1, md: 1 },
  radius: { pill: 1 },
  type: new Proxy({}, { get: () => ({}) }),
}));
vi.mock('@/threads/chats', () => ({
  useChatList: () => ({
    available: true,
    off: false,
    ready: mocks.chatsReady,
    threads: [],
    preview: () => undefined,
    refresh: () => undefined,
  }),
}));
vi.mock('@/threads/presentation', () => ({ sortChatAgents: (agents: unknown[]) => agents }));
vi.mock('@/components/Brand', () => ({ TwringLockup: 'TwringLockup' }));
for (const name of [
  'Avatar',
  'CallButton',
  'ErrorNotice',
  'Icon',
  'IconButton',
  'ListRow',
  'PrimaryButton',
  'Screen',
  'Skeleton',
]) {
  vi.doMock(`@/components/${name}`, () => ({ [name]: name }));
}

type Props = { children?: ReactNode; avatar?: ReactNode; online?: boolean; title?: string };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.avatar),
  ];
}
const agent = { id: 'a1', name: 'Home agent' };

async function render(): Promise<ReactElement<Props>[]> {
  const screen = await import('../app/(tabs)/index');
  return elements(screen.default());
}

beforeEach(() => {
  mocks.replace.mockClear();
  mocks.chatsReady = true;
});

describe('agents home offline', () => {
  it('a cold start with no connection shows the saved agents and a quiet line', async () => {
    mocks.resource = { data: [agent], stale: true, error: { title: 'x' }, loading: false };
    const tree = await render();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(tree.some((e) => e.type === 'ErrorNotice')).toBe(false);
    expect(JSON.stringify(tree.map((e) => e.props.children))).toContain(
      'No connection. Showing your agents from last time.',
    );
    expect(tree.find((e) => e.type === 'ListRow')?.props.title).toBe('Home agent');
    const avatar = tree.find((e) => e.type === 'Avatar');
    expect(avatar?.props.online).toBeUndefined();
  });

  it('a fresh empty list still goes to onboarding', async () => {
    mocks.resource = { data: [], stale: false, error: undefined, loading: false };
    await render();
    expect(mocks.replace).toHaveBeenCalledWith('/onboarding');
  });

  it('shows the skeleton, not agent-only rows, until the chat list or its saved copy is ready', async () => {
    mocks.resource = { data: [agent], stale: false, error: undefined, loading: false };
    mocks.chatsReady = false;
    let tree = await render();
    expect(tree.some((e) => e.type === 'ListRow')).toBe(false);
    expect(tree.filter((e) => e.type === 'Skeleton')).toHaveLength(3);
    // Ready also covers a failed chat list load, so rows always come.
    mocks.chatsReady = true;
    tree = await render();
    expect(tree.find((e) => e.type === 'ListRow')?.props.title).toBe('Home agent');
    expect(tree.some((e) => e.type === 'Skeleton')).toBe(false);
  });
});
