import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { apiErrorCopy, type ErrorCopy } from '@/api/errors';

export interface Resource<T> {
  data: T | undefined;
  error: ErrorCopy | undefined;
  /** First load, with nothing to show yet. */
  loading: boolean;
  /** A pull-to-refresh in flight. */
  refreshing: boolean;
  reload: (options?: { refresh?: boolean; silent?: boolean }) => void;
}

/** How often screens showing a computer's online status refresh while in focus. */
export const STATUS_POLL_MS = 20_000;

/**
 * Loads `load` whenever the screen gains focus, cancelling the previous request. Keeps the last
 * good data on screen while reloading so a refresh never blanks the list. With `pollMs`, also
 * reloads quietly on that interval while the screen is in focus; a failed quiet reload keeps the
 * last good data and shows no error.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  { pollMs }: { pollMs?: number } = {},
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ErrorCopy | undefined>(undefined);
  const [pending, setPending] = useState<'none' | 'load' | 'refresh'>('load');
  const inflight = useRef<AbortController | undefined>(undefined);

  const reload = useCallback(
    (options: { refresh?: boolean; silent?: boolean } = {}) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      if (!options.silent) setPending(options.refresh ? 'refresh' : 'load');
      load(controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          setData(value);
          setError(undefined);
          setPending('none');
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          if (!options.silent) setError(apiErrorCopy(reason));
          setPending('none');
        },
      );
    },
    [load],
  );

  useFocusEffect(
    useCallback(() => {
      reload();
      const timer =
        pollMs === undefined ? undefined : setInterval(() => reload({ silent: true }), pollMs);
      return () => {
        if (timer !== undefined) clearInterval(timer);
        inflight.current?.abort();
      };
    }, [reload, pollMs]),
  );

  return {
    data,
    error,
    loading: pending === 'load' && data === undefined,
    refreshing: pending === 'refresh',
    reload,
  };
}
