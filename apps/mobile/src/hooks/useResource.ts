import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import { apiErrorCopy, type ErrorCopy } from '@/api/errors';

import { onForeground } from './foreground';

export interface Resource<T> {
  data: T | undefined;
  error: ErrorCopy | undefined;
  /** First load, with nothing to show yet. */
  loading: boolean;
  /** A pull-to-refresh in flight. */
  refreshing: boolean;
  reload: (options?: { refresh?: boolean; silent?: boolean }) => void;
  /** `data` came from the saved copy; no load has succeeded since the app started. */
  stale: boolean;
}

/** A saved copy of the last good data, shown until the first load succeeds. */
export interface ResourceCache<T> {
  /** The saved copy, or undefined when there is none (or it cannot be used). */
  load(): Promise<T | undefined>;
  /**
   * Called when a load starts; the function it returns saves that load's result. Binding the save
   * at the start keeps a load that finishes after an account or server switch from being saved
   * for the new one.
   */
  saver(): (value: T) => void;
}

/** How often screens showing a computer's online status refresh while in focus. */
export const STATUS_POLL_MS = 20_000;

/**
 * Loads `load` whenever the screen gains focus, cancelling the previous request. Keeps the last
 * good data on screen while reloading so a refresh never blanks the list. With `pollMs`, also
 * reloads quietly on that interval while the screen is in focus. Also reloads quietly when the app
 * returns to the foreground while the screen is in focus; a failed quiet reload keeps the
 * last good data and shows no error. With `cache`, shows the saved copy (marked `stale`) until a
 * load succeeds, and saves every successful load; a saved copy never replaces loaded data.
 */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  { pollMs, cache }: { pollMs?: number; cache?: ResourceCache<T> } = {},
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const fresh = useRef(false);
  const seeded = useRef(false);
  const [error, setError] = useState<ErrorCopy | undefined>(undefined);
  const [pending, setPending] = useState<'none' | 'load' | 'refresh'>('load');
  const inflight = useRef<AbortController | undefined>(undefined);

  const reload = useCallback(
    (options: { refresh?: boolean; silent?: boolean } = {}) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      if (!options.silent) setPending(options.refresh ? 'refresh' : 'load');
      const save = cache?.saver();
      load(controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          fresh.current = true;
          setData(value);
          setStale(false);
          save?.(value);
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
    [load, cache],
  );

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      if (cache && !fresh.current && !seeded.current)
        void cache
          .load()
          .then((saved) => {
            if (!focused || saved === undefined || fresh.current || seeded.current) return;
            seeded.current = true;
            setData(saved);
            setStale(true);
          })
          .catch(() => undefined);
      reload();
      const timer =
        pollMs === undefined ? undefined : setInterval(() => reload({ silent: true }), pollMs);
      const stopForeground = onForeground(() => reload({ silent: true }));
      return () => {
        focused = false;
        stopForeground();
        if (timer !== undefined) clearInterval(timer);
        inflight.current?.abort();
      };
    }, [reload, pollMs, cache]),
  );

  return {
    data,
    error,
    loading: pending === 'load' && data === undefined,
    refreshing: pending === 'refresh',
    reload,
    stale,
  };
}
