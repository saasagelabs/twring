import type { ErrorCode } from '@twring/contracts';
import { MESSAGE_PUSH_TEXT } from '@twring/push';

/**
 * Stable refusal codes for private chats. Kept on the gateway side until the app learns them
 * (P3): adding them to `errorCodeSchema` now would need an app change in the same release.
 */
export type PrivateChatErrorCode =
  | 'private_chats_off'
  | 'device_cap'
  | 'device_conflict'
  | 'offer_expired'
  | 'offer_claimed'
  | 'handle_taken'
  | 'private_thread'
  | 'not_private'
  | 'private_unsupported'
  | 'private_is_one_way';
export type GatewayErrorCode = ErrorCode | PrivateChatErrorCode;

/**
 * Private chats (ADR-044): every server feature that would need a chat's text (quotes, Listen,
 * agent-read replies, ring reasons, push previews) checks here and stays out of a private chat.
 */

/**
 * The fixed text a push or a ring carries for a private chat, never anything from the chat: the
 * same "New message" hosted pushes already use, so a self-hosted relay push carries no more.
 */
export const PRIVATE_PUSH_TEXT = MESSAGE_PUSH_TEXT;
export const PRIVATE_RING_REASON = 'Wants to talk';

export class PrivateThreadError extends Error {
  readonly code = 'private_thread' as const;

  constructor() {
    super('private_thread');
    this.name = 'PrivateThreadError';
  }
}

/** True for a private chat's summary (`private` is left out of chats that are not private). */
export function isPrivate(thread: { private?: boolean }): boolean {
  return thread.private === true;
}

/** Throws `PrivateThreadError` when this person's chat with the agent is private. */
export async function assertNotPrivate(
  store: { isPrivate(userId: string, agentId: string): Promise<boolean> },
  userId: string,
  agentId: string,
): Promise<void> {
  if (await store.isPrivate(userId, agentId)) throw new PrivateThreadError();
}
