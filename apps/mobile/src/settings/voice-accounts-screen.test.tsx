import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { ApiError } from '../api/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KeysResource {
  data: unknown;
  error: unknown;
  loading: boolean;
  refreshing: boolean;
  reload: (options?: { silent?: boolean }) => void;
}

const mocks = vi.hoisted(() => {
  const keys: KeysResource = {
    data: undefined,
    error: undefined,
    loading: false,
    refreshing: false,
    reload: () => undefined,
  };
  return {
    state: [] as unknown[],
    cursor: 0,
    keys,
    setListeningProvider: vi.fn(),
    haptic: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    // Effects run right after the render that scheduled them.
    useEffect: (effect: () => void) => effect(),
    useRef: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = { current: initial };
      return mocks.state[slot];
    },
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
  Alert: { alert: vi.fn() },
}));
vi.mock('@/api', () => ({
  twringApi: () => ({ setListeningProvider: mocks.setListeningProvider }),
}));
vi.mock('@/api/client', () => import('../api/client'));
vi.mock('@/api/errors', () => import('../api/errors'));
vi.mock('@/settings/voice-accounts', () => import('./voice-accounts'));
// Like the real hook: a fresh object each render, the same `data` until a read lands.
vi.mock('@/hooks/useResource', () => ({ useResource: () => ({ ...mocks.keys }) }));
vi.mock('@/components/Choice', () => ({ Choice: 'Choice' }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.haptic }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa', border: '#333' }),
  space: { lg: 16, md: 12, sm: 8 },
  radius: { md: 8 },
  type: { body: {}, title: {} },
}));

import VoiceAccountsScreen from '../app/settings/voice-accounts';

const at = '2026-10-27T10:00:00.000Z';
const added = { last4: 'abcd', added_at: at, verified_at: at };
function state(listening: 'deepgram' | 'xai', choice = true) {
  return {
    providers: [
      { provider: 'deepgram', added },
      { provider: 'cartesia', added: null },
      { provider: 'xai', added: choice ? added : null },
    ],
    listening,
    listening_choice: choice,
  };
}

function render(): ReactElement {
  mocks.cursor = 0;
  return VoiceAccountsScreen();
}
function elements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [element, ...Children.toArray(element.props.children).flatMap(elements)];
}
type ChoiceProps = { label: string; selected: boolean; onPress: () => void };
function choices(tree: ReactElement): ChoiceProps[] {
  return elements(tree)
    .filter((element) => element.type === 'Choice')
    .map((element) => element.props as ChoiceProps);
}
const selectedLabel = (tree: ReactElement) => choices(tree).find((c) => c.selected)?.label;
const tap = (label: string) =>
  choices(render())
    .find((c) => c.label === label)
    ?.onPress();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.state = [];
  mocks.keys.data = state('deepgram');
  mocks.keys.error = undefined;
  mocks.keys.reload = vi.fn();
  mocks.setListeningProvider.mockReset();
  mocks.haptic.mockReset();
});

