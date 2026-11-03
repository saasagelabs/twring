import * as SecureStore from 'expo-secure-store';

import { backgroundReadable } from './keychain';

/** The app's keychain: items stay readable when a ring wakes Twring on a locked phone. */
export const secureStore = backgroundReadable(SecureStore, {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
});

/** Keys saved before build 11, re-saved once with the new setting (the session separately). */
export const KEYS_TO_MIGRATE = [
  'cord.push_device_id',
  'cord.ring_notifications_asked',
  'cord.ring_pending_device',
  'cord.missed_calls_seen_at',
  'twring.access_member',
] as const;
