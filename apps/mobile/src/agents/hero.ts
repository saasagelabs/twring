import type { Agent } from '@twring/contracts';

import { callRefusal } from './labels';
import type { HistoryEntry } from '../ring/protocol';

/** Prefer the latest called, currently callable agent, then list order. */
export function pickHero(
  agents: Agent[],
  history: HistoryEntry[],
): { hero: Agent | undefined; rest: Agent[] } {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const recent = [...history].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
  );
  let hero = recent
    .map((item) => byId.get(item.agent_id))
    .find((agent) => agent !== undefined && callRefusal(agent) === undefined);
  hero ??= agents.find((agent) => callRefusal(agent) === undefined) ?? agents[0];
  return { hero, rest: agents.filter((agent) => agent.id !== hero?.id) };
}
