import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// useState returns these in call order (all, copied, measured height), then the initial value.
const states: unknown[] = [];
const setters: ReturnType<typeof vi.fn>[] = [];
vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    setters.push(setter);
    return [states.length ? states.shift() : initial, setter];
  },
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@/theme/fonts', () => ({ font: { body: 'body', mono: 'mono' } }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({
    accent: '#0ff',
    surface: '#111',
    border: '#333',
    textSecondary: '#aaa',
    textTertiary: '#888',
  }),
}));
vi.mock('@/threads/presentation', () => import('../../threads/presentation'));
vi.mock('@/components/Icon', () => ({ Icon: 'Icon' }));
vi.mock('./MessageText', () => ({ MessageText: 'MessageText' }));
vi.mock('./Attachments', () => ({ Attachments: 'Attachments' }));

import { Bubble } from './Bubble';

type Props = { children?: ReactNode; style?: unknown; [key: string]: unknown };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function render() {
  return elements(
    Bubble({ text: 'hello', time: '10:00', sender: 'Hermes', own: false, onLink: vi.fn() }),
  );
}

const clipped = (all: ReactElement<Props>[]) =>
  all.some(
    (item) => item.type === 'View' && (item.props.style as { maxHeight?: number })?.maxHeight,
  );
const showAll = (all: ReactElement<Props>[]) =>
  all.some((item) => item.type === 'Pressable' && item.props.accessibilityRole === 'button');

beforeEach(() => {
  states.length = 0;
  setters.length = 0;
});

it('measures the rendered message and clips it to the fold until measured', () => {
  const all = render();
  const measured = all.find((item) => typeof item.props.onLayout === 'function');
  expect(measured).toBeDefined();
  (measured?.props.onLayout as (event: unknown) => void)({
    nativeEvent: { layout: { height: 2400 } },
  });
  expect(setters[2]).toHaveBeenCalledWith(2400);
  // Short or not yet measured: clipped (no visual change when short), no fade, no Show all.
  expect(clipped(all)).toBe(true);
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(false);
  expect(showAll(all)).toBe(false);
});

it('folds a message whose rendered height passes forty lines, whatever its length', () => {
  states.push(false, false, 40 * 23 + 1);
  const all = render();
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(true);
  expect(showAll(all)).toBe(true);
});

it('shows everything after Show all', () => {
  states.push(true, false, 4000);
  const all = render();
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(false);
  expect(showAll(all)).toBe(false);
  expect(clipped(all)).toBe(false);
});
