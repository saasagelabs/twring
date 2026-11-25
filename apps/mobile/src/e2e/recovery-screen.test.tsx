import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as RecoveryModule from './recovery';

const mocks = vi.hoisted(() => {
  const params: { mode?: string } = {};
  return {
    state: [] as unknown[],
    cursor: 0,
    effects: 0,
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    params,
    feedback: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    restoreOffer: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    // Effects run once per screen, as on mount.
    useEffect: (effect: () => unknown) => {
      if (mocks.effects++ === 0) void effect();
    },
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
  router: { back: mocks.back, replace: mocks.replace, push: mocks.push },
  useLocalSearchParams: () => mocks.params,
}));
vi.mock('@/e2e/recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>('./recovery');
  return {
    ...actual,
    saveRecoveryKey: mocks.save,
    restoreFromWords: mocks.restore,
    restoreOffer: mocks.restoreOffer,
  };
});
vi.mock('@/e2e/pair-api', () => ({ recoveryApi: () => ({}) }));
vi.mock('@/threads/chats', () => ({
  privateKeychain: () => ({}),
  currentScope: () => 'hosted_u1',
}));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/theme/fonts', () => ({ font: { display: 'd', body: 'b' } }));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16, md: 12, sm: 8 },
}));

import PrivateRecoveryScreen from '../app/private/recovery';

type Props = {
  label?: string;
  disabled?: boolean;
  value?: string;
  onChangeText?: (text: string) => unknown;
  onPress?: () => unknown;
  autoCorrect?: boolean;
  spellCheck?: boolean;
  autoComplete?: string;
  importantForAutofill?: string;
  children?: ReactNode;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(): ReactElement {
  mocks.cursor = 0;
  return PrivateRecoveryScreen();
}

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; footer?: ReactNode } & Props>;
  return [
    element as ReactElement<Props>,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
  ];
}

function labelled(tree: ReactElement, label: string): ReactElement<Props> {
  const found = elements(tree).find((e) => e.props.label === label);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

const text = (tree: ReactElement) => JSON.stringify(tree);
const fields = (tree: ReactElement) => elements(tree).filter((e) => e.type === 'Field');
const shownWords = (tree: ReactElement) =>
  elements(tree)
    .filter((e) => e.type === 'Text' && typeof e.props.children === 'string')
    .map((e) => /^\d+\. (\w+)$/.exec(e.props.children as string)?.[1])
    .filter((w): w is string => w !== undefined);

function expectPrivateInput(field: ReactElement<Props>) {
  expect(field.props).toMatchObject({
    autoCorrect: false,
    spellCheck: false,
    autoComplete: 'off',
    importantForAutofill: 'no',
  });
}

beforeEach(() => {
  mocks.state = [];
  mocks.effects = 0;
  mocks.params = {};
  mocks.back.mockReset();
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.feedback.mockReset();
  mocks.save.mockReset().mockResolvedValue({ ok: true });
  mocks.restore.mockReset();
  mocks.restoreOffer.mockReset();
});

describe('recovery key screen: create', () => {
  function toCheck(): string[] {
    void labelled(render(), 'Show my 12 words').props.onPress?.();
    const words = shownWords(render());
    void labelled(render(), 'I wrote them down').props.onPress?.();
    return words;
  }
  const typeChecks = (a: string, b: string) => {
    void fields(render())[0].props.onChangeText?.(a);
    void fields(render())[1].props.onChangeText?.(b);
  };

  it('shows 12 words once, then asks for words 3 and 9 with private inputs', () => {
    const words = toCheck();
    expect(words).toHaveLength(12);
    const tree = render();
    expect(fields(tree).map((f) => f.props.label)).toEqual(['Word 3', 'Word 9']);
    fields(tree).forEach(expectPrivateInput);
    expect(shownWords(tree)).toEqual([]);
  });

  it('refuses wrong words, then saves with the right ones', async () => {
    const words = toCheck();
    typeChecks('nope', 'nope');
    void labelled(render(), 'Save recovery key').props.onPress?.();
    await flush();
    expect(text(render())).toContain("Those words don't match. Check them and try again.");
    expect(mocks.save).not.toHaveBeenCalled();
    typeChecks(words[2].toUpperCase(), ` ${words[8]}`);
    void labelled(render(), 'Save recovery key').props.onPress?.();
    await flush();
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'hosted_u1' }),
      words,
    );
    expect(text(render())).toContain('Recovery key saved');
  });

  it('Not now leaves without saving', () => {
    void labelled(render(), 'Not now').props.onPress?.();
    expect(mocks.back).toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe('recovery key screen: restore', () => {
  beforeEach(() => {
    mocks.params = { mode: 'restore' };
  });

  async function typeAndRestore(words: string): Promise<ReactElement> {
    render();
    await flush();
    void fields(render())[0].props.onChangeText?.(words);
    void labelled(render(), 'Restore').props.onPress?.();
    await flush();
    return render();
  }

  it('restores from typed words with a private input', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'found', backup: { device_id: 'dev_x' } });
    mocks.restore.mockResolvedValue({ ok: true, deviceId: 'dev_x' });
    render();
    await flush();
    expectPrivateInput(fields(render())[0]);
    const tree = await typeAndRestore('words');
    expect(mocks.restore).toHaveBeenCalledWith(expect.anything(), { device_id: 'dev_x' }, 'words');
    expect(text(tree)).toContain('Restored');
  });

  it('says the words do not match', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'found', backup: {} });
    mocks.restore.mockResolvedValue({ ok: false, code: 'wrong_words' });
    expect(text(await typeAndRestore('a b c'))).toContain(
      "Those words don't match. Check them and try again.",
    );
  });

  it('says a damaged backup cannot be opened', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'found', backup: {} });
    mocks.restore.mockResolvedValue({ ok: false, code: 'damaged' });
    expect(text(await typeAndRestore('a b c'))).toContain("This recovery key can't be opened here");
  });

  it('says plainly when the phone was removed, and goes on to pairing', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'removed' });
    render();
    await flush();
    const tree = render();
    expect(text(tree)).toContain('removed from Private chats');
    void labelled(tree, 'Pair this phone').props.onPress?.();
    expect(mocks.replace).toHaveBeenCalledWith('/private/pair');
  });

  it('goes straight to pairing when there is no backup', async () => {
    mocks.restoreOffer.mockResolvedValue({ kind: 'none' });
    render();
    await flush();
    expect(mocks.replace).toHaveBeenCalledWith('/private/pair');
  });
});
