import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { twringApi } from '@/api';

import {
  remainingAtConnect,
  timeLeftNotice,
  TIME_LEFT_COPY,
  type TimeLeftNotice,
} from './time-left';

/**
 * The "minutes left today" line for a connected call. Fetches usage once per connect and never
 * blocks the call: unlimited calling or a failed fetch shows nothing. `now` is the screen's clock.
 * Each line gets one light haptic and one screen reader announcement when it first appears.
 */
export function useTimeLeftNotice(
  connectedAt: number | undefined,
  now: number,
): string | undefined {
  // Keyed by the connect it was fetched for, so a new call never reuses the last call's figure.
  const [fetched, setFetched] = useState<{ at: number; seconds: number | undefined }>();
  const shown = useRef(new Set<TimeLeftNotice>());

  useEffect(() => {
    shown.current.clear();
    const api = twringApi();
    if (connectedAt === undefined || api === undefined) return;
    const abort = new AbortController();
    api
      .usage(abort.signal)
      .then((usage) => {
        if (!abort.signal.aborted)
          setFetched({ at: connectedAt, seconds: remainingAtConnect(usage) });
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [connectedAt]);

  const remaining = fetched?.at === connectedAt ? fetched?.seconds : undefined;
  const notice =
    connectedAt === undefined ? undefined : timeLeftNotice(remaining, now - connectedAt);

  useEffect(() => {
    if (notice === undefined || shown.current.has(notice)) return;
    shown.current.add(notice);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    AccessibilityInfo.announceForAccessibility(TIME_LEFT_COPY[notice]);
  }, [notice]);

  return notice === undefined ? undefined : TIME_LEFT_COPY[notice];
}
