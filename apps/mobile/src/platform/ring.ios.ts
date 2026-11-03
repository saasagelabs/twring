import { requireOptionalNativeModule } from 'expo';

import type { RingPermissions, RingPlatform } from './ring';

export type { RingPermissions, RingPlatform } from './ring';

type Subscription = { remove(): void };

type IosRingEvent =
  | 'onPushToken'
  | 'onAlertToken'
  | 'onRingAnswered'
  | 'onRingDeclined'
  | 'onCallEnded'
  | 'onCallMuted'
  | 'onNotificationOpened';

/** modules/cord-call-service/ios: CordRing.swift (PushKit, CallKit, notifications). */
interface CordRingModule {
  getPushToken(): Promise<string | null>;
  getAlertToken(): Promise<string | null>;
  alertsAllowed(): boolean;
  requestAlerts(): Promise<boolean>;
  openSettings(): void;
  clearRing(inviteId: string): void;
  takePendingDeclines(): string[];
  queueDecline(inviteId: string): void;
  takeAnsweredRing(): Record<string, unknown> | null;
  takeOpenedNotification(): Record<string, unknown> | null;
  endCall(): void;
  speakThenEnd(uri: string, headers: Record<string, string>): void;
  setMuted(muted: boolean): void;
  notify(title: string, body: string): void;
  clearMissedCalls(): void;
  clearMessages(agentId: string): void;
  addListener(event: IosRingEvent, listener: (data: Record<string, unknown>) => void): Subscription;
}

const native = requireOptionalNativeModule<CordRingModule>('CordRing');

function listen(event: IosRingEvent, listener: (data: Record<string, unknown>) => void) {
  const subscription = native?.addListener(event, listener);
  return () => subscription?.remove();
}

/** Native calls never take the app down: a missing module or a native error is just "off". */
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

/**
 * iOS rings: agents ring through PushKit and the system call screen
 * (CallKit), so there is no full-screen permission or channel to manage; only alerts (messages and
 * missed rings) need the user's permission.
 */
export const ringPlatform: RingPlatform = {
  supported: native !== null,
  systemRingScreen: true,
  async getPushToken() {
    return (await native?.getPushToken().catch(() => null)) ?? null;
  },
  // The VoIP token belongs to the install; signing out removes the server registration instead.
  deletePushToken: () => Promise.resolve(),
  setRingAccount: () => undefined,
  permissions(): RingPermissions {
    const notifications = safely(() => native?.alertsAllowed() ?? false, false);
    return { notifications, fullScreen: true, channel: true };
  },
  async requestNotifications() {
    return (await native?.requestAlerts().catch(() => false)) ?? false;
  },
  openNotificationSettings: () => safely(() => native?.openSettings(), undefined),
  openFullScreenIntentSettings: () => safely(() => native?.openSettings(), undefined),
  clearRing: (inviteId) => safely(() => native?.clearRing(inviteId), undefined),
  takePendingDeclines: () => safely(() => native?.takePendingDeclines(), undefined) ?? [],
  queueDecline: (inviteId) => safely(() => native?.queueDecline(inviteId), undefined),
  setShowWhenLocked: () => undefined,
  clearMissedCalls: () => safely(() => native?.clearMissedCalls(), undefined),
  clearMessages: (agentId) => safely(() => native?.clearMessages(agentId), undefined),
  // CallKit shows the ring; JS never opens its own incoming screen for a push.
  onRing: () => () => undefined,
  onRingCancel: () => () => undefined,
  onRingDeclined: (listener) => listen('onRingDeclined', () => listener()),
  onPushToken: (listener) =>
    listen('onPushToken', (data) => {
      if (typeof data.token === 'string') listener(data.token);
    }),

  async getAlertToken() {
    return (await native?.getAlertToken().catch(() => null)) ?? null;
  },
  onAlertToken: (listener) => listen('onAlertToken', () => listener()),
  onRingAnswered: (listener) => listen('onRingAnswered', () => listener()),
  takeAnsweredRing: () => safely(() => native?.takeAnsweredRing() ?? null, null),
  onSystemCallEnded: (listener) => listen('onCallEnded', () => listener()),
  onSystemCallMuted: (listener) =>
    listen('onCallMuted', (data) => {
      if (typeof data.muted === 'boolean') listener(data.muted);
    }),
  endSystemCall: () => safely(() => native?.endCall(), undefined),
  speakThenEndSystemCall: (source) =>
    safely(() => native?.speakThenEnd(source.uri, source.headers), undefined),
  setSystemCallMuted: (muted) => safely(() => native?.setMuted(muted), undefined),
  notify: (title, body) => safely(() => native?.notify(title, body), undefined),
  takeOpenedNotification: () => safely(() => native?.takeOpenedNotification() ?? null, null),
  onNotificationOpened: (listener) => listen('onNotificationOpened', () => listener()),
};
