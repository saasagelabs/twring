import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

import type { RingPermissions, RingPlatform } from './ring';

export type { RingPermissions, RingPlatform } from './ring';

type Subscription = { remove(): void };

/** modules/cord-call-service: the ring half (Ring.kt). */
interface CordRingModule {
  getPushToken(): Promise<string | null>;
  deletePushToken(): Promise<void>;
  setRingAccount(ref: string | null): void;
  ringPermissions(): RingPermissions;
  openFullScreenIntentSettings(): void;
  openNotificationSettings(): void;
  clearRing(inviteId: string): void;
  takePendingDeclines(): string[];
  queueDecline(inviteId: string): void;
  setShowWhenLocked(on: boolean): void;
  clearMissedCalls(): void;
  clearMessages?(agentId: string): void;
  addListener(
    event: 'onRing' | 'onRingCancel' | 'onRingDeclined' | 'onPushToken',
    listener: (data: Record<string, string>) => void,
  ): Subscription;
}

const native = requireOptionalNativeModule<CordRingModule>('CordCallService');

function listen(
  event: 'onRing' | 'onRingCancel' | 'onRingDeclined' | 'onPushToken',
  listener: (data: Record<string, string>) => void,
): () => void {
  const subscription = native?.addListener(event, listener);
  return () => subscription?.remove();
}

/** Native calls never take the app down: a missing module or a refused intent is just "off". */
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}

export const ringPlatform: RingPlatform = {
  supported: native !== null,
  async getPushToken() {
    return (await native?.getPushToken()) ?? null;
  },
  async deletePushToken() {
    await native?.deletePushToken();
  },
  setRingAccount: (ref) => safely(() => native?.setRingAccount(ref), undefined),
  permissions() {
    return (
      safely(() => native?.ringPermissions(), undefined) ?? {
        notifications: false,
        fullScreen: false,
        channel: false,
      }
    );
  },
  async requestNotifications() {
    // POST_NOTIFICATIONS is a runtime permission from Android 13 (API 33).
    if (Number(Platform.Version) < 33) return true;
    try {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  },
  openNotificationSettings: () => safely(() => native?.openNotificationSettings(), undefined),
  openFullScreenIntentSettings: () =>
    safely(() => native?.openFullScreenIntentSettings(), undefined),
  clearRing: (inviteId) => safely(() => native?.clearRing(inviteId), undefined),
  takePendingDeclines: () => safely(() => native?.takePendingDeclines(), undefined) ?? [],
  queueDecline: (inviteId) => safely(() => native?.queueDecline(inviteId), undefined),
  setShowWhenLocked: (on) => safely(() => native?.setShowWhenLocked(on), undefined),
  clearMissedCalls: () => safely(() => native?.clearMissedCalls(), undefined),
  clearMessages: (agentId) => safely(() => native?.clearMessages?.(agentId), undefined),
  onRing: (listener) => listen('onRing', listener),
  onRingCancel: (listener) => listen('onRingCancel', listener),
  onRingDeclined: (listener) => listen('onRingDeclined', () => listener()),
  onPushToken: (listener) =>
    listen('onPushToken', (data) => {
      if (typeof data.token === 'string') listener(data.token);
    }),
};
