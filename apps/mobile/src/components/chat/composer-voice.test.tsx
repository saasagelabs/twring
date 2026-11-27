import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The mic in a private chat asks once before recording (owner, 2026-11-27). */
const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  record: vi.fn(),
  permission: vi.fn(() => Promise.resolve({ granted: true })),
}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
    useRef: (current: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = { current };
      return mocks.state[slot];
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
              ? (next as (v: unknown) => unknown)(mocks.state[slot])
              : next;
        },
      ];
    },
  };
});
vi.mock('expo-router', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native', () => ({
  Animated: { Value: class {}, View: 'AnimatedView' },
  StyleSheet: { create: (styles: unknown) => styles },
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));
vi.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: mocks.permission },
  RecordingPresets: { HIGH_QUALITY: {} },
  setAudioModeAsync: () => Promise.resolve(),
  useAudioRecorder: () => ({
    prepareToRecordAsync: () => Promise.resolve(),
    record: mocks.record,
    stop: () => Promise.resolve(),
  }),
}));
vi.mock('expo-file-system', () => ({ File: class {} }));
vi.mock('react-native-reanimated', () => ({ useReducedMotion: () => false }));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/theme/fonts', () => ({ font: {} }));
vi.mock('@/theme/tokens', () => ({
  radius: {},
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({}),
}));
vi.mock('@/threads/presentation', () => ({ callDuration: () => '0:00' }));
vi.mock('@/observability/sentry', () => ({ reportClientError: vi.fn() }));
vi.mock('./AttachSheet', () => ({ AttachSheet: 'AttachSheet' }));
vi.mock('./AttachmentTray', () => ({ AttachmentTray: 'AttachmentTray' }));
vi.mock('./PrivateChat', () => ({ VoiceConsentCard: 'VoiceConsentCard' }));

type Props = Record<string, unknown> & { children?: ReactNode };
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(elements)];
}
let Composer: (props: Record<string, unknown>) => ReactElement;
beforeAll(async () => {
  Composer = (await import('./Composer')).Composer as unknown as typeof Composer;
});
const onVoiceConsent = vi.fn();
beforeEach(() => {
  mocks.state = [];
  mocks.record.mockClear();
  onVoiceConsent.mockClear();
});
function render(askBeforeVoice: boolean) {
  mocks.cursor = 0;
  return elements(
    Composer({
      name: 'Hermes',
      value: '',
      onChange: () => undefined,
      onSend: () => undefined,
      onVoiceSend: () => undefined,
      askBeforeVoice,
      onVoiceConsent,
    }),
  );
}
const of = (all: ReactElement<Props>[], type: string) => all.filter((e) => e.type === type);
const mic = (all: ReactElement<Props>[]) => {
  const found = of(all, 'Pressable').find(
    (p) => p.props.accessibilityLabel === 'Record voice note',
  );
  if (found === undefined) throw new Error('no mic');
  return found.props.onPress as () => void;
};
const card = (all: ReactElement<Props>[]) => of(all, 'VoiceConsentCard');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the mic in a private chat', () => {
  it('shows the card and does not record', async () => {
    mic(render(true))();
    await flush();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(card(render(true))).toHaveLength(1);
  });

  it('"Not now" hides the card, stores nothing and records nothing', async () => {
    mic(render(true))();
    (card(render(true))[0]?.props.onCancel as () => void)();
    await flush();
    expect(card(render(true))).toHaveLength(0);
    expect(onVoiceConsent).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('"Record" stores the consent, then records at once', async () => {
    mic(render(true))();
    (card(render(true))[0]?.props.onRecord as () => void)();
    expect(onVoiceConsent).toHaveBeenCalledOnce();
    await flush();
    expect(mocks.permission).toHaveBeenCalled();
    expect(mocks.record).toHaveBeenCalledOnce();
  });

  it('with consent given, the mic records straight away', async () => {
    mic(render(false))();
    await flush();
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(card(render(false))).toHaveLength(0);
  });
});
