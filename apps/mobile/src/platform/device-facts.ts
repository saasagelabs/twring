import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type { DeviceFacts } from '@/call/device-report';

/** Platform, OS version, model (Android only; iOS exposes none without a native module) and build. */
export function deviceFacts(): DeviceFacts {
  const config = Constants.expoConfig;
  const constants = Platform.constants as { Model?: unknown };
  const build = Platform.OS === 'android' ? config?.android?.versionCode : config?.ios?.buildNumber;
  return {
    ...((Platform.OS === 'android' || Platform.OS === 'ios') && { platform: Platform.OS }),
    os: String(Platform.Version),
    ...(typeof constants.Model === 'string' && { model: constants.Model }),
    ...(build !== undefined && { appBuild: String(build) }),
  };
}
