import { useEffect, useRef } from 'react';

import type { ErrorCopy } from '@/api/errors';

/** One screen resource that loads from the server and may have failed. */
export interface LoadSource {
  error: ErrorCopy | undefined;
  reload: () => void;
}

/**
 * The one load-error notice a screen shows, or undefined. Two resources failing the same way
 * show one notice whose retry reloads both. While the phone is offline, network failures are
 * hidden: the header already says the phone is waiting for network.
 */
export function loadNotice(
  sources: readonly LoadSource[],
  phoneOnline: boolean,
): { error: ErrorCopy; retry: () => void } | undefined {
  const failed = sources.filter(
    (source) => source.error !== undefined && (phoneOnline || source.error.network !== true),
  );
  const first = failed[0]?.error;
  if (first === undefined) return undefined;
  return { error: first, retry: () => failed.forEach((source) => source.reload()) };
}

/** True only on the step from offline to online. */
export function cameOnline(previous: boolean, current: boolean): boolean {
  return !previous && current;
}

/** When the phone comes back online, reloads each source that currently shows an error. */
export function useReloadWhenOnline(phoneOnline: boolean, sources: readonly LoadSource[]): void {
  const previous = useRef(phoneOnline);
  const latest = useRef(sources);
  useEffect(() => {
    latest.current = sources;
  });
  useEffect(() => {
    const was = previous.current;
    previous.current = phoneOnline;
    if (!cameOnline(was, phoneOnline)) return;
    for (const source of latest.current) if (source.error !== undefined) source.reload();
  }, [phoneOnline]);
}
