import type { ThreadMessage } from '@twring/contracts';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { expect, it, vi } from 'vitest';

vi.mock('react', async (original) => ({
  ...(await original<typeof ReactModule>()),
  useState: (initial: unknown) => [
    typeof initial === 'function' ? (initial as () => unknown)() : initial,
    vi.fn(),
  ],
  useEffect: () => undefined,
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));
vi.mock('@/theme/fonts', () => ({
  font: {
    microLabel: 'micro',
    headline: 'headline',
    body: 'body',
    interMedium: 'medium',
    mono: 'mono',
  },
}));
vi.mock('@/theme/tokens', () => ({
  radius: new Proxy({}, { get: () => 0 }),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({
    accent: '#0ff',
    surface: '#111',
    borderAccent: '#0ff',
    textPrimary: '#fff',
    textSecondary: '#aaa',
    onAccent: '#000',
    borderStrong: '#555',
    textTertiary: '#888',
    danger: '#f00',
  }),
}));

import * as Cards from './ChatApproval';

/** Renders one level down: both exports draw the same inner card component. */
function shallow(element: ReactElement): ReactElement {
  const inner = element.type as (props: unknown) => ReactElement;
  return inner(element.props);
}
const ChatApproval = (props: Parameters<typeof Cards.ChatApproval>[0]) =>
  shallow(Cards.ChatApproval(props));
const ChatSealedApproval = (props: Parameters<typeof Cards.ChatSealedApproval>[0]) =>
  shallow(Cards.ChatSealedApproval(props));

const message = {
  kind: 'approval',
  status: 'pending',
  id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  title: 'Run the report',
  description: 'Private details',
  expires_at: new Date(Date.now() + 592_000).toISOString(),
  updated_at: '2026-10-13T10:44:00.000Z',
} as Extract<ThreadMessage, { kind: 'approval' }>;

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}

it('shows both decisions and forwards the selected action', async () => {
  const onDecide = vi.fn(() => Promise.resolve());
  const tree = ChatApproval({ message, name: 'Hermes', onDecide });
  const all = elements(tree);
  expect(all[0]?.props).toMatchObject({
    accessibilityLabel: 'Hermes needs your OK: Run the report',
  });
  const buttons = all.filter(
    (item) => (item.props as { accessibilityRole?: string }).accessibilityRole === 'button',
  );
  expect(
    buttons.map((item) => (item.props as { accessibilityLabel: string }).accessibilityLabel),
  ).toEqual(['Allow Run the report', 'Deny Run the report']);
  await (buttons[0].props as { onPress: () => Promise<void> }).onPress();
  expect(onDecide).toHaveBeenCalledWith('approve');
});

it('shows an opened private approval with labelled Allow and Deny of at least 48 dp', async () => {
  const onDecide = vi.fn(() => Promise.resolve());
  const tree = ChatSealedApproval({
    title: 'Use the key to deploy',
    description: 'Production',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    answered: false,
    updatedAt: '2026-11-25T10:00:00.000Z',
    name: 'Laptop Claude',
    onDecide,
  });
  const all = elements(tree);
  expect(all[0]?.props).toMatchObject({
    accessibilityLabel: 'Laptop Claude needs your OK: Use the key to deploy',
  });
  const buttons = all.filter(
    (item) => (item.props as { accessibilityRole?: string }).accessibilityRole === 'button',
  );
  expect(
    buttons.map((item) => (item.props as { accessibilityLabel: string }).accessibilityLabel),
  ).toEqual(['Allow Use the key to deploy', 'Deny Use the key to deploy']);
  for (const button of buttons) {
    const style = (button.props as { style: { minHeight?: number }[] }).style;
    expect(style[0]?.minHeight).toBeGreaterThanOrEqual(48);
  }
  await (buttons[1].props as { onPress: () => Promise<void> }).onPress();
  expect(onDecide).toHaveBeenCalledWith('deny');
});

it('shows an answered or expired private approval as one line', () => {
  const base = {
    title: 'Use the key',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: '2026-11-25T10:00:00.000Z',
    name: 'Laptop Claude',
    onDecide: vi.fn(),
  };
  const answered = ChatSealedApproval({ ...base, answered: true });
  expect((answered.props as { children: string }).children).toContain('Answered ·');
  const expired = ChatSealedApproval({
    ...base,
    answered: false,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  expect((expired.props as { children: string }).children).toBe('Expired: denied');
});

it('collapses an expired or allowed card to one line', () => {
  const onDecide = vi.fn();
  const expired = ChatApproval({
    message: { ...message, status: 'expired' },
    name: 'Hermes',
    onDecide,
  });
  expect(elements(expired)).toHaveLength(1);
  expect((expired.props as { children: string }).children).toBe('Expired: denied');
  const allowed = ChatApproval({
    message: { ...message, status: 'allowed' },
    name: 'Hermes',
    onDecide,
  });
  expect((allowed.props as { children: string }).children).toContain('Allowed ·');
});
