import type { Agent, ThreadSummary } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { homeRow } from './home-rows';

const now = new Date('2026-11-19T12:00:00Z');
const agent = (patch: Partial<Agent> = {}): Agent =>
  ({
    id: 'a',
    name: 'Ada',
    protocol: 'cord-connector',
    connector_online: true,
    updated_at: '2026-11-18T10:00:00Z',
    ...patch,
  }) as Agent;
const thread = (patch: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    agent_id: 'a',
    last_message_at: '2026-11-19T09:00:00Z',
    unread: 2,
    last_message: { kind: 'agent_text', text: 'Done.' },
    ...patch,
  }) as ThreadSummary;
const none = new Set<string>();

describe('homeRow', () => {
  it('shows the chat preview with the unread count', () => {
    const row = homeRow(agent(), thread(), none, false, now);
    expect(row).toMatchObject({ line: 'Done.', lineTone: 'secondary', unread: 2, call: 'enabled' });
    expect(row.accessibilityLabel).toContain('Ada, online, 2 unread, Done.');
  });

  it('says what a tap does when chats are off', () => {
    expect(homeRow(agent(), thread(), none, true, now).line).toBe('Ready to call');
    expect(homeRow(agent({ connector_online: false }), undefined, none, true, now).line).toBe(
      'Offline · check your computer is on',
    );
  });

  it('greys the call button for an offline or removed agent', () => {
    expect(homeRow(agent({ connector_online: false }), thread(), none, false, now).call).toBe(
      'disabled',
    );
    expect(homeRow(agent({ connector_removed: true }), thread(), none, false, now).call).toBe(
      'disabled',
    );
  });

  it('offers no call for an AI app', () => {
    const row = homeRow(agent({ protocol: 'mcp-app' }), thread(), none, false, now);
    expect(row.call).toBe('none');
    expect(row.accessibilityLabel).toContain('AI app');
  });

  it('puts an unseen missed call over the preview in danger', () => {
    const row = homeRow(agent(), thread(), new Set(['a']), false, now);
    expect(row).toMatchObject({ line: 'Missed call', lineTone: 'danger', missed: true });
    expect(homeRow(agent(), thread(), new Set(['a']), true, now).line).toBe('Missed call');
  });
});
