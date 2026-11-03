import type {
  Agent,
  AgentProtocol,
  AgentStatus,
  CallHistoryItem,
  ConnectionCheck,
  ConnectionTestSummary,
} from '@twring/contracts';

export type Tone = 'success' | 'warning' | 'neutral' | 'danger';

/** The words carry the meaning; the tone only reinforces it (UX_UI_SPEC §21: non-color cues). */
export function agentStatusLabel(status: AgentStatus): { label: string; tone: Tone } {
  switch (status) {
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'failing':
      return { label: 'Needs attention', tone: 'warning' };
    case 'untested':
      return { label: 'Not tested', tone: 'neutral' };
  }
}

/**
 * The status to show for a saved agent. An agent on the user's computer (ADR-023) reads as offline
 * while that computer isn't connected, whatever its last test said.
 */
export function agentStatusFor(
  agent: Pick<Agent, 'status' | 'connector_online' | 'connector_removed'> &
    Partial<Pick<Agent, 'protocol'>>,
): {
  label: string;
  tone: Tone;
} {
  if (agent.protocol === 'mcp-app') return { label: 'AI app', tone: 'neutral' };
  if (agent.connector_removed === true) {
    return { label: 'Computer removed. Pair it again.', tone: 'warning' };
  }
  if (agent.connector_online === false) return { label: 'Computer offline', tone: 'warning' };
  if (agent.connector_online === true)
    return { label: 'On your computer · Online', tone: 'success' };
  return agentStatusLabel(agent.status);
}

/** Stable location copy for an active call; the development test line has no saved agent. */
export function callAgentLocation(agent: Pick<Agent, 'protocol'> | undefined): string | undefined {
  if (agent === undefined) return undefined;
  return agent.protocol === 'cord-connector' ? 'On your computer' : 'Online';
}

/** True when calling would fail at once: the agent's computer is not connected (ADR-023). */
export function computerOffline(agent: Pick<Agent, 'connector_online'>): boolean {
  return agent.connector_online === false;
}

export const COMPUTER_OFFLINE_MESSAGE =
  "Your computer is offline. Make sure it's on and online, then call again.";
export const COMPUTER_REMOVED_MESSAGE = 'This computer is no longer paired. Pair it again.';

/**
 * Why a call to this agent would fail at once, said before calling; undefined when it may go
 * ahead (including while the computer's status is unknown). A removed computer also reads as
 * offline, so it is checked first: starting cord-connect would not help.
 */
export function callRefusal(
  agent: Pick<Agent, 'connector_online' | 'connector_removed'>,
): { title: string; message: string } | undefined {
  if (agent.connector_removed === true) {
    return { title: 'Computer removed', message: COMPUTER_REMOVED_MESSAGE };
  }
  if (computerOffline(agent)) {
    return { title: 'Computer offline', message: COMPUTER_OFFLINE_MESSAGE };
  }
  return undefined;
}

export function protocolLabel(protocol: AgentProtocol): string {
  switch (protocol) {
    case 'cord-native':
      return 'Twring Native';
    case 'cord-rest':
      return 'API endpoint';
    case 'openai-chat':
      return 'Any OpenAI-compatible agent';
    case 'cord-connector':
      return 'On my computer';
    case 'mcp-app':
      return 'AI app';
  }
}

/** Connection-test lines in the order the test runs them (UX_UI_SPEC §7). */
const CHECK_ORDER: readonly ConnectionCheck['name'][] = [
  'endpoint',
  'authentication',
  'response',
  'streaming',
];

export function checkLabel(check: ConnectionCheck): string {
  const passed = check.status === 'passed';
  switch (check.name) {
    case 'endpoint':
      return passed ? 'Endpoint reached' : "Endpoint couldn't be reached";
    case 'authentication':
      return passed ? 'Authentication accepted' : 'Authentication rejected';
    case 'response':
      return passed ? 'Agent responded' : "Agent didn't respond";
    case 'streaming':
      return passed ? 'Streaming works' : "Streaming didn't work";
  }
}

/** Only the checks the server actually performed, in test order. */
export function orderedChecks(checks: readonly ConnectionCheck[]): ConnectionCheck[] {
  return [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.name) - CHECK_ORDER.indexOf(b.name));
}

/** The one-line verdict for a finished connection test. Never echoes the saved key. */
export function testResultCopy(result: ConnectionTestSummary): string {
  if (result.ok) return 'Your agent is ready to call.';
  const failed = orderedChecks(result.checks).find((c) => c.status === 'failed');
  switch (failed?.name) {
    case 'endpoint':
      return "Twring couldn't reach the endpoint. Check the address and that your agent is running, then try again.";
    case 'authentication':
      return 'Twring reached the endpoint, but authentication was rejected. Check the API key and try again.';
    case 'response':
      return "Twring connected, but the agent didn't answer the test message. Check that your agent is running, then try again.";
    case 'streaming':
      return "The agent answered, but its reply didn't stream. Check that the endpoint streams replies, then try again.";
    case undefined:
      // Twring's own safe message (the contract never carries agent or secret text).
      return result.message.trim() !== ''
        ? result.message
        : "The connection test didn't pass. Check the details and try again.";
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function clock(date: Date): string {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "Just now", "8 min ago", "Today 14:05", "Yesterday 09:30", "Sep 21", "Sep 21, 2025". */
export function formatWhen(iso: string, now: Date): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  if (Number.isNaN(then.getTime())) return '';
  if (diffMs >= 0 && diffMs < 60_000) return 'Just now';
  if (diffMs >= 0 && diffMs < 60 * 60_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  if (sameDay(then, now)) return `Today ${clock(then)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(then, yesterday)) return `Yesterday ${clock(then)}`;
  const day = `${MONTHS[then.getMonth()]} ${then.getDate()}`;
  return then.getFullYear() === now.getFullYear() ? day : `${day}, ${then.getFullYear()}`;
}

/** Whole seconds as m:ss or h:mm:ss. */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Spoken-friendly duration for screen readers: "2 minutes 5 seconds". */
export function spokenDuration(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const minutes = Math.floor(s / 60);
  const seconds = s % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} second${seconds === 1 ? '' : 's'}`);
  return parts.join(' ');
}

export interface HistoryRow {
  key: string;
  agentName: string;
  when: string;
  duration: string;
  outcome: string;
  failed: boolean;
  accessibilityLabel: string;
}

/** One call history line (UX_UI_SPEC §17). No transcript exists, so none is previewed. */
export function historyRow(item: CallHistoryItem, now: Date): HistoryRow {
  const failed = item.outcome === 'failed';
  const when = formatWhen(item.started_at, now);
  const outcome = failed ? "Didn't complete" : 'Ended';
  return {
    key: item.call_id,
    agentName: item.agent_name,
    when,
    duration: formatSeconds(item.duration_s),
    outcome,
    failed,
    accessibilityLabel: `${item.agent_name}, ${when}, ${spokenDuration(item.duration_s)}, ${outcome}`,
  };
}
