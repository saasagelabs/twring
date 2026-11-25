import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

// useState returns these in call order (all, measured height), then the initial value.
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
vi.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }));
vi.mock('@/theme/fonts', () => ({
  font: { body: 'body', mono: 'mono', bodyEmphasis: 'bodyEmphasis' },
}));
vi.mock('@/theme/tokens', () => ({
  radius: new Proxy({}, { get: () => 0 }),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
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
  expect(setters[1]).toHaveBeenCalledWith(2400);
  // Short or not yet measured: clipped (no visual change when short), no fade, no Show all.
  expect(clipped(all)).toBe(true);
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(false);
  expect(showAll(all)).toBe(false);
});

it('folds a message whose rendered height passes forty lines, whatever its length', () => {
  states.push(false, 40 * 23 + 1);
  const all = render();
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(true);
  expect(showAll(all)).toBe(true);
});

it('shows everything after Show all', () => {
  states.push(true, 4000);
  const all = render();
  expect(all.some((item) => item.type === 'LinearGradient')).toBe(false);
  expect(showAll(all)).toBe(false);
  expect(clipped(all)).toBe(false);
});

const textsOf = (all: ReactElement<Props>[]) =>
  all
    .filter((item) => item.type === 'Text')
    .map((item) =>
      Array.isArray(item.props.children) ? item.props.children.join('') : item.props.children,
    );

it('shows a quoted block above a reply: who wrote it and two lines at most', () => {
  const all = elements(
    Bubble({
      text: 'Yes, do that',
      time: '10:00',
      sender: 'You',
      own: true,
      onLink: vi.fn(),
      quote: { from: 'Hermes', text: 'Shall I book the table?' },
    }),
  );
  const block = all.find((item) => item.props.testID === 'bubble-quote');
  expect(block).toBeDefined();
  expect((block?.props.style as { borderLeftColor?: string }[])[1].borderLeftColor).toBe('#0ff');
  const texts = all.filter((item) => item.type === 'Text');
  expect(textsOf(all)).toContain('Hermes');
  expect(textsOf(all)).toContain('Shall I book the table?');
  expect(
    texts.find((item) => item.props.children === 'Shall I book the table?')?.props.numberOfLines,
  ).toBe(2);
  const bubble = all.find((item) => item.type === 'Pressable');
  expect(bubble?.props.accessibilityLabel).toBe('You, 10:00: replying to Hermes, Yes, do that');
});

it('has no quoted block on a plain message', () => {
  expect(render().some((item) => item.props.testID === 'bubble-quote')).toBe(false);
});

it('offers its long-press choices to screen readers', () => {
  const onAction = vi.fn();
  const all = elements(
    Bubble({
      text: 'hi',
      time: '10:00',
      sender: 'Hermes',
      own: false,
      onLink: vi.fn(),
      actions: [{ name: 'reply', label: 'Reply' }],
      onAction,
    }),
  );
  const bubble = all.find((item) => item.type === 'Pressable');
  expect(bubble?.props.accessibilityActions).toEqual([{ name: 'reply', label: 'Reply' }]);
  (bubble?.props.onAccessibilityAction as (event: unknown) => void)({
    nativeEvent: { actionName: 'reply' },
  });
  expect(onAction).toHaveBeenCalledWith('reply');
});

it('draws "Couldn\'t open this message" as a plain muted line, never as message text', () => {
  const all = elements(
    Bubble({
      text: "Couldn't open this message",
      time: '10:00',
      sender: 'Hermes',
      own: false,
      onLink: vi.fn(),
      muted: true,
    }),
  );
  expect(all.some((item) => item.type === 'MessageText')).toBe(false);
  const line = all.find((item) => item.props.children === "Couldn't open this message");
  expect(line?.type).toBe('Text');
  expect((line?.props.style as { fontStyle?: string }[])[1]).toMatchObject({ fontStyle: 'italic' });
});

it('marks a message the server could read with its caption', () => {
  const all = elements(
    Bubble({
      text: 'hi',
      time: '10:00',
      sender: 'You',
      own: true,
      onLink: vi.fn(),
      caption: 'Sent through Twring',
    }),
  );
  expect(textsOf(all)).toContain('Sent through Twring');
});
