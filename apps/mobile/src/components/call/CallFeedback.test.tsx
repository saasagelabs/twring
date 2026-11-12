import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type * as ReactModule from 'react';

const harness = vi.hoisted(() => {
  const active: { kind: string } = { kind: 'hosted' };
  return { values: [] as unknown[], cursor: 0, send: vi.fn(), active };
});
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (index >= harness.values.length) harness.values[index] = initial;
      return [
        harness.values[index],
        (next: unknown) => {
          harness.values[index] =
            typeof next === 'function'
              ? (next as (value: unknown) => unknown)(harness.values[index])
              : next;
        },
      ];
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => undefined,
  };
});
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));
vi.mock('@/api', () => ({ twringApi: () => ({ sendCallFeedback: harness.send }) }));
vi.mock('@/api/errors', () => ({
  apiErrorCopy: () => ({ message: 'Could not send', retryable: true }),
}));
vi.mock('@/servers/active', () => ({ useActiveServer: () => harness.active }));
vi.mock('@/theme/tokens', () => ({
  radius: new Proxy({}, { get: () => 0 }),
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({
    accent: 'cyan',
    textPrimary: 'white',
    border: 'gray',
    surface: 'black',
    surfaceRaised: 'gray',
  }),
  space: { xs: 4, sm: 8, md: 12 },
}));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));

import { CallFeedback } from './CallFeedback';

const render = () => {
  harness.cursor = 0;
  return CallFeedback({ callId: 'call_abcdefghij0123456789' });
};
type ElementProps = Record<string, unknown> & { onPress?: () => void };
function find(
  node: unknown,
  predicate: (props: ElementProps) => boolean,
): ReactElement<ElementProps> | undefined {
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as ReactElement<ElementProps>;
  if (predicate(element.props)) return element;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return undefined;
}
const byLabel = (node: unknown, label: string) =>
  find(node, (props) => props.accessibilityLabel === label || props.label === label);

beforeEach(() => {
  harness.values = [];
  harness.cursor = 0;
  harness.send.mockReset();
  harness.active = { kind: 'hosted' };
});

describe('CallFeedback', () => {
  it('reveals the issue chips once any rating is picked, five stars included', () => {
    expect(byLabel(render(), 'Cut me off')).toBeUndefined();
    byLabel(render(), '5 stars')?.props.onPress?.();
    expect(byLabel(render(), 'Cut me off')).toBeDefined();
    byLabel(render(), '2 stars')?.props.onPress?.();
    expect(byLabel(render(), 'Misheard me')).toBeDefined();
  });

  it('sends the selected rating and issues; skip sends nothing', async () => {
    harness.send.mockResolvedValue(undefined);
    byLabel(render(), '2 stars')?.props.onPress?.();
    byLabel(render(), 'Slow replies')?.props.onPress?.();
    byLabel(render(), 'Send')?.props.onPress?.();
    await Promise.resolve();
    expect(harness.send).toHaveBeenCalledWith(
      'call_abcdefghij0123456789',
      { rating: 2, issues: ['slow'] },
      expect.any(AbortSignal),
    );
    expect(
      find(render(), (props) => props.children === 'Thanks. This helps us improve Twring.'),
    ).toBeDefined();
    harness.values = [];
    harness.cursor = 0;
    harness.send.mockClear();
    byLabel(render(), 'Skip')?.props.onPress?.();
    expect(render()).toBeNull();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('shows the standard notice and keeps retry available on failure', async () => {
    harness.send.mockRejectedValue(new Error('offline'));
    byLabel(render(), '1 star')?.props.onPress?.();
    byLabel(render(), 'Send')?.props.onPress?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(find(render(), (props) => 'error' in props && 'onRetry' in props)).toBeDefined();
  });

  it('shows no rating prompt on your own server', () => {
    harness.active = { kind: 'selfhost' };
    expect(render()).toBeNull();
  });
});
