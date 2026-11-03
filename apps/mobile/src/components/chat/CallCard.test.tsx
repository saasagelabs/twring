import type { ThreadMessage } from '@twring/contracts';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('@/components/Icon', () => ({ Icon: () => null }));
vi.mock('@/theme/fonts', () => ({ font: { interMedium: 'medium', mono: 'mono' } }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({
    surface: '#111',
    border: '#222',
    danger: '#f00',
    textPrimary: '#fff',
    textSecondary: '#aaa',
    textTertiary: '#888',
    accent: '#0ff',
  }),
}));

import { CallCard } from './CallCard';

it('shows the missed call and calls back', () => {
  const onCallBack = vi.fn();
  const message = {
    kind: 'ring',
    outcome: 'missed',
    reason: 'Need your help',
  } as Extract<ThreadMessage, { kind: 'ring' }>;
  const card = CallCard({ message, name: 'Hermes', time: '10:42', onCallBack }) as ReactElement<{
    children: ReactNode;
  }>;
  const children = Children.toArray(card.props.children).filter(isValidElement);
  const chip = children[0] as ReactElement<{ accessibilityLabel: string }>;
  const button = children[1] as ReactElement<{ accessibilityLabel: string; onPress: () => void }>;
  expect(chip.props.accessibilityLabel).toBe('Missed call · Need your help, 10:42');
  expect(button.props.accessibilityLabel).toBe('Call back');
  button.props.onPress();
  expect(onCallBack).toHaveBeenCalledOnce();
});
