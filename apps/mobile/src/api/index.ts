import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { apiAuth } from '@/auth';
import { mobileEnv } from '@/config/env';
import { activeServerUrl, onActiveServerChanged } from '../servers/active';
import { profileStore } from '../servers/profiles';

import { appVersionLabel } from './app-version';
import { createTwringApi, type TwringApi } from './client';

let api: TwringApi | undefined;

/** The app's Twring API client. Undefined when the build is missing its configuration. */
export function twringApi(): TwringApi | undefined {
  if (api !== undefined || !mobileEnv.ok) return api;
  const auth = apiAuth();
  api = createTwringApi({
    baseUrl: activeServerUrl(),
    requireSecureMedia: mobileEnv.env.CORD_ENV !== 'development',
    appVersion: appVersionLabel(Constants.expoConfig, Platform.OS),
    ...(auth && { auth }),
    rejectRedirects: profileStore.active().kind === 'selfhost',
  });
  return api;
}

// A switched server needs a client for its address; the next twringApi() builds one.
onActiveServerChanged(() => {
  api = undefined;
});

export { ApiError, type TwringApi } from './client';
export { AGENT_OFFLINE_COPY, apiErrorCopy, isServiceUnavailable, type ErrorCopy } from './errors';
