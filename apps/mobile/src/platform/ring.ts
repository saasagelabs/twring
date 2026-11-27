/**
 * Incoming agent calls: push token, the ringing notification, and its permissions. Android
 * (ring.android.ts, Ring.kt) and iOS (ring.ios.ts, CordRing.swift: PushKit and CallKit) override
 * this file; here, on other platforms, everything is inert.
 */

export interface RingPermissions {
  /** Notifications allowed for the app (Android 13+ runtime permission). */
  notifications: boolean;
  /** Full-screen intent allowed (Android 14+ may revoke it). */
  fullScreen: boolean;
  /** The "Incoming agent calls" channel is not switched off. */
  channel: boolean;
}

export interface RingPlatform {
  /** False where agents cannot ring this phone at all (iOS in v0.01). */
  supported: boolean;
  getPushToken(): Promise<string | null>;
  deletePushToken(): Promise<void>;
  setRingAccount(ref: string | null): void;
  permissions(): RingPermissions;
  /** Asks for POST_NOTIFICATIONS; resolves true when granted. */
  requestNotifications(): Promise<boolean>;
  openNotificationSettings(): void;
  openFullScreenIntentSettings(): void;
  clearRing(inviteId: string): void;
  takePendingDeclines(): string[];
  queueDecline(inviteId: string): void;
  setShowWhenLocked(on: boolean): void;
  /** Clears the "Missed call from…" notifications (seen in the app). */
  clearMissedCalls(): void;
  clearMessages(agentId: string): void;
  /** The chat on screen, or null: the phone shows no notification for that chat. */
  setVisibleChat(agentId: string | null): void;
  onRing(listener: (data: unknown) => void): () => void;
  onRingCancel(listener: (data: unknown) => void): () => void;
  onRingDeclined(listener: () => void): () => void;
  onPushToken(listener: (token: string) => void): () => void;

  // iOS only (CallKit). Android rings through its own screen and leaves these out.
  /** Every ring shows on the system call screen, never the app's own ring screen. */
  systemRingScreen?: boolean;
  /** The alert token for messages and missed rings. */
  getAlertToken?(): Promise<string | null>;
  onAlertToken?(listener: () => void): () => void;
  /** A ring was answered on the system call screen; take it with takeAnsweredRing. */
  onRingAnswered?(listener: () => void): () => void;
  /** The answered ring's push payload, once. */
  takeAnsweredRing?(): unknown;
  /** Hang up or mute pressed on the system call screen. */
  onSystemCallEnded?(listener: () => void): () => void;
  onSystemCallMuted?(listener: (muted: boolean) => void): () => void;
  /** The app's call ended or its mute changed: keep the system call screen in step. */
  endSystemCall?(): void;
  /** An AI app's ring answered on the system call: read its message out, then end the call. */
  speakThenEndSystemCall?(source: { uri: string; headers: Record<string, string> }): void;
  setSystemCallMuted?(muted: boolean): void;
  /** Posts a plain notification, e.g. why an answered ring could not connect. */
  notify?(title: string, body: string): void;
  /** A tapped notification's data, once. */
  takeOpenedNotification?(): unknown;
  onNotificationOpened?(listener: () => void): () => void;
  /** A ring started showing on the system call screen. */
  onRingShown?(listener: (inviteId: string) => void): () => void;
  /** Rings showing on the system call screen and not yet answered. */
  ringingInvites?(): Promise<string[]>;
  /** The server says this ring is over: close its system call screen with the matching reason. */
  ringOver?(inviteId: string, status: string): void;
}

const off = () => () => undefined;

export const ringPlatform: RingPlatform = {
  supported: false,
  getPushToken: () => Promise.resolve(null),
  deletePushToken: () => Promise.resolve(),
  setRingAccount: () => undefined,
  permissions: () => ({ notifications: false, fullScreen: false, channel: false }),
  requestNotifications: () => Promise.resolve(false),
  openNotificationSettings: () => undefined,
  openFullScreenIntentSettings: () => undefined,
  clearRing: () => undefined,
  takePendingDeclines: () => [],
  queueDecline: () => undefined,
  setShowWhenLocked: () => undefined,
  clearMissedCalls: () => undefined,
  clearMessages: () => undefined,
  setVisibleChat: () => undefined,
  onRing: off,
  onRingCancel: off,
  onRingDeclined: off,
  onPushToken: off,
};
