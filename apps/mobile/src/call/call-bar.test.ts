import { describe, expect, it } from 'vitest';
import { shouldShowCallBar } from './call-bar';

const active = { status: 'LISTENING', callId: 'call-1' } as const;

describe('shouldShowCallBar', () => {
  it('shows on other screens during a call', () => {
    expect(shouldShowCallBar('/', active)).toBe(true);
    expect(shouldShowCallBar('/agents/123/edit', active)).toBe(true);
  });

  it('hides on call, incoming, and access screens', () => {
    for (const path of ['/call', '/incoming/123', '/sign-in', '/onboarding', '/waitlist']) {
      expect(shouldShowCallBar(path, active)).toBe(false);
    }
  });

  it('hides after the call', () => {
    expect(shouldShowCallBar('/', { status: 'IDLE' })).toBe(false);
  });
});
