import { ringPushSchema, type RingPush } from './protocol';

/**
 * iOS: what the app does with a ring answered on the system call screen,
 * and with a tapped notification. Pure, so it is tested without the native side.
 */

/** The answered ring, ready for the existing answer flow; undefined when it is not one of ours. */
export function answeredRing(payload: unknown): RingPush | undefined {
  const parsed = ringPushSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

export type OpenedRoute =
  { pathname: '/chats/[agentId]'; params: { agentId: string } } | { pathname: '/history' };

/** Where a tapped notification leads: a message opens its chat, a missed ring opens Recents. */
export function openedNotificationRoute(data: unknown): OpenedRoute | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, agent_id: agentId } = data as Record<string, unknown>;
  if (type === 'cord.message' && typeof agentId === 'string' && agentId !== '')
    return { pathname: '/chats/[agentId]', params: { agentId } };
  if (type === 'cord.ring_cancel') return { pathname: '/history' };
  return undefined;
}
