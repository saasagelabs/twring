import { describe, expect, it } from 'vitest';

import {
  AVATAR_COLORS,
  HALO_REST,
  avatarColor,
  avatarInitial,
  connectionPill,
  coreScale,
  haloScale,
  orbColor,
  orbRole,
  safeLevel,
} from './call-visuals';
import type { Palette } from './tokens';

const callPalette: Palette = {
  background: 'bg',
  surface: 'surface',
  surfaceRaised: 'raised',
  sheet: 'sheet',
  textPrimary: 'text',
  textSecondary: 'text2',
  textTertiary: 'text3',
  textMuted: 'textMuted',
  border: 'border',
  borderStrong: 'borderStrong',
  borderAccent: 'borderAccent',
  accent: 'accent',
  accentBright: 'accentBright',
  accentDim: 'accentDim',
  onAccent: 'onAccent',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  onDanger: 'onDanger',
  listening: 'listening',
  reconnecting: 'reconnecting',
  userSpeaking: 'user',
  speaking: 'speaking',
  working: 'working',
};

describe('orb roles and colors', () => {
  it('maps each mode to its semantic role', () => {
    expect(orbRole('idle')).toBe('idle');
    expect(orbRole('listening')).toBe('listening');
    expect(orbRole('user')).toBe('userSpeaking');
    expect(orbRole('working')).toBe('working');
    expect(orbRole('agent')).toBe('speaking');
    expect(orbRole('reconnecting')).toBe('reconnecting');
  });

  it('gives the agent and the caller different colors', () => {
    expect(orbColor('speaking', callPalette)).toBe(callPalette.speaking);
    expect(orbColor('userSpeaking', callPalette)).toBe(callPalette.userSpeaking);
    expect(callPalette.speaking).not.toBe(callPalette.userSpeaking);
    expect(orbColor('reconnecting', callPalette)).toBe(callPalette.reconnecting);
    expect(orbColor('working', callPalette)).toBe(callPalette.working);
  });
});

describe('level to scale', () => {
  it('clamps and treats non-finite levels as silence', () => {
    expect(safeLevel(Number.NaN)).toBe(0);
    expect(safeLevel(Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeLevel(-1)).toBe(0);
    expect(safeLevel(3)).toBe(1);
  });

  it('scales the core from 1.0 to 1.25', () => {
    expect(coreScale(0)).toBe(1);
    expect(coreScale(1)).toBeCloseTo(1.25);
    expect(coreScale(Number.NaN)).toBe(1);
    expect(coreScale(5)).toBeCloseTo(1.25);
  });

  it('rests halos in silence and grows them further than the core', () => {
    expect(haloScale(0, 0)).toBe(HALO_REST[0]);
    expect(haloScale(2, Number.NaN)).toBe(HALO_REST[2]);
    expect(haloScale(2, 1) - haloScale(2, 0)).toBeGreaterThan(coreScale(1) - coreScale(0));
    // The outermost ring never leaves the 2× frame budget by much.
    expect(haloScale(2, 1)).toBeLessThanOrEqual(2.4);
  });
});

describe('avatar color', () => {
  it('is deterministic and from the palette', () => {
    for (const id of ['a', 'agent-123', '', 'ünïcode', '0f9e7c1a-2b3c']) {
      expect(avatarColor(id)).toBe(avatarColor(id));
      expect(AVATAR_COLORS).toContain(avatarColor(id));
    }
  });

  it('spreads different ids across colors', () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => avatarColor(`agent-${i}`)));
    expect(seen.size).toBeGreaterThan(3);
  });

  it('takes the first character as the initial', () => {
    expect(avatarInitial('  priya')).toBe('P');
    expect(avatarInitial('')).toBe('?');
    expect(avatarInitial('😀 bot')).toBe('😀');
  });
});

describe('connection pill', () => {
  it('says whether the line is up', () => {
    expect(connectionPill('CONNECTING')?.label).toBe('Connecting…');
    expect(connectionPill('AGENT_SPEAKING')?.tone).toBe('connected');
    expect(connectionPill('RECONNECTING')?.tone).toBe('reconnecting');
    expect(connectionPill('ENDED')).toBeUndefined();
  });
});
