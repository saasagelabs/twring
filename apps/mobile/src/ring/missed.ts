import type { HistoryEntry, MissedInviteHistoryItem } from './protocol';

/** Most missed calls the Chats screen lists; the rest are in Recents. */
export const HOME_MISSED_LIMIT = 3;

const AGENT_ID = /^agt_[a-z0-9]{20}$/;

function isMissed(entry: HistoryEntry): entry is MissedInviteHistoryItem {
  return entry.kind === 'missed_invite';
}

/**
 * Missed rings started after the owner last looked (`lastSeen`, epoch ms; undefined means never),
 * newest first, at most `HOME_MISSED_LIMIT`.
 */
export function unseenMissed(
  entries: readonly HistoryEntry[],
  lastSeen: number | undefined,
): MissedInviteHistoryItem[] {
  return entries
    .filter(isMissed)
    .map((entry) => ({ entry, at: Date.parse(entry.started_at) }))
    .filter(({ at }) => Number.isFinite(at) && (lastSeen === undefined || at > lastSeen))
    .sort((a, b) => b.at - a.at)
    .slice(0, HOME_MISSED_LIMIT)
    .map(({ entry }) => entry);
}

/** Reads a stored "last seen" value; anything unreadable counts as never seen. */
export function parseLastSeen(stored: string | null | undefined): number | undefined {
  if (stored === null || stored === undefined) return undefined;
  const value = Number(stored);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The value to store when the owner has seen everything up to `now`. */
export function markSeenValue(now: Date): string {
  return String(now.getTime());
}

export interface CallBackLink {
  agentId: string;
  name?: string;
}

/**
 * The "Call back" action of a missed-call notification opens `/history?call_back=<agent>&name=…`.
 * Undefined unless `call_back` is a well-formed agent id.
 */
export function parseCallBack(params: {
  call_back?: string | string[];
  name?: string | string[];
}): CallBackLink | undefined {
  const agentId = params.call_back;
  if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return undefined;
  const name = typeof params.name === 'string' ? params.name.trim().slice(0, 80) : '';
  return name === '' ? { agentId } : { agentId, name };
}
