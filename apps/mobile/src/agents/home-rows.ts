import type { Agent, ThreadSummary } from '@twring/contracts';

import { isAiApp } from './ai-app';
import { agentRowLine, rowLine, rowTime } from '../threads/presentation';

export interface HomeRow {
  line: string;
  lineTone: 'secondary' | 'accent' | 'danger' | 'working';
  time: string;
  unread: number;
  offline: boolean;
  aiApp: boolean;
  /** What the right column shows: a call button, a greyed one, or nothing. */
  call: 'enabled' | 'disabled' | 'none';
  /** Whether the agent has a missed ring the owner has not seen. */
  missed: boolean;
  accessibilityLabel: string;
}

/** One Home row: the line under the name, its tone, the badge and the call column. */
export function homeRow(
  agent: Agent,
  thread: ThreadSummary | undefined,
  unseenMissedAgents: ReadonlySet<string>,
  chatsOff: boolean,
  now: Date = new Date(),
  /** A private chat's opened last-message preview, when the phone has one. */
  opened?: string,
): HomeRow {
  const offline = agent.connector_online === false || agent.connector_removed === true;
  const aiApp = isAiApp(agent);
  const missed = unseenMissedAgents.has(agent.id);
  let line: string;
  let lineTone: HomeRow['lineTone'];
  if (missed) {
    line = 'Missed call';
    lineTone = 'danger';
  } else if (chatsOff) {
    line = agentRowLine(offline);
    lineTone = 'secondary';
  } else {
    const preview = rowLine(thread?.last_message, opened);
    line = preview.text;
    lineTone =
      line === 'Working…' ? 'working' : preview.tone === 'normal' ? 'secondary' : preview.tone;
  }
  const time = rowTime(thread?.last_message_at ?? agent.updated_at, now);
  const unread = thread?.unread ?? 0;
  return {
    line,
    lineTone,
    time,
    unread,
    offline,
    aiApp,
    call: aiApp ? 'none' : offline ? 'disabled' : 'enabled',
    missed,
    accessibilityLabel: `${agent.name}, ${aiApp ? 'AI app' : offline ? 'offline' : 'online'}, ${unread} unread, ${line}, ${time}`,
  };
}
