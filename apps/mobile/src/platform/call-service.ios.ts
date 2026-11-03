import { requireOptionalNativeModule } from 'expo';

import type { CallBackgroundService } from '@/call/transport';
import { reportAudioEvent } from '@/observability/sentry';

/** modules/cord-call-service/ios (CordRing.swift): the live-call half. */
interface CordRingCallModule {
  setCallActive(active: boolean): void;
  addListener(
    event: 'onAudioEvent',
    listener: (data: Record<string, unknown>) => void,
  ): { remove(): void };
}

const native = requireOptionalNativeModule<CordRingCallModule>('CordRing');

let audioEvents: { remove(): void } | undefined;

/**
 * iOS: UIBackgroundModes \`audio\` plus LiveKit's session keep a call running with the screen locked
 * (ADR-019), so there is nothing to start. While a call is live, the proximity sensor turns the
 * screen off at the ear (no cheek taps on the call screen), and audio route changes and
 * interruptions are recorded for crash reports. Android overrides this with call-service.android.ts.
 */
export const callBackgroundService: CallBackgroundService = {
  prepare: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  setCallScreen(active) {
    try {
      native?.setCallActive(active);
      audioEvents?.remove();
      audioEvents = active ? native?.addListener('onAudioEvent', reportAudioEvent) : undefined;
    } catch {
      // A missing or old native module only means no proximity: the call itself is unaffected.
    }
  },
};

/** The ongoing notification's End action. iOS has none. */
export function onBackgroundEndPressed(_listener: () => void): () => void {
  return () => undefined;
}

/** The service could not enter the foreground after starting. iOS has no service. */
export function onBackgroundStartRefused(_listener: () => void): () => void {
  return () => undefined;
}
