import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/theme/tokens', () => ({
  callPalette: { textPrimary: 'white' },
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
}));

import { CallBackButton } from './CallBackButton';

type Props = Record<string, unknown> & { onPress?: () => void; children?: unknown };
const texts = (node: unknown): string[] => {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  return texts((node as ReactElement<Props>).props.children);
};

describe('CallBackButton', () => {
  it('on the active call says Back out loud and in words, and keeps the call going', () => {
    const onPress = vi.fn();
    const element = CallBackButton({
      onPress,
      hint: 'The call keeps going',
      showLabel: true,
    }) as ReactElement<Props>;
    expect(element.props.accessibilityLabel).toBe('Back');
    expect(element.props.accessibilityHint).toBe('The call keeps going');
    expect(texts(element)).toContain('Back');
    element.props.onPress?.();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('on the finished screen is a 48 point Back arrow that closes', () => {
    const close = vi.fn();
    const element = CallBackButton({ onPress: close }) as ReactElement<Props>;
    expect(element.props.accessibilityLabel).toBe('Back');
    expect(element.props.accessibilityRole).toBe('button');
    expect(element.props.style).toMatchObject({ minWidth: 48, minHeight: 48 });
    expect(texts(element)).not.toContain('Back');
    element.props.onPress?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
