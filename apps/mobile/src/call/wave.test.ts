import { describe, expect, it } from 'vitest';

import { callLook, waveIntensity } from './wave';

describe('waveIntensity', () => {
  it('starts at idle, grows by the specified curve, and caps at one', () => {
    expect(waveIntensity(0)).toBe(0.18);
    expect(waveIntensity(0.25)).toBeCloseTo(0.18 + 0.82 * 0.8);
    expect(waveIntensity(1)).toBe(1);
    expect(waveIntensity(100)).toBe(1);
    expect(waveIntensity(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('treats invalid and negative levels as idle', () => {
    expect(waveIntensity(-1)).toBe(0.18);
    expect(waveIntensity(Number.NaN)).toBe(0.18);
    expect(waveIntensity(Number.NEGATIVE_INFINITY)).toBe(0.18);
  });
});

describe('callLook', () => {
  it.each([
    ['PREPARING', 'none', 'connecting', 'neutral', false, 'live', 'live'],
    ['CONNECTING', 'none', 'connecting', 'neutral', false, 'live', 'live'],
    ['LISTENING', 'none', 'idle', 'you', false, 'live', 'live'],
    ['USER_SPEAKING', 'you', 'you', 'you', true, 'live', 'live'],
    ['AGENT_WORKING', 'none', 'working', 'agent', false, 'live', 'live'],
    ['AGENT_SPEAKING', 'agent', 'agent', 'agent', true, 'live', 'live'],
    ['RECONNECTING', 'none', 'reconnecting', 'warning', true, 'frozen', 'frozen'],
    ['ENDING', 'none', 'idle', 'neutral', false, 'flat', 'flat'],
    ['ENDED', 'none', 'idle', 'neutral', false, 'flat', 'flat'],
    ['FAILED', 'none', 'idle', 'neutral', false, 'flat', 'flat'],
    ['IDLE', 'none', 'idle', 'neutral', false, 'flat', 'flat'],
  ] as const)('maps %s', (status, who, orb, tone, active, agentWave, youWave) => {
    expect(callLook(status, false, false)).toEqual({
      who,
      orb,
      pill: { tone, active },
      agentWave,
      youWave,
    });
  });

  it('applies mute to the caller without changing the agent or reconnect warning', () => {
    expect(callLook('USER_SPEAKING', true, false)).toEqual({
      who: 'none',
      orb: 'idle',
      pill: { tone: 'muted', active: false },
      agentWave: 'live',
      youWave: 'flat',
    });
    expect(callLook('AGENT_SPEAKING', true, false)).toEqual({
      who: 'agent',
      orb: 'agent',
      pill: { tone: 'muted', active: false },
      agentWave: 'live',
      youWave: 'flat',
    });
    expect(callLook('RECONNECTING', true, true)).toEqual({
      who: 'none',
      orb: 'reconnecting',
      pill: { tone: 'warning', active: true },
      agentWave: 'frozen',
      youWave: 'flat',
    });
  });

  it.each([
    'PREPARING',
    'CONNECTING',
    'LISTENING',
    'AGENT_WORKING',
    'ENDING',
    'ENDED',
    'FAILED',
    'IDLE',
  ] as const)('keeps the %s caller wave flat and pill muted', (status) => {
    const look = callLook(status, true, true);
    expect(look.youWave).toBe('flat');
    expect(look.pill).toEqual({ tone: 'muted', active: false });
    expect(look.who).toBe('none');
  });
});
