import type { GatewayEnv } from '@twring/config/gateway';

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
