import type { CallBackgroundService } from '@/call/transport';

/**
 * iOS: nothing to start. UIBackgroundModes `audio` plus LiveKit's playAndRecord/voiceChat session
 * keep a call running with the screen locked (ADR-019). Android overrides this file.
 */
export const callBackgroundService: CallBackgroundService = {
  prepare: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  setCallScreen: () => undefined,
};

/** The ongoing notification's End action. iOS has none. */
export function onBackgroundEndPressed(_listener: () => void): () => void {
  return () => undefined;
}

/** The service could not enter the foreground after starting. iOS has no service. */
export function onBackgroundStartRefused(_listener: () => void): () => void {
  return () => undefined;
}
