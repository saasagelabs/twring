import type { Agent, ThreadMessage, ThreadSummary } from '@twring/contracts';
import { describe, expect, it } from 'vitest';
import {
  agentRowLine,
  dateLabel,
  callCardLine,
  callDuration,
  messageStatus,
  rowSecondLine,
  rowLine,
  rowTime,
  segmentText,
  shouldFold,
  sortChatAgents,
  workingLabel,
  approvalCountdown,
} from './presentation';

const user = (status: 'sent' | 'answered'): Extract<ThreadMessage, { kind: 'user_text' }> => ({
  kind: 'user_text',
  id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  seq: 1,
  rev: 1,
  client_id: '123e4567-e89b-42d3-a456-426614174000',
  text: 'check the logs',
  status,
  created_at: '2026-10-13T10:42:00.000Z',
  updated_at: '2026-10-13T10:42:00.000Z',
});
const call = (
  outcome: 'completed' | 'failed' = 'completed',
): Extract<ThreadMessage, { kind: 'call' }> => ({
  kind: 'call',
  id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  seq: 2,
  rev: 2,
  created_at: '2026-10-13T10:42:00.000Z',
  updated_at: '2026-10-13T10:42:00.000Z',
  call_id: 'cal_aaaaaaaaaaaaaaaaaaaa',
  duration_s: 259,
  outcome,
});
const ring = (
  outcome: 'missed' | 'declined' | 'answered' | 'cancelled',
): Extract<ThreadMessage, { kind: 'ring' }> => ({
  kind: 'ring',
  id: 'msg_bbbbbbbbbbbbbbbbbbbb',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  seq: 3,
  rev: 3,
  created_at: '2026-10-13T10:43:00.000Z',
  updated_at: '2026-10-13T10:43:00.000Z',
  invite_id: `inv_${'a'.repeat(26)}`,
  reason: 'Need your help',
  outcome,
});
describe('chat presentation', () => {
  it('shows approval row state and countdown', () => {
    const approval = { kind: 'approval', status: 'pending' } as ThreadMessage;
    expect(rowLine(approval)).toEqual({ text: 'Needs your OK', tone: 'accent' });
    expect(rowLine({ ...approval, status: 'allowed' } as ThreadMessage)).toEqual({
      text: 'Allowed',
      tone: 'normal',
    });
    expect(rowSecondLine({ ...approval, status: 'expired' } as ThreadMessage)).toBe(
      'Expired: denied',
    );
    expect(
      approvalCountdown('2026-10-13T10:10:00.000Z', Date.parse('2026-10-13T10:00:08.000Z')),
    ).toBe('9:52');
    expect(
      approvalCountdown('2026-10-13T10:10:00.000Z', Date.parse('2026-10-13T10:11:00.000Z')),
    ).toBe('0:00');
  });
  it('formats call durations and every card line', () => {
    expect([5, 259, 3660].map(callDuration)).toEqual(['0:05', '4:19', '61:00']);
    expect(callDuration(7)).toBe('0:07');
    expect(callCardLine(call(), 'Hermes')).toBe('Call · 4:19');
    expect(callCardLine({ ...call(), duration_s: 42, end_reason: 'agent_hangup' }, 'Hermes')).toBe(
      'Call · 0:42 · Hermes hung up',
    );
    expect(callCardLine(call('failed'), 'Hermes')).toBe("Call didn't connect");
    expect(callCardLine(ring('missed'), 'Hermes')).toBe('Missed call · Need your help');
    expect(callCardLine(ring('declined'), 'Hermes')).toBe('Declined');
    expect(callCardLine({ ...ring('declined'), note: 'Busy' }, 'Hermes')).toBe(
      'Declined · you said: Busy',
    );
    expect(callCardLine(ring('answered'), 'Hermes')).toBeUndefined();
    expect(callCardLine(ring('cancelled'), 'Hermes')).toBeUndefined();
  });
  it('uses call and ring row copy with missed tone and skips hidden rings', () => {
    expect(rowSecondLine(call())).toBe('Call · 4:19');
    expect(rowSecondLine(call('failed'))).toBe("Call didn't connect");
    expect(rowSecondLine(ring('missed'))).toBe('Missed call');
    expect(rowSecondLine(ring('declined'))).toBe('Declined');
    expect(rowLine(ring('missed'))).toEqual({ text: 'Missed call', tone: 'danger' });
    expect(rowLine(ring('declined'))).toEqual({ text: 'Declined', tone: 'normal' });
    expect(rowLine(ring('answered'))).toEqual({ text: 'Call', tone: 'normal' });
    expect(rowLine(ring('cancelled'))).toEqual({ text: 'Call cancelled', tone: 'normal' });
    expect(rowLine(call())).toEqual({ text: 'Call · 4:19', tone: 'normal' });
    expect(rowLine(call('failed'))).toEqual({ text: "Call didn't connect", tone: 'normal' });
    expect(rowLine(user('answered'))).toEqual({ text: 'You: check the logs', tone: 'normal' });
    expect(rowSecondLine(ring('missed'))).toBe('Missed call');
  });
  it('uses last message and work state for row copy', () => {
    expect(rowSecondLine({ ...user('answered'), kind: 'notice', code: 'new_session' })).toBe(
      'New conversation',
    );
    expect(rowSecondLine(null)).toBe('Say hello, or call.');
    expect(rowSecondLine(user('answered'))).toBe('You: check the logs');
    expect(rowSecondLine(user('sent'))).toBe('Working…');
  });
  it('shows files when a message has no text', () => {
    const photo = {
      id: 'fil_aaaaaaaaaaaaaaaaaaaa',
      name: 'p.jpg',
      mime_type: 'image/jpeg' as const,
      size_bytes: 3,
    };
    const doc = {
      id: 'fil_bbbbbbbbbbbbbbbbbbbb',
      name: 'report.pdf',
      mime_type: 'application/pdf' as const,
      size_bytes: 3,
    };
    expect(rowSecondLine({ ...user('answered'), text: '', attachments: [photo] })).toBe('Photo');
    expect(rowSecondLine({ ...user('answered'), text: '', attachments: [photo, photo] })).toBe(
      '2 photos',
    );
    expect(rowSecondLine({ ...user('answered'), text: '', attachments: [doc] })).toBe(
      'File: report.pdf',
    );
    expect(rowSecondLine({ ...user('answered'), text: 'caption', attachments: [doc] })).toBe(
      'You: caption',
    );
  });
  it('offers a call, never a chat, when the server has chats off', () => {
    expect(agentRowLine(false)).toBe('Ready to call');
    expect(agentRowLine(true)).toBe('Offline · start it on your computer');
  });
  it('sorts by thread activity, then agent update', () => {
    const a = { id: 'a', name: 'A', updated_at: '2026-10-10T00:00:00Z' } as Agent;
    const b = { id: 'b', name: 'B', updated_at: '2026-10-11T00:00:00Z' } as Agent;
    const threads = [{ agent_id: 'a', last_message_at: '2026-10-12T00:00:00Z' }] as ThreadSummary[];
    expect(sortChatAgents([b, a], threads).map((agent) => agent.id)).toEqual(['a', 'b']);
  });
  it('groups today, yesterday and older dates', () => {
    const now = new Date(2026, 9, 13, 12);
    expect(dateLabel(new Date(2026, 9, 13, 8).toISOString(), now)).toBe('TODAY');
    expect(dateLabel(new Date(2026, 9, 12, 8).toISOString(), now)).toBe('YESTERDAY');
    expect(dateLabel(new Date(2026, 9, 11, 8).toISOString(), now)).toBe('11 OCT');
  });
  it('covers each status', () => {
    expect(
      [
        'sending',
        'queued',
        'sent',
        'working',
        'answered',
        'failed',
        'stopped',
        'interrupted',
        'expired',
      ].map((status) => messageStatus(status as Parameters<typeof messageStatus>[0], 'Hermes')),
    ).toEqual([
      'Sending…',
      'Queued: sends when Hermes is back online',
      'Sent',
      'Working…',
      'Sent',
      "Didn't go through",
      'Stopped',
      'Interrupted',
      'Expired: Hermes stayed offline',
    ]);
    expect(messageStatus('failed', 'Hermes', 'timeout')).toBe(
      "Didn't go through: the request timed out",
    );
    expect(messageStatus('failed', 'Hermes', 'agent_failed')).toBe(
      "Didn't go through: the agent could not reply",
    );
  });
  it('segments links, fences, bold, and leaves HTML as text', () => {
    expect(segmentText('Hi **bold** https://example.com <b>x</b>\n```ts\nlet x = 1\n```')).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'bold', value: 'bold' },
      { kind: 'text', value: ' ' },
      { kind: 'link', value: 'https://example.com' },
      { kind: 'text', value: ' <b>x</b>\n' },
      { kind: 'code', value: 'let x = 1\n' },
    ]);
  });
  it('folds after forty lines', () => {
    expect(shouldFold(Array(40).fill('x').join('\n'))).toBe(false);
    expect(shouldFold(Array(41).fill('x').join('\n'))).toBe(true);
  });
});

