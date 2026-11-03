import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const access: { status: string; email?: string } = {
    status: 'waitlist',
    email: 'alice@example.com',
  };
  return {
    state: [] as unknown[],
    cursor: 0,
    access,
    redeem: vi.fn(),
    checkAccess: vi.fn(),
    recheckAccess: vi.fn(),
    useRecheckOnReturn: vi.fn(),
  };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const slot = mocks.cursor++;
      if (!(slot in mocks.state)) mocks.state[slot] = initial;
      return [
        mocks.state[slot],
        (next: unknown) => {
          mocks.state[slot] = next;
        },
      ];
    },
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/access/store', () => ({
  useAccess: () => mocks.access,
  redeem: mocks.redeem,
  checkAccess: mocks.checkAccess,
  recheckAccess: mocks.recheckAccess,
  useRecheckOnReturn: mocks.useRecheckOnReturn,
}));
vi.mock('@/auth', () => ({
  useAuth: () => ({ status: 'signed_in', email: 'alice@example.com' }),
  authController: () => ({ signOut: vi.fn() }),
}));
vi.mock('@/components/Brand', () => ({ TwringLockup: 'TwringLockup' }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/Field', () => ({ Field: 'Field' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: vi.fn() }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16 },
  type: { display: {}, body: {}, title: {} },
}));

import WaitlistScreen from '../app/waitlist';

function render(): ReactElement {
  mocks.cursor = 0;
  return WaitlistScreen();
}

function elements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; footer?: ReactNode }>;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
  ];
}

function labelled(
  tree: ReactElement,
  label: string,
): ReactElement<{
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  onChangeText?: (value: string) => void;
}> {
  const found = elements(tree).find(
    (element) => (element.props as { label?: string }).label === label,
  );
  if (!found) throw new Error(`missing ${label}`);
  return found as ReactElement<{
    label: string;
    onPress?: () => void;
    disabled?: boolean;
    onChangeText?: (value: string) => void;
  }>;
}

beforeEach(() => {
  mocks.state = [];
  mocks.access = { status: 'waitlist', email: 'alice@example.com' };
  mocks.redeem.mockReset();
  mocks.checkAccess.mockReset();
  mocks.recheckAccess.mockReset();
  mocks.useRecheckOnReturn.mockReset();
});

/** Opens the code box, as a person with an invite code does. */
function withCode(): ReactElement {
  labelled(render(), 'I have an invite code').props.onPress?.();
  return render();
}

describe('waitlist screen', () => {
  it('says plainly to come back tomorrow, with no code in sight', () => {
    const tree = render();
    const text = JSON.stringify(tree);
    expect(text).toContain("You're almost in");
    expect(text).toContain('New places open every day');
    expect(text).not.toContain("you'll be in");
    expect(text).toContain('alice@example.com');
    expect(text).not.toContain('will email you an invite code');
    expect(text).not.toContain('Have one already');
    expect(() => labelled(tree, 'Invite code')).toThrow();
    labelled(tree, 'Check again');
    labelled(tree, 'I have an invite code');
    labelled(tree, 'Sign out');
    labelled(tree, 'Privacy');
  });

  it('checks again on tap and whenever the app comes back, and says when still full', async () => {
    const tree = render();
    expect(mocks.useRecheckOnReturn).toHaveBeenCalled();
    expect(JSON.stringify(tree)).not.toContain('Still full today');
    mocks.recheckAccess.mockResolvedValue(undefined);
    labelled(tree, 'Check again').props.onPress?.();
    expect(mocks.recheckAccess).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(JSON.stringify(render())).toContain('Still full today'));
  });

  it('requires six digits and normalizes pasted spacing', async () => {
    expect(labelled(withCode(), 'Activate account').props.disabled).toBe(true);
    labelled(render(), 'Invite code').props.onChangeText?.('123 456');
    const tree = render();
    expect(labelled(tree, 'Activate account').props.disabled).toBe(false);
    mocks.redeem.mockResolvedValue({ ok: true });
    labelled(tree, 'Activate account').props.onPress?.();
    await vi.waitFor(() => expect(mocks.redeem).toHaveBeenCalledWith('123456'));
  });

  it('shows an invalid invite error', async () => {
    labelled(withCode(), 'Invite code').props.onChangeText?.('123456');
    mocks.redeem.mockResolvedValue({
      ok: false,
      error: { message: 'Invalid code', retryable: false },
    });
    labelled(render(), 'Activate account').props.onPress?.();
    await vi.waitFor(() => expect(JSON.stringify(render())).toContain('Invalid code'));
  });

  it('offers access retry when the check failed', () => {
    mocks.access = { status: 'error' };
    const tree = render();
    expect(JSON.stringify(tree)).toContain("Couldn't check your access");
    labelled(tree, 'Try again').props.onPress?.();
    expect(mocks.checkAccess).toHaveBeenCalledOnce();
  });
});
