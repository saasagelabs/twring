import type { ThreadMessage } from '@twring/contracts';

import { ApiError } from '../api/client';
import { apiErrorCopy } from '../api/errors';

export type MessageAction = 'reply' | 'copy' | 'share' | 'delete';

export const ACTION_LABELS: Record<MessageAction, string> = {
  reply: 'Reply',
  copy: 'Copy',
  share: 'Share',
  delete: 'Delete',
};

/** What a long press offers for one message, in the order the sheet lists them. */
export function messageActions(
  target: { kind: 'message'; message: ThreadMessage } | { kind: 'pending'; text: string },
): MessageAction[] {
  const actions: MessageAction[] = [];
  if (target.kind === 'pending') {
    // Only on this phone so far: it has its own cancel, and nothing to reply to or delete yet.
    if (target.text) actions.push('copy', 'share');
    return actions;
  }
  const message = target.message;
  if (message.kind !== 'user_text' && message.kind !== 'agent_text') return actions;
  actions.push('reply');
  if (message.text) actions.push('copy', 'share');
  // The server refuses (409) while the agent still answers it.
  if (message.kind !== 'user_text' || (message.status !== 'sent' && message.status !== 'working'))
    actions.push('delete');
  return actions;
}

/** The first line of a quoted message, for the reply bar. */
export function quoteLine(text: string): string {
  const line = text.split('\n').find((part) => part.trim()) ?? '';
  return line.trim() || 'Voice note';
}

export const DELETE_CONFIRM =
  'Delete this message? It is removed from this chat on all your devices.';

/** What to tell the person when a delete did not go through. */
export function deleteFailureCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === 'message_in_progress')
    return 'Your agent is still working on this message. You can delete it once it has finished.';
  return apiErrorCopy(error).message;
}
