import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: [] as unknown[],
  cursor: 0,
  back: vi.fn(),
  feedback: vi.fn(),
  parsePairInput: vi.fn(),
  claimPairing: vi.fn(),
  confirmPairing: vi.fn(),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
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
  Platform: { OS: 'android' },
}));
vi.mock('expo-router', () => ({ router: { back: mocks.back, replace: vi.fn() } }));
vi.mock('@/e2e/pairing', () => ({
  parsePairInput: mocks.parsePairInput,
  claimPairing: mocks.claimPairing,
  confirmPairing: mocks.confirmPairing,
}));
vi.mock('@/e2e/pair-api', () => ({ pairApi: () => ({}) }));
vi.mock('@/platform/secure-store', () => ({
  deviceOnlyStore: { deviceOnly: true },
  secureStore: { deviceOnly: false },
}));
vi.mock('@/servers/active', () => ({ activeServerUrl: () => 'https://api.twring.com' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: mocks.feedback }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/GhostButton', () => ({ GhostButton: 'GhostButton' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/QrScanner', () => ({ QrScanner: 'QrScanner' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/theme/fonts', () => ({ font: { display: 'd', body: 'b' } }));
vi.mock('@/theme/tokens', () => ({
  type: new Proxy({}, { get: () => ({ fontSize: 0 }) }),
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16, md: 12 },
}));

import PrivatePairScreen from '../app/private/pair';

type Props = {
  label?: string;
  accessibilityLabel?: string;
  onPress?: () => unknown;
  onScanned?: (data: string) => unknown;
  onTypeInstead?: () => unknown;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function render(): ReactElement {
  mocks.cursor = 0;
  return PrivatePairScreen();
}

function elements(node: ReactNode): ReactElement<Props>[] {
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

async function scan(data = 'twring-pair:abc'): Promise<ReactElement> {
  void labelled(render(), 'Scan the code on your computer').props.onPress?.();
  const scanner = elements(render()).find((e) => e.type === 'QrScanner');
  void scanner?.props.onScanned?.(data);
  await flush();
  return render();
}

beforeEach(() => {
  mocks.state = [];
  mocks.back.mockReset();
  mocks.feedback.mockReset();
  mocks.parsePairInput.mockReset().mockReturnValue({ kind: 'qr', offer: {} });
  mocks.claimPairing
    .mockReset()
    .mockResolvedValue({ ok: true, safety: '123 456', connector: { id: 'dev_c' } });
  mocks.confirmPairing.mockReset().mockResolvedValue(undefined);
});

describe('private chat pairing screen', () => {
  it('offers to scan, with help text and no way to type a code', () => {
    const tree = render();
    expect(text(tree)).toContain('Ask your agent on the computer to show the pairing code.');
    expect(text(tree)).not.toMatch(/type the code|type a code|MCP|connector|twring-connect/i);
  });

  it('asks to compare the code and stores only after yes', async () => {
    const tree = await scan();
    expect(text(tree)).toContain('Does your computer show 123 456?');
    expect(mocks.confirmPairing).not.toHaveBeenCalled();
    void labelled(tree, 'Yes, same number').props.onPress?.();
    await flush();
    expect(mocks.confirmPairing).toHaveBeenCalledWith(
      { store: { deviceOnly: true } },
      { id: 'dev_c' },
    );
    expect(mocks.claimPairing.mock.calls[0]?.[0]).toMatchObject({ store: { deviceOnly: true } });
    expect(mocks.feedback).toHaveBeenCalledWith('connected');
    expect(text(render())).toContain('Paired');
  });

  it('stores nothing when the numbers differ', async () => {
    const tree = await scan();
    void labelled(tree, 'No').props.onPress?.();
    await flush();
    expect(text(render())).toMatch(/Pairing stopped/);
    expect(mocks.confirmPairing).not.toHaveBeenCalled();
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('reads the code aloud for screen readers, digit by digit', async () => {
    const tree = await scan();
    expect(
      elements(tree).some((e) => e.props.accessibilityLabel === 'Safety code 1 2 3 4 5 6'),
    ).toBe(true);
  });

  it('refuses a server that answered with another key, with an error haptic', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'mismatch' });
    const tree = await scan();
    expect(text(tree)).toMatch(/Pairing stopped/);
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('says what to do when the code expired or the device list is full', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'expired' });
    expect(text(await scan())).toContain('This code has expired.');
    mocks.state = [];
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'cap' });
    expect(text(await scan())).toContain('You already have 5 devices.');
  });

  it('says plainly when the code is for another server', async () => {
    mocks.claimPairing.mockResolvedValue({ ok: false, code: 'wrong_server' });
    expect(text(await scan())).toContain('This code is for a different Twring server.');
    expect(mocks.claimPairing.mock.calls[0]?.[0]).toMatchObject({
      activeServer: 'https://api.twring.com',
    });
    expect(mocks.feedback).toHaveBeenCalledWith('error');
  });

  it('keeps scanning after a code that is not a pairing code', async () => {
    mocks.parsePairInput.mockReturnValue(undefined);
    const tree = await scan('https://example.com');
    expect(mocks.claimPairing).not.toHaveBeenCalled();
    expect(text(tree)).toContain('not a pairing code');
    expect(elements(tree).some((e) => e.type === 'QrScanner')).toBe(true);
  });
});
