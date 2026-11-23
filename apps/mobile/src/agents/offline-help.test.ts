import type { AgentProtocol } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { OFFLINE_HELP_TITLE, offlineHelpSteps } from './offline-help';

// Typed as a full record so a new kind fails to compile here until it has help.
const PROTOCOLS: Record<AgentProtocol, true> = {
  'cord-connector': true,
  'openai-chat': true,
  'cord-rest': true,
  'cord-native': true,
  'mcp-app': true,
};
const JARGON = /twring-connect|cord-connect|connector|endpoint|terminal|mcp|--server|command/i;

describe('offline help', () => {
  it('tells a computer agent to wake, sign in, then call', () => {
    expect(offlineHelpSteps('cord-connector')).toEqual([
      "Turn on or wake your computer and check it's connected to the internet.",
      'Sign in to your computer. Twring starts again by itself. If it still says offline, restart the computer.',
      'Call again.',
    ]);
  });

  it('points a server agent at its service', () => {
    for (const protocol of ['openai-chat', 'cord-rest', 'cord-native'] as const) {
      expect(offlineHelpSteps(protocol)).toEqual([
        'Check that the service your agent runs on is up and reachable online.',
        'Call again.',
      ]);
    }
  });

  it('sends an AI app back to the app', () => {
    expect(offlineHelpSteps('mcp-app')).toEqual([
      "Open the AI app and check you're signed in.",
      'Ask it to ring or message you.',
    ]);
  });

  it('gives every kind 2 or 3 short, plain steps', () => {
    for (const protocol of Object.keys(PROTOCOLS) as AgentProtocol[]) {
      const steps = offlineHelpSteps(protocol);
      expect(steps.length).toBeGreaterThanOrEqual(2);
      expect(steps.length).toBeLessThanOrEqual(3);
      for (const step of [OFFLINE_HELP_TITLE, ...steps]) {
        expect(step).not.toMatch(JARGON);
        expect(step).not.toContain(String.fromCharCode(0x2014));
      }
    }
  });
});
