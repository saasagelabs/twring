import type { GatewayEnv } from '@twring/config/gateway';
import { parseConnectorEndpoint, SEALED_CHAT_FEATURE } from '@twring/contracts';

import type { ConnectorHub } from '../connectors/hub';
import type { AgentRecord } from '../store/repositories';

/**
 * Private chats (ADR-044) are behind `PRIVATE_CHATS_ENABLED`, off by default. With it on,
 * `PRIVATE_CHATS_USERS` narrows them to listed accounts; no list means everyone.
 */
export function privateChatsAllowed(
  env: Pick<GatewayEnv, 'PRIVATE_CHATS_ENABLED' | 'PRIVATE_CHATS_USERS'>,
  userId: string,
): boolean {
  if (!env.PRIVATE_CHATS_ENABLED) return false;
  return env.PRIVATE_CHATS_USERS === undefined || env.PRIVATE_CHATS_USERS.includes(userId);
}

/** What the chat service asks before a chat becomes private (ADR-044). */
export function privateChatAccess(
  env: Pick<GatewayEnv, 'PRIVATE_CHATS_ENABLED' | 'PRIVATE_CHATS_USERS'>,
  hub: Pick<ConnectorHub, 'isOnline' | 'supports'>,
): { allowed(userId: string): boolean; computerSupports(record: AgentRecord): boolean } {
  return {
    allowed: (userId) => privateChatsAllowed(env, userId),
    computerSupports: (record) => {
      if (record.protocol !== 'cord-connector') return false;
      const endpoint = parseConnectorEndpoint(record.endpoint_url);
      return (
        endpoint !== undefined &&
        hub.isOnline(record.user_id, endpoint.connectorId) &&
        hub.supports(endpoint.connectorId, SEALED_CHAT_FEATURE) === true
      );
    },
  };
}
