import type { Agent, ThreadMessage, ThreadSummary, UserMessageStatus } from '@twring/contracts';
import { filesPreview } from './files';

export function callDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function callCardLine(
  message: Extract<ThreadMessage, { kind: 'call' | 'ring' }>,
  name: string,
): string | undefined {
  if (message.kind === 'call') {
    if (message.outcome === 'failed') return "Call didn't connect";
    const line = `Call · ${callDuration(message.duration_s)}`;
    return message.end_reason === 'agent_hangup' ? `${line} · ${name} hung up` : line;
  }
  if (message.outcome === 'missed') return `Missed call · ${message.reason}`;
  if (message.outcome === 'declined')
    return message.note ? `Declined · you said: ${message.note}` : 'Declined';
  return undefined;
}

/** The Chats row's second line; a missed call is drawn in `danger`. */
export function rowLine(message: ThreadMessage | null | undefined): {
  text: string;
  tone: 'normal' | 'danger' | 'accent';
} {
  if (message?.kind === 'call')
    return {
      text:
        message.outcome === 'failed'
          ? "Call didn't connect"
          : `Call · ${callDuration(message.duration_s)}`,
      tone: 'normal',
    };
  if (message?.kind === 'ring') {
    const text = {
      answered: 'Call',
      declined: 'Declined',
      missed: 'Missed call',
      cancelled: 'Call cancelled',
    }[message.outcome];
    return { text, tone: message.outcome === 'missed' ? 'danger' : 'normal' };
  }
  return {
    text: rowSecondLine(message),
    tone: message?.kind === 'approval' && message.status === 'pending' ? 'accent' : 'normal',
  };
}

export function rowSecondLine(message: ThreadMessage | null | undefined): string {
  if (!message) return 'Say hello, or call.';
  if (message.kind === 'user_text') {
    if (!message.text && message.attachments?.length) return filesPreview(message.attachments);
    if (message.status === 'sent' || message.status === 'working') return 'Working…';
    return `You: ${message.text}`;
  }
  if (message.kind === 'agent_text')
    return message.text || (message.attachments?.length ? filesPreview(message.attachments) : '');
  if (message.kind === 'approval')
    return {
      pending: 'Needs your OK',
      allowed: 'Allowed',
      denied: 'Denied',
      expired: 'Expired: denied',
    }[message.status];
  if (message.kind === 'call' || message.kind === 'ring') return rowLine(message).text;
  if (message.kind === 'notice' && message.code === 'new_session') return 'New conversation';
  return 'Say hello, or call.';
}

/** A Home row's second line when the server has chats off: what a tap will do. */
export function agentRowLine(offline: boolean): string {
  return offline ? 'Offline · start it on your computer' : 'Ready to call';
}

export function sortChatAgents(agents: Agent[], threads: ThreadSummary[]): Agent[] {
  const summaries = new Map(threads.map((thread) => [thread.agent_id, thread]));
  return [...agents].sort((a, b) => {
    const at = Date.parse(summaries.get(a.id)?.last_message_at ?? a.updated_at);
    const bt = Date.parse(summaries.get(b.id)?.last_message_at ?? b.updated_at);
    return bt - at || a.name.localeCompare(b.name);
  });
}

export function dateLabel(date: string, now: Date = new Date()): string {
  const day = new Date(date);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const value = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (value === start) return 'TODAY';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (value === yesterday) return 'YESTERDAY';
  return `${day.getDate()} ${day.toLocaleDateString('en', { month: 'short' }).toUpperCase()}`;
}

export function rowTime(date: string, now: Date = new Date()): string {
  const day = new Date(date);
  if (dateLabel(date, now) === 'TODAY')
    return day.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (dateLabel(date, now) === 'YESTERDAY') return 'Yesterday';
  if (now.getTime() - day.getTime() < 7 * 86400000)
    return day.toLocaleDateString('en', { weekday: 'short' });
  return `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}`;
}

export function approvalCountdown(expiresAt: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function messageStatus(
  status: UserMessageStatus | 'sending',
  name: string,
  errorCode?: string,
): string {
  switch (status) {
    case 'sending':
      return 'Sending…';
    case 'queued':
      return `Queued: sends when ${name} is back online`;
    case 'sent':
      return 'Sent';
    case 'working':
      return 'Working…';
    case 'answered':
      return 'Sent';
    case 'failed':
      return errorCode ? `Didn't go through: ${errorCopy(errorCode)}` : "Didn't go through";
    case 'stopped':
      return 'Stopped';
    case 'interrupted':
      return 'Interrupted';
    case 'expired':
      return `Expired: ${name} stayed offline`;
  }
}

function errorCopy(code: string): string {
  const known: Record<string, string> = {
    agent_offline: 'agent is offline',
    timeout: 'the request timed out',
    rate_limited: 'too many messages',
    agent_error: 'the agent could not reply',
    agent_failed: 'the agent could not reply',
  };
  return known[code] ?? 'please try again later';
}

export type TextSegment =
  | { kind: 'text' | 'bold' | 'code'; value: string }
  /** `value` is the URL; `label` is the visible text of a markdown `[label](url)` link. */
  | { kind: 'link'; value: string; label?: string };
export function segmentText(input: string): TextSegment[] {
  const result: TextSegment[] = [];
  // Numbered groups, not named ones: Hermes leaves `match.groups` empty (device test 2026-10-13).
  // 1 code · 2 link label · 3 link URL · 4 bold
  const pattern =
    /```(?:[^\n]*\n)?([\s\S]*?)```|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>]+|\*\*([^*\n]+)\*\*/g;
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0;
    const [, code, label, href, bold] = match;
    if (index > cursor) result.push({ kind: 'text', value: input.slice(cursor, index) });
    if (code !== undefined) result.push({ kind: 'code', value: code });
    else if (bold !== undefined) result.push({ kind: 'bold', value: bold });
    else if (href !== undefined && label !== undefined)
      result.push({ kind: 'link', value: href, label });
    else result.push({ kind: 'link', value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < input.length) result.push({ kind: 'text', value: input.slice(cursor) });
  return result;
}

export function shouldFold(text: string): boolean {
  return text.split('\n').length > 40;
}

/** The working row's activity, or undefined for the connector's generic "Working…" keep-alive. */
export function workingLabel(activity: string | undefined): string | undefined {
  return activity && !/^working\W*$/i.test(activity.trim()) ? activity : undefined;
}
