import type { AgentProtocol } from '@twring/contracts';

/**
 * "How to bring it back": short steps shown under an offline agent, chosen by how the agent
 * reaches Twring. Plain words only (owner rule: no plumbing). A computer pairs with `setup`, which
 * runs the link as a background service that starts when someone signs in to the computer and
 * restarts when it stops (ADR-027), so waking and signing in is what brings it back.
 */
export const OFFLINE_HELP_TITLE = 'How to bring it back';

export function offlineHelpSteps(protocol: AgentProtocol): readonly string[] {
  switch (protocol) {
    case 'cord-connector':
      return [
        "Turn on or wake your computer and check it's connected to the internet.",
        'Sign in to your computer. Twring starts again by itself. If it still says offline, restart the computer.',
        'Call again.',
      ];
    case 'openai-chat':
    case 'cord-rest':
    case 'cord-native':
      return [
        'Check that the service your agent runs on is up and reachable online.',
        'Call again.',
      ];
    case 'mcp-app':
      return ["Open the AI app and check you're signed in.", 'Ask it to ring or message you.'];
  }
}
