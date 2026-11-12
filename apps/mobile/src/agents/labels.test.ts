import type { CallHistoryItem, ConnectionTestSummary } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  agentStatusFor,
  callAgentLocation,
  computerOffline,
  agentStatusLabel,
  checkLabel,
  formatSeconds,
  formatWhen,
  historyRow,
  orderedChecks,
  testResultCopy,
} from './labels';

function summary(
  ok: boolean,
  checks: ConnectionTestSummary['checks'],
  message = '',
): ConnectionTestSummary {
  return { ok, checks, message, tested_at: '2026-09-27T10:00:00.000Z' };
}

describe('agent status labels', () => {
  it('uses words, not just color', () => {
    expect(agentStatusLabel('ready')).toEqual({ label: 'Ready', tone: 'success' });
    expect(agentStatusLabel('failing')).toEqual({ label: 'Needs attention', tone: 'warning' });
    expect(agentStatusLabel('untested')).toEqual({ label: 'Not tested', tone: 'neutral' });
  });
});

describe('call agent location', () => {
  it('labels an agent on a computer', () => {
    expect(callAgentLocation({ protocol: 'cord-connector' })).toBe('On your computer');
  });

  it('labels a web agent', () => {
    expect(callAgentLocation({ protocol: 'cord-rest' })).toBe('Online');
    expect(callAgentLocation({ protocol: 'cord-native' })).toBe('Online');
  });

  it('omits a location for the development test line', () => {
    expect(callAgentLocation(undefined)).toBeUndefined();
  });
});

describe('connection test copy', () => {
  it('orders only the checks performed', () => {
    const checks = orderedChecks([
      { name: 'streaming', status: 'passed' },
      { name: 'endpoint', status: 'passed' },
    ]);
    expect(checks.map((c) => c.name)).toEqual(['endpoint', 'streaming']);
    expect(checks.map(checkLabel)).toEqual(['Address reached', 'Reply streams']);
  });

  it('says ready on success', () => {
    expect(testResultCopy(summary(true, [{ name: 'endpoint', status: 'passed' }]))).toBe(
      'Your agent is ready to call.',
    );
  });

  it('explains the first failed check', () => {
    const copy = testResultCopy(
      summary(false, [
        { name: 'endpoint', status: 'passed' },
        { name: 'authentication', status: 'failed' },
      ]),
    );
    expect(copy).toBe(
      "Twring reached your agent, but it didn't accept the key. Check the key and try again.",
    );
    expect(testResultCopy(summary(false, [{ name: 'endpoint', status: 'failed' }]))).toContain(
      "couldn't reach that address",
    );
    expect(testResultCopy(summary(false, [{ name: 'streaming', status: 'failed' }]))).toContain(
      "didn't stream",
    );
  });

  it("falls back to Twring's own message when no check failed", () => {
    expect(testResultCopy(summary(false, [], 'The test timed out.'))).toBe('The test timed out.');
    expect(testResultCopy(summary(false, []))).toContain("didn't pass");
  });
});

describe('history formatting', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0);

  it('formats relative times', () => {
    expect(formatWhen(new Date(2026, 8, 27, 14, 59, 30).toISOString(), now)).toBe('Just now');
    expect(formatWhen(new Date(2026, 8, 27, 14, 52).toISOString(), now)).toBe('8 min ago');
    expect(formatWhen(new Date(2026, 8, 27, 9, 5).toISOString(), now)).toBe('Today 9:05');
    expect(formatWhen(new Date(2026, 8, 26, 21, 30).toISOString(), now)).toBe('Yesterday 21:30');
    expect(formatWhen(new Date(2026, 8, 21, 8, 0).toISOString(), now)).toBe('Sep 21');
    expect(formatWhen(new Date(2025, 0, 3).toISOString(), now)).toBe('Jan 3, 2025');
    expect(formatWhen('not a date', now)).toBe('');
  });

  it('formats durations', () => {
    expect(formatSeconds(0)).toBe('0:00');
    expect(formatSeconds(125)).toBe('2:05');
    expect(formatSeconds(3723)).toBe('1:02:03');
  });

  it('builds a row with a spoken label and no transcript', () => {
    const item: CallHistoryItem = {
      call_id: 'call_abcdefghij0123456789',
      agent_id: 'agt_abcdefghij0123456789',
      agent_name: 'Operator',
      started_at: new Date(2026, 8, 27, 14, 52).toISOString(),
      duration_s: 61,
      outcome: 'failed',
      end_reason: 'agent_unavailable',
    };
    expect(historyRow(item, now)).toEqual({
      key: item.call_id,
      agentName: 'Operator',
      when: '8 min ago',
      duration: '1:01',
      outcome: "Didn't complete",
      failed: true,
      accessibilityLabel: "Operator, 8 min ago, 1 minute 1 second, Didn't complete",
    });
  });
});

describe('agentStatusFor (agents on my computer)', () => {
  it('says the computer was removed before anything else', () => {
    expect(
      agentStatusFor({ status: 'ready', connector_online: false, connector_removed: true }),
    ).toEqual({ label: 'Computer removed. Pair it again.', tone: 'warning' });
    expect(agentStatusFor({ status: 'ready', connector_online: false })).toEqual({
      label: 'Computer offline',
      tone: 'warning',
    });
  });

  it('says where the agent runs when its computer is connected', () => {
    expect(agentStatusFor({ status: 'untested', connector_online: true })).toEqual({
      label: 'On your computer · Online',
      tone: 'success',
    });
    expect(computerOffline({ connector_online: true })).toBe(false);
    expect(computerOffline({ connector_online: false })).toBe(true);
    // Agents at a web address carry no computer status.
    expect(computerOffline({})).toBe(false);
  });
});
