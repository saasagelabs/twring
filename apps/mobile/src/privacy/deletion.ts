import type { DeleteMyDataResponse } from '@twring/contracts';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/** What "Delete my data" removed, in plain words for the Settings screen. */
export function deletionSummary(result: DeleteMyDataResponse): string {
  const { agents, credentials, call_history: calls } = result.deleted;
  const parts = [
    agents > 0 && count(agents, 'agent', 'agents'),
    credentials > 0 && count(credentials, 'saved key', 'saved keys'),
    calls > 0 && count(calls, 'call summary', 'call summaries'),
  ].filter((part): part is string => part !== false);
  const removed =
    parts.length === 0
      ? 'Twring had nothing stored for you, so there was nothing to delete.'
      : `Deleted ${list(parts)}. Twring no longer keeps any of your data.`;
  if (result.live_calls_ended === 0) return removed;
  const ended =
    result.live_calls_ended === 1
      ? 'A call that was still running was ended.'
      : `${result.live_calls_ended} calls that were still running were ended.`;
  return `${removed} ${ended}`;
}
