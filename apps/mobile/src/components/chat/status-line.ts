import type { ThreadMessage, UserMessageStatus } from '@twring/contracts';

import { aiAppReplyStatus } from '../../agents/ai-app';
import { apiErrorCopy } from '../../api/errors';
import { failedSendText, messageStatus, workingLabel } from '../../threads/presentation';

/** Reduced motion stops the dots, never the words. */
export function workingText(label: string | undefined): string {
  return label ? `Working · ${label}` : 'Working…';
}

export type StatusLineContent =
  | { kind: 'working'; text: string; label?: string }
  | {
      kind: 'status';
      text: string;
      tone: 'tertiary' | 'danger';
      retryClientId?: string;
      deleteClientId?: string;
    }
  | { kind: 'empty' };

export interface StatusLineInput {
  name: string;
  aiApp: boolean;
  working: boolean;
  activity?: string;
  /** The newest unconfirmed send, if any. */
  pending?: { clientId: string; state: 'sending' | 'failed'; error?: unknown; errorCode?: string };
  /** The newest own message the server knows about. */
  latest?: { status: UserMessageStatus; errorCode?: string };
}

/**
 * The newest message this person sent, plain or private, as the status line reads it. A private
 * message counts as working once sent: its computer starts on it at once, so Stop shows then.
 */
export function latestOwn(
  messages: readonly ThreadMessage[],
): { id: string; status: UserMessageStatus; errorCode?: string; working: boolean } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'user_text')
      return {
        id: m.id,
        status: m.status,
        ...(m.error_code !== undefined && { errorCode: m.error_code }),
        working: m.status === 'working',
      };
    if (m.kind === 'sealed' && m.author === 'user' && m.status !== undefined)
      return {
        id: m.id,
        status: m.status,
        ...(m.error_code !== undefined && { errorCode: m.error_code }),
        working: m.status === 'sent' || m.status === 'working',
      };
  }
  return undefined;
}

/** One line above the composer: working beats the latest send's status; otherwise nothing. */
export function statusLineContent(input: StatusLineInput): StatusLineContent {
  if (input.working) {
    const label = workingLabel(input.activity);
    return { kind: 'working', text: workingText(label), label };
  }
  const { pending, latest, name, aiApp } = input;
  if (pending) {
    if (pending.state === 'failed')
      return {
        kind: 'status',
        tone: 'danger',
        // Its text is gone after a restart: Retry would do nothing, so Delete is the one action.
        ...(pending.errorCode === 'private_unsent'
          ? { deleteClientId: pending.clientId }
          : { retryClientId: pending.clientId }),
        text: failedSendText(
          name,
          pending.errorCode,
          pending.error ? apiErrorCopy(pending.error).message : undefined,
        ),
      };
    return {
      kind: 'status',
      tone: 'tertiary',
      text: aiApp ? aiAppReplyStatus(name) : messageStatus('sending', name),
    };
  }
  if (latest) {
    const failed = latest.status === 'failed';
    return {
      kind: 'status',
      tone: failed ? 'danger' : 'tertiary',
      // A failure is never hidden behind the AI app's calm "reads this when it checks".
      text:
        aiApp && !failed
          ? aiAppReplyStatus(name)
          : messageStatus(latest.status, name, latest.errorCode),
    };
  }
  return { kind: 'empty' };
}
