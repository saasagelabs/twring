import { secureStore } from '@/platform/secure-store';

import { ringPlatform } from '@/platform/ring';

import { markSeenValue, parseLastSeen } from './missed';

const LAST_SEEN_KEY = 'cord.missed_calls_seen_at';

/** When the owner last saw their missed calls (epoch ms); undefined when never. */
export async function missedLastSeen(): Promise<number | undefined> {
  return parseLastSeen(await secureStore.getItemAsync(LAST_SEEN_KEY).catch(() => null));
}

/** Everything missed so far is seen: Home stops listing it and the notifications go. */
export async function markMissedSeen(now = new Date()): Promise<void> {
  ringPlatform.clearMissedCalls();
  await secureStore.setItemAsync(LAST_SEEN_KEY, markSeenValue(now)).catch(() => undefined);
}
