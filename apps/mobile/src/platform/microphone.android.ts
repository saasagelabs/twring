import { PermissionsAndroid } from 'react-native';

import type { MicrophonePermission, MicrophonePermissionService } from '@/call/transport';

const RESULT: Record<string, MicrophonePermission> = {
  [PermissionsAndroid.RESULTS.GRANTED]: 'granted',
  [PermissionsAndroid.RESULTS.DENIED]: 'denied',
  // "Don't ask again": only Settings can change it now, so never re-prompt in a loop.
  [PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN]: 'blocked',
};

export const microphonePermission: MicrophonePermissionService = {
  async request() {
    const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
    if (await PermissionsAndroid.check(permission)) return 'granted';
    const result = await PermissionsAndroid.request(permission);
    return RESULT[result] ?? 'denied';
  },
};
