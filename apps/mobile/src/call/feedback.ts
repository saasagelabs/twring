import type { CallState } from '@twring/contracts';

/** Moments that earn a haptic (UX §22). Never continuous, never for speech. */
export type CallFeedback = 'connected' | 'reconnected' | 'ended' | 'error';

export function feedbackFor(previous: CallState, next: CallState): CallFeedback | undefined {
  if (previous.status === next.status) return undefined;
  switch (next.status) {
    case 'LISTENING':
      if (previous.status === 'CONNECTING') return 'connected';
      if (previous.status === 'RECONNECTING') return 'reconnected';
      return undefined;
    case 'ENDED':
      return 'ended';
    case 'FAILED':
      return 'error';
    case 'IDLE':
    case 'PREPARING':
    case 'CONNECTING':
    case 'USER_SPEAKING':
    case 'AGENT_WORKING':
    case 'AGENT_SPEAKING':
    case 'RECONNECTING':
    case 'ENDING':
      return undefined;
  }
}
