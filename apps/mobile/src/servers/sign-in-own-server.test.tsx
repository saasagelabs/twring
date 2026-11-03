import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import type * as ReactModule from 'react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: 'AppleButton',
  AppleAuthenticationButtonType: { CONTINUE: 1 },
  AppleAuthenticationButtonStyle: { WHITE: 1 },
}));
vi.mock('expo-router', () => ({ router: { push: mocks.push } }));
vi.mock('@/auth', () => ({
  useAuth: () => ({ status: 'signed_out' }),
  authController: () => ({ appleAvailable: true }),
}));
vi.mock('@/components/Brand', () => ({ TwringLockup: 'TwringLockup' }));
vi.mock('@/components/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }));
vi.mock('@/components/PrimaryButton', () => ({ PrimaryButton: 'PrimaryButton' }));
vi.mock('@/components/Screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/TextButton', () => ({ TextButton: 'TextButton' }));
vi.mock('@/components/Waveform', () => ({ Waveform: 'Waveform' }));
vi.mock('@/servers/saved-servers', () => ({ SavedServers: 'SavedServers' }));
vi.mock('@/platform/haptics', () => ({ playCallFeedback: vi.fn() }));
vi.mock('@/theme/tokens', () => ({
  usePalette: () => ({ accent: '#0ff', textPrimary: '#fff', textSecondary: '#aaa' }),
  space: { lg: 16, md: 12, xl: 24, xxxl: 48 },
  type: { display: {}, body: {} },
}));

import SignInScreen from '../app/sign-in';

type Props = { label?: string; onPress?: () => void };

function elements(node: ReactNode): ReactElement<Props>[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ children?: ReactNode; footer?: ReactNode } & Props>;
  return [
    element as ReactElement<Props>,
    ...Children.toArray(element.props.children).flatMap(elements),
    ...elements(element.props.footer),
  ];
}

describe('sign-in screen', () => {
  it('keeps Google and Apple and offers Use my own server beside Privacy', () => {
    const all = elements(SignInScreen());
    expect(all.some((e) => e.type === 'AppleButton')).toBe(true);
    expect(all.find((e) => e.props.label === 'Continue with Google')).toBeDefined();
    expect(all.find((e) => e.props.label === 'Privacy')).toBeDefined();
    all.find((e) => e.props.label === 'Use my own server')?.props.onPress?.();
    expect(mocks.push).toHaveBeenCalledWith('/pair');
  });

  it('lists saved servers under the sign-in buttons', () => {
    const all = elements(SignInScreen());
    const google = all.findIndex((e) => e.props.label === 'Continue with Google');
    const saved = all.findIndex((e) => e.type === 'SavedServers');
    expect(saved).toBeGreaterThan(google);
  });
});
