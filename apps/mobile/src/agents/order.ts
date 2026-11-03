import type { Agent, ThreadSummary } from '@twring/contracts';

/** Computer presence is known for connector agents; server agents do not report presence. */
export function agentStatusLine(
  agent: Pick<Agent, 'protocol' | 'connector_online' | 'connector_removed'>,
): string {
  if (agent.protocol === 'mcp-app') return 'AI app';
  if (agent.protocol !== 'cord-connector') return 'Server agent';
  return agent.connector_online === true && agent.connector_removed !== true ? 'Online' : 'Offline';
}

export function orderAgents(agents: Agent[], threads: ThreadSummary[]): Agent[] {
  const activity = new Map(threads.map((thread) => [thread.agent_id, thread.last_message_at]));
  return [...agents].sort((a, b) => {
    const online =
      Number(agentStatusLine(b) === 'Online') - Number(agentStatusLine(a) === 'Online');
    if (online) return online;
    const recent =
      (Date.parse(activity.get(b.id) ?? '') || 0) - (Date.parse(activity.get(a.id) ?? '') || 0);
    return recent || a.name.localeCompare(b.name);
  });
}

export function totalUnread(threads: ThreadSummary[]): number {
  return threads.reduce((total, thread) => total + thread.unread, 0);
}
