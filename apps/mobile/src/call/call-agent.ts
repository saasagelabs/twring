import type { Agent } from '@twring/contracts';
import { Alert } from 'react-native';

import { callRefusal } from '@/agents/labels';

import { startCall } from './start';

/**
 * Calls a saved agent, or, when its computer is known to be offline or removed, says so before any
 * call starts instead of after one fails.
 */
export function callAgent(
  agent: Pick<Agent, 'id' | 'name' | 'connector_online' | 'connector_removed'>,
): void {
  const refusal = callRefusal(agent);
  if (refusal !== undefined) {
    Alert.alert(refusal.title, refusal.message);
    return;
  }
  startCall({ agentId: agent.id, name: agent.name });
}
