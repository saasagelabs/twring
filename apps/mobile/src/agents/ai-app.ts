import { callableOnComputer, type Agent } from '@twring/contracts';

export function isAiApp(agent: Pick<Agent, 'protocol'> | undefined): boolean {
  return agent?.protocol === 'mcp-app';
}

export function canCall(agent: Pick<Agent, 'protocol'> | undefined): boolean {
  return agent !== undefined && !isAiApp(agent);
}

export function showComputerCallHint(
  agent: Pick<Agent, 'protocol' | 'mcp_client'> | undefined,
): boolean {
  return agent?.protocol === 'mcp-app' && callableOnComputer(agent.mcp_client);
}

export const computerCallHint = (name: string) => ({
  title: `Call ${name} too`,
  body: `Set it up on your computer once. Then you can call it.`,
  action: 'Set up calling',
});

/** With `callable`, the call hint follows, so the line doesn't say it can't be called. */
export const aiAppReachability = (name: string, callable = false) =>
  callable
    ? `${name} rings and messages you.`
    : `${name} rings and messages you. It can't take calls.`;
export const aiAppReplyStatus = (name: string) => `${name} reads this when it checks`;
export const aiAppEmptyChat = (name: string) =>
  `Messages from ${name} appear here. Reply anytime: it reads your replies when it checks.`;
export const removeAiAppCopy = (name: string) =>
  `Remove ${name}? It can't ring or message you until you allow it again, and its chat is deleted.`;
