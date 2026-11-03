import { ApiError } from '../api/client';

import type { DeclineRequest } from './protocol';

export type DeclineOutcome = 'sent' | 'already_over' | 'retry_later';

/**
 * Sends one decline. An invite already handled, expired, or gone needs nothing more; only a
 * network-level failure is worth sending again.
 */
export async function sendDecline(
  decline: (inviteId: string, request: DeclineRequest) => Promise<void>,
  inviteId: string,
  request: DeclineRequest = {},
): Promise<DeclineOutcome> {
  try {
    await decline(inviteId, request);
    return 'sent';
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'http') {
      const status = error.status ?? 0;
      // 4xx other than auth/rate limits: the server has made up its mind about this invite.
      if (status >= 400 && status < 500 && status !== 401 && status !== 429) return 'already_over';
    }
    return 'retry_later';
  }
}

export interface DeclineQueue {
  take(): string[];
  requeue(inviteId: string): void;
}

/**
 * Declines tapped on the notification (possibly while the app was killed) are queued natively
 * without any credential; this sends them with the signed-in session. Returns what happened.
 */
export async function flushDeclines(
  queue: DeclineQueue,
  decline: (inviteId: string, request: DeclineRequest) => Promise<void>,
): Promise<Record<string, DeclineOutcome>> {
  const outcomes: Record<string, DeclineOutcome> = {};
  for (const inviteId of new Set(queue.take())) {
    const outcome = await sendDecline(decline, inviteId);
    outcomes[inviteId] = outcome;
    if (outcome === 'retry_later') queue.requeue(inviteId);
  }
  return outcomes;
}