describe('listening choice', () => {
  it('hidden when the GET failed or the choice is off', () => {
    mocks.keys.data = undefined;
    expect(choices(render())).toHaveLength(0);
    mocks.keys.data = state('deepgram', false);
    expect(choices(render())).toHaveLength(0);
    // 'Listening and voice' is a row caption; the choice's own heading must be absent.
    expect(JSON.stringify(render())).not.toContain('"Listening"');
    expect(JSON.stringify(render())).not.toContain('Choose which one does');
  });

  it('shows the server choice', () => {
    expect(selectedLabel(render())).toBe('Deepgram');
    mocks.keys.data = state('xai');
    expect(selectedLabel(render())).toBe('xAI');
  });

  it('a tap shows the new choice at once', () => {
    mocks.setListeningProvider.mockReturnValue(new Promise(() => undefined));
    tap('xAI');
    expect(selectedLabel(render())).toBe('xAI');
  });

  it('a double tap sends one request', () => {
    mocks.setListeningProvider.mockReturnValue(new Promise(() => undefined));
    tap('xAI');
    tap('xAI');
    tap('Deepgram');
    expect(mocks.setListeningProvider).toHaveBeenCalledTimes(1);
  });

  it('after a successful switch, the choice stays on xAI while the re-read is in flight', async () => {
    mocks.setListeningProvider.mockResolvedValue(undefined);
    tap('xAI');
    await flush();
    expect(mocks.haptic).toHaveBeenCalledWith('connected');
    expect(mocks.keys.reload).toHaveBeenCalled();
    // keys.data is still the pre-switch read (reload has not answered, or failed silently).
    expect(selectedLabel(render())).toBe('xAI');
  });

  it('after a successful switch whose re-read failed, tapping Deepgram switches back', async () => {
    mocks.setListeningProvider.mockResolvedValue(undefined);
    tap('xAI');
    await flush();
    tap('Deepgram');
    expect(mocks.setListeningProvider).toHaveBeenLastCalledWith('deepgram');
  });

  it('a failed switch rolls back and names both providers', async () => {
    mocks.setListeningProvider.mockRejectedValue(new Error('offline'));
    tap('xAI');
    await flush();
    const tree = render();
    expect(selectedLabel(tree)).toBe('Deepgram');
    expect(mocks.haptic).toHaveBeenCalledWith('error');
    expect(JSON.stringify(tree)).toContain(
      "Couldn't switch listening to xAI. Deepgram still listens. Try again.",
    );
    expect(mocks.keys.reload).toHaveBeenCalledWith({ silent: true });
  });

  it('a failed switch back from xAI names xAI as still listening', async () => {
    mocks.keys.data = state('xai');
    mocks.setListeningProvider.mockRejectedValue(new Error('offline'));
    tap('Deepgram');
    await flush();
    expect(JSON.stringify(render())).toContain(
      "Couldn't switch listening to Deepgram. xAI still listens. Try again.",
    );
  });

  it('a tap on the current choice sends nothing', () => {
    tap('Deepgram');
    expect(mocks.setListeningProvider).not.toHaveBeenCalled();
  });

  it('three rows, xAI last', () => {
    const text = JSON.stringify(render());
    expect(text.indexOf('Deepgram')).toBeLessThan(text.indexOf('Cartesia'));
    expect(text.indexOf('Cartesia')).toBeLessThan(text.indexOf('xAI'));
  });

  it('a refused switch shows the server sentence for 400 and 429', async () => {
    for (const status of [400, 429]) {
      mocks.state = [];
      mocks.setListeningProvider.mockRejectedValue(
        new ApiError(
          'http',
          'bad_request',
          'r',
          undefined,
          status,
          undefined,
          'Add an xAI key first.',
        ),
      );
      tap('xAI');
      await flush();
      const text = JSON.stringify(render());
      expect(text).toContain('Add an xAI key first.');
      expect(text).not.toContain("Couldn't switch listening");
    }
  });

  it('a server error keeps the plain switch sentence', async () => {
    mocks.setListeningProvider.mockRejectedValue(
      new ApiError('http', 'internal_error', 'r', undefined, 503, undefined, 'Boom.'),
    );
    tap('xAI');
    await flush();
    expect(JSON.stringify(render())).toContain(
      "Couldn't switch listening to xAI. Deepgram still listens. Try again.",
    );
  });

  it('explains the choice in plain words', () => {
    expect(JSON.stringify(render())).toContain(
      'Deepgram and xAI can both listen on your calls. Choose which one does.',
    );
  });
});

describe('races', () => {
  it('switch twice quickly across a re-read shows the last accepted choice', async () => {
    let resolveSecond: () => void = () => undefined;
    mocks.setListeningProvider
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise<void>((r) => (resolveSecond = r)));
    tap('xAI'); // rendered against D0
    await flush();
    expect(selectedLabel(render())).toBe('xAI');
    tap('Deepgram'); // tapped while data is still D0
    // R1 (started after the first success) lands: server says xai.
    mocks.keys.data = state('xai');
    expect(selectedLabel(render())).toBe('Deepgram'); // pending
    resolveSecond();
    await flush();
    // Server accepted deepgram; R2 not answered yet (or failed silently).
    expect(selectedLabel(render())).toBe('Deepgram');
  });

  it('a fresh read replaces the held choice (change made on another phone)', async () => {
    mocks.setListeningProvider.mockResolvedValue(undefined);
    tap('xAI');
    await flush();
    mocks.keys.data = state('deepgram'); // re-read: another phone switched back
    expect(selectedLabel(render())).toBe('Deepgram');
  });

  it('switch then remove a key: the fresh read hides the choice', async () => {
    mocks.setListeningProvider.mockResolvedValue(undefined);
    tap('xAI');
    await flush();
    mocks.keys.data = state('deepgram', false);
    expect(choices(render())).toHaveLength(0);
  });

  it('the held choice survives an unrelated re-render with the same data object', async () => {
    mocks.setListeningProvider.mockResolvedValue(undefined);
    tap('xAI');
    await flush();
    render();
    expect(selectedLabel(render())).toBe('xAI');
  });
});