describe('workingLabel (device test 2026-10-13)', () => {
  it('drops the generic keep-alive label and keeps real activity', () => {
    expect(workingLabel('Working…')).toBeUndefined();
    expect(workingLabel('working')).toBeUndefined();
    expect(workingLabel(undefined)).toBeUndefined();
    expect(workingLabel('Searching the web')).toBe('Searching the web');
  });
});

describe('markdown links (device test 2026-10-13)', () => {
  it('shows the label and keeps the URL for the link sheet', () => {
    expect(segmentText('See [Ooty – Wikipedia](https://en.wikipedia.org/wiki/Ooty).')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'link', value: 'https://en.wikipedia.org/wiki/Ooty', label: 'Ooty – Wikipedia' },
      { kind: 'text', value: '.' },
    ]);
    expect(segmentText('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', value: '[x](javascript:alert(1))' },
    ]);
  });
});

describe('rowTime', () => {
  const now = new Date(2026, 10, 12, 15, 0);
  const at = (days: number, hour = 9) => new Date(2026, 10, 12 - days, hour, 5).toISOString();

  it('shows the time today, then Yesterday, then the weekday within a week', () => {
    expect(rowTime(at(0), now)).toBe('09:05');
    expect(rowTime(at(1), now)).toBe('Yesterday');
    expect(rowTime(at(3), now)).toBe('Mon');
  });

  it('writes older dates the way Recents and agent pages do', () => {
    expect(rowTime(at(8), now)).toBe('Nov 4');
    expect(rowTime(new Date(2025, 9, 29, 9).toISOString(), now)).toBe('Oct 29, 2025');
  });
});
