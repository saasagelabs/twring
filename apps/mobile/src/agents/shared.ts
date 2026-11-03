import type { Agent } from '@twring/contracts';

/** Shown on a shared agent's screen (a self-hosted server's agent that more than one person calls). */
export const SHARED_AGENT_NOTE =
  'Everyone on this server can call this agent. Your chats are your own; what the agent remembers is shared.';

/** Shown instead of a settings screen the person may not change. */
export const VIEW_ONLY_AGENT_NOTE = 'Only the person who set up this agent can change it.';

/** A missing `can_edit` means yes; `false` is a shared agent someone else owns. */
export function canEditAgent(agent: Pick<Agent, 'can_edit'>): boolean {
  return agent.can_edit !== false;
}
