import type { MicrophonePermissionService } from '@/call/transport';

/**
 * iOS (and any platform without an Android-style runtime request): the system prompt appears on
 * first microphone capture, and a denial surfaces as a capture error the controller maps to
 * MIC_PERMISSION_DENIED. Android overrides this in microphone.android.ts.
 */
export const microphonePermission: MicrophonePermissionService = {
  request: () => Promise.resolve('undetermined'),
};
