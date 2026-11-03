import type { ThreadMessage } from '@twring/contracts';

export function autoListenTarget(
  messages: ThreadMessage[],
  requested: boolean,
): string | undefined {
  if (!requested) return undefined;
  return [...messages]
    .reverse()
    .find((message) => message.kind === 'agent_text' && Boolean(message.text))?.id;
}
