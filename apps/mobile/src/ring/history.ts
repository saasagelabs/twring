import { formatWhen, historyRow, type HistoryRow } from '../agents/labels';

import type { HistoryEntry, MissedInviteHistoryItem } from './protocol';

/** How much of the agent's reason a missed-call line shows. */
export const REASON_PREVIEW = 48;

export interface MissedCallRow {
  kind: 'missed';
  key: string;
  agentId: string;
  agentName: string;
  /** "Missed call · Claude: Deploy is blocked…" */
  line: string;
  when: string;
  accessibilityLabel: string;
}

export type HistoryListRow = ({ kind: 'call' } & HistoryRow) | MissedCallRow;

function preview(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text.length <= REASON_PREVIEW) return text;
  // Whole characters only: slicing UTF-16 units could leave half an emoji before the ellipsis.
  let cut = '';
  for (const char of text) {
    if (cut.length + char.length > REASON_PREVIEW) break;
    cut += char;
  }
  return `${cut.trimEnd()}…`;
}

export function missedCallRow(item: MissedInviteHistoryItem, now: Date): MissedCallRow {
  const when = formatWhen(item.started_at, now);
  const fullReason = (item.reason ?? '').trim();
  const reason = preview(fullReason);
  const agentName = item.agent_name.trim() || 'Your agent';
  const line =
    reason === '' ? `Missed call · ${agentName}` : `Missed call · ${agentName}: ${reason}`;
  return {
    kind: 'missed',
    key: `invite:${item.call_id}`,
    agentId: item.agent_id,
    agentName,
    line,
    when,
    accessibilityLabel: `Missed call from ${agentName}, ${when}${
      fullReason === '' ? '' : `. ${fullReason}`
    }`,
  };
}

/** One row per history entry: calls as before, rings nobody answered as missed calls. */
export function historyListRow(entry: HistoryEntry, now: Date): HistoryListRow {
  if (entry.kind === 'missed_invite')
    return missedCallRow({ ...entry, kind: 'missed_invite' }, now);
  return { kind: 'call', ...historyRow(entry, now) };
}

export type DayGroup = 'TODAY' | 'YESTERDAY' | 'EARLIER';
export const DAY_GROUPS: readonly DayGroup[] = ['TODAY', 'YESTERDAY', 'EARLIER'];

/** Bucket by the phone's calendar day, including across month and year boundaries. */
export function groupHistory(
  entries: readonly HistoryEntry[],
  now: Date,
): Record<DayGroup, HistoryEntry[]> {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const groups: Record<DayGroup, HistoryEntry[]> = { TODAY: [], YESTERDAY: [], EARLIER: [] };
  for (const entry of entries) {
    const date = new Date(entry.started_at);
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const group =
      day.getTime() === today.getTime()
        ? 'TODAY'
        : day.getTime() === yesterday.getTime()
          ? 'YESTERDAY'
          : 'EARLIER';
    groups[group].push(entry);
  }
  return groups;
}

/** Missed rings are visible entries, but they are not completed calls or call time. */
export function historySummary(entries: readonly HistoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const calls = entries.filter((entry) => entry.kind !== 'missed_invite');
  const seconds = calls.reduce((total, entry) => total + entry.duration_s, 0);
  return `${calls.length} ${calls.length === 1 ? 'call' : 'calls'} · ${(seconds / 3600).toFixed(1)} hours`;
}
