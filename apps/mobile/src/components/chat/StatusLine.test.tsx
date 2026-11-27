import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('@/theme/fonts', () => ({ font: { mono: 'mono' } }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: (v: number) => ({ value: v }),
  withDelay: () => 0,
  withRepeat: () => 0,
  withTiming: () => 0,
}));
vi.mock('@/components/GhostButton', () => ({ GhostButton: () => null }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ accent: 'a', danger: 'd', textTertiary: 't', textSecondary: 's' }),
  type: { body: { fontSize: 15 }, microLabel: { fontSize: 11 }, caption: { fontSize: 12 } },
}));
import { StatusLine } from './StatusLine';

type Props = { numberOfLines?: number; children?: ReactNode };
const texts = (node: ReactNode): ReactElement<Props>[] =>
  Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    const own = child.type === 'Text' ? [child] : [];
    return [...own, ...texts(child.props.children)];
  });
const render = (content: Parameters<typeof StatusLine>[0]['content']) =>
  texts(
    StatusLine({ name: 'Hermes', content, onStop: vi.fn(), onRetry: vi.fn(), onDelete: vi.fn() }),
  );

it('a long failed-send message wraps instead of being cut to one line', () => {
  const [status] = render({
    kind: 'status',
    tone: 'danger',
    text: "Didn't go through: this chat is private. Record the voice note again.",
    retryClientId: 'c1',
  });
  expect(status.props.numberOfLines).toBeUndefined();
});

it('the working line still keeps to one line', () => {
  const [working] = render({
    kind: 'working',
    text: 'Working · Reading files',
    label: 'Reading files',
  });
  expect(working.props.numberOfLines).toBe(1);
});
