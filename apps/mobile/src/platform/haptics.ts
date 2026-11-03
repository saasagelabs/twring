import * as Haptics from 'expo-haptics';

import type { CallFeedback } from '@/call/feedback';

/** HapticsService (MOBILE_PLATFORM_SPEC §3). Best effort: a missing vibrator never matters. */
export function playCallFeedback(feedback: CallFeedback): void {
  const played = (() => {
    switch (feedback) {
      case 'connected':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case 'reconnected':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      case 'ended':
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case 'error':
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  })();
  played.catch(() => undefined);
}

/** A single light cue when an approval card arrives. */
export function playApprovalFeedback(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}
