import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';

import type { CallBackgroundService } from '@/call/transport';

/** modules/cord-call-service: the call's foreground service and ongoing notification (ADR-019). */
interface CordCallServiceModule {
  start(title: string, text: string): Promise<void>;
  stop(): Promise<void>;
  setCallScreen(active: boolean): void;
  addListener(event: 'onEndPressed' | 'onStartRefused', listener: () => void): { remove(): void };
}

const native = requireOptionalNativeModule<CordCallServiceModule>('CordCallService');

/** Asked at most once per app run; a denial only hides the notification, the call still works. */
let notificationsAsked = false;

export const callBackgroundService: CallBackgroundService = {
  async prepare() {
    // POST_NOTIFICATIONS is a runtime permission from Android 13 (API 33).
    if (notificationsAsked || Number(Platform.Version) < 33) return;
    notificationsAsked = true;
    const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
    try {
      if (!(await PermissionsAndroid.check(permission)))
        await PermissionsAndroid.request(permission);
    } catch {
      // Never block a call on the notification permission.
    }
  },
  async start({ agentName }) {
    if (native === null) throw new Error('call service module missing');
    await native.start('Twring call in progress', agentName);
  },
  async stop() {
    await native?.stop();
  },
  setCallScreen(active) {
    native?.setCallScreen(active);
  },
};

export function onBackgroundEndPressed(listener: () => void): () => void {
  const subscription = native?.addListener('onEndPressed', listener);
  return () => subscription?.remove();
}

/** The service started but Android refused startForeground (e.g. app not visible on Android 14+). */
export function onBackgroundStartRefused(listener: () => void): () => void {
  const subscription = native?.addListener('onStartRefused', listener);
  return () => subscription?.remove();
}
