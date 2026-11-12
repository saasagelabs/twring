import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Resource {
  data: unknown;
  error: undefined;
  loading: boolean;
  refreshing: boolean;
}
const mocks = vi.hoisted(() => {
  const resource: Resource = {
    data: undefined,
    error: undefined,
    loading: false,
    refreshing: false,
  };
  return { state: [] as unknown[], cursor: 0, resource };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
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
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  Image: 'Image',
  ActivityIndicator: 'ActivityIndicator',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useLocalSearchParams: () => ({ id: 'a1' }),
  useFocusEffect: () => undefined,
}));
vi.mock('expo-haptics', () => ({}));
vi.mock('expo-file-system', () => ({ File: class {} }));
vi.mock('expo-image-manipulator', () => ({}));
vi.mock('expo-image-picker', () => ({}));
vi.mock('@/agents/voice-groups', () => ({
  savedVoiceLabel: () => 'Aria',
  pickerSelection: () => undefined,
  savedVoiceMissing: () => false,
  voiceGroups: () => [],
}));
vi.mock('@/agents/keyterms', () => ({
  keytermSummary: () => 'None yet',
  addKeyterm: () => ({ ok: true, terms: [] }),
  removeKeyterm: () => [],
  sameKeyterms: () => true,
  splitKeyterms: () => [],
}));
vi.mock('@/agents/ai-app', () => ({
  aiAppReachability: () => '',
  canCall: () => true,
  isAiApp: () => false,
  removeAiAppCopy: () => '',
  showComputerCallHint: () => false,
}));
vi.mock('@/agents/labels', () => ({
  agentStatusFor: () => ({ label: 'Online', tone: 'ok' }),
  formatWhen: () => 'now',
  historyRow: () => ({}),
  protocolLabel: () => 'Computer',
}));
vi.mock('@/agents/shared', () => import('./shared'));
vi.mock('@/api', () => ({ apiErrorCopy: () => ({}), twringApi: () => undefined }));
vi.mock('@/call/call-agent', () => ({ callAgent: vi.fn() }));
vi.mock('@/hooks/useNow', () => ({ useNow: () => 0 }));
vi.mock('@/hooks/useResource', () => ({
  STATUS_POLL_MS: 1,
  useResource: () => ({ ...mocks.resource, reload: () => undefined }),
}));
vi.mock('@/platform/voice-preview', () => ({
  useVoicePreview: () => ({ status: 'idle' }),
  voicePreview: {},
}));
vi.mock('@/threads/chats', () => ({
  useChatList: () => ({ available: true, refresh: () => undefined }),
}));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({}),
  space: { xs: 1, sm: 1, md: 1, lg: 1 },
  radius: { md: 1 },
  type: new Proxy({}, { get: () => ({}) }),
}));
vi.mock('@/theme/fonts', () => ({ font: {} }));
for (const name of [
  'Avatar',
  'ComputerCallHint',
  'ErrorNotice',
  'GhostButton',
  'IconButton',
  'PrimaryButton',
  'Sheet',
  'Row',
  'StatusLabel',
  'Field',
  'Icon',
  'MiniWave',
  'Skeleton',
]) {
  vi.doMock(`@/components/${name}`, () => ({ [name]: name }));
}
vi.mock('@/components/Screen', () => ({ Screen: 'Screen', goBack: () => undefined }));

import { SHARED_AGENT_NOTE, VIEW_ONLY_AGENT_NOTE } from './shared';

type Props = {
  label?: string;
  accessibilityLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
  headerRight?: ReactNode;
  onPress?: () => void;
};
function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<Props>;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
    ...elements(element.props.headerRight),
  ];
}
const agent = {
  id: 'a1',
  name: 'Home agent',
  protocol: 'cord-connector',
  voice_id: 'aria',
  keyterms: [],
  endpoint_url: 'https://x.example.com',
  has_credential: true,
};
function names(tree: ReactElement): string[] {
  return elements(tree).flatMap((e) =>
    [e.props.label, e.props.accessibilityLabel].filter((v): v is string => v !== undefined),
  );
}
const everything = (tree: ReactElement) => JSON.stringify(tree);

const screens = {
  index: () => import('../app/agents/[id]/index'),
  edit: () => import('../app/agents/[id]/edit'),
  voice: () => import('../app/agents/[id]/voice'),
  words: () => import('../app/agents/[id]/words'),
};
async function screen(file: keyof typeof screens): Promise<() => ReactElement> {
  const module = await screens[file]();
  return () => {
    mocks.cursor = 0;
    return module.default();
  };
}

beforeEach(() => {
  mocks.state = [];
  mocks.resource.data = undefined;
});

describe('agent detail screen', () => {
  const detail = (extra: object) => {
    mocks.resource.data = { agent: { ...agent, ...extra }, calls: [], voiceLabel: 'Aria' };
  };

  it('an agent with no can_edit keeps every control', async () => {
    detail({});
    const out = names((await screen('index'))());
    expect(out).toEqual(
      expect.arrayContaining([
        'Edit agent',
        'Voice',
        'Words to recognise',
        'Advanced',
        'Delete agent',
      ]),
    );
    expect(everything((await screen('index'))())).not.toContain(SHARED_AGENT_NOTE);
  });

  it('keeps connection details behind Advanced until it is opened', async () => {
    detail({});
    const render = await screen('index');
    expect(names(render())).not.toContain('Edit connection');
    elements(render())
      .find((e) => e.props.label === 'Advanced')
      ?.props.onPress?.();
    expect(names(render())).toEqual(
      expect.arrayContaining(['Edit connection', 'Connection method']),
    );
    // A computer agent's internal connector address is not shown.
    expect(names(render())).not.toContain('Address');
  });

  it('can_edit false hides edit, delete, voice, words and connection controls', async () => {
    detail({ can_edit: false, shared: true });
    const tree = (await screen('index'))();
    const out = names(tree);
    for (const gone of [
      'Edit agent',
      'Voice',
      'Words to recognise',
      'Edit connection',
      'Delete agent',
    ]) {
      expect(out).not.toContain(gone);
    }
    expect(out).toContain('Call');
    expect(everything(tree)).toContain(SHARED_AGENT_NOTE);
  });

  it('shows the shared note for a shared agent the person owns, with controls', async () => {
    detail({ shared: true });
    const tree = (await screen('index'))();
    expect(everything(tree)).toContain(SHARED_AGENT_NOTE);
    expect(names(tree)).toContain('Edit agent');
  });
});

describe('edit, voice and words screens', () => {
  it.each([
    ['edit', { ...agent, can_edit: false }, 'Change photo'],
    ['voice', { agent: { ...agent, can_edit: false }, voices: { voices: [] } }, 'Save voice'],
    ['words', { ...agent, can_edit: false }, 'Save words'],
  ] as const)('%s shows only a note when can_edit is false', async (file, data, control) => {
    mocks.resource.data = data;
    const out = everything((await screen(file))());
    expect(out).toContain(VIEW_ONLY_AGENT_NOTE);
    expect(out).not.toContain(control);
  });

  it.each([
    ['edit', agent, 'Change photo'],
    ['voice', { agent, voices: { voices: [] } }, 'Save voice'],
    ['words', agent, 'Save words'],
  ] as const)('%s is unchanged without can_edit', async (file, data, control) => {
    mocks.resource.data = data;
    const out = everything((await screen(file))());
    expect(out).not.toContain(VIEW_ONLY_AGENT_NOTE);
    expect(out).toContain(control);
  });
});
