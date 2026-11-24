import type { MediaItem, MediaPageResponse } from '@twring/contracts';
import { useEffect, useRef, useState } from 'react';

import { ApiError, apiErrorCopy, twringApi, type ErrorCopy } from '@/api';
import { profileStore } from '@/servers/profiles';

/** Items per request; the server allows up to 50. */
export const MEDIA_PAGE_SIZE = 30;

export interface MediaState {
  /**
   * `not_yet`: a self-hosted server without this list yet (a 404), shown as a calm note.
   * `gone`: on Twring's hosted server a 404 means the agent was removed (say, on another phone).
   * `error`: the first load failed; `items` stay empty.
   */
  status: 'loading' | 'ready' | 'error' | 'not_yet' | 'gone';
  items: MediaItem[];
  hasMore: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error?: ErrorCopy;
  /** Loading older items failed; the list already shown stays. */
  moreError?: ErrorCopy;
}

export type ListMedia = (
  agentId: string,
  options: { cursor?: string; limit?: number },
  signal: AbortSignal,
) => Promise<MediaPageResponse>;

const INITIAL: MediaState = {
  status: 'loading',
  items: [],
  hasMore: false,
  refreshing: false,
  loadingMore: false,
};

/** True on a self-hosted server, which may run a version without this list. */
export type IsSelfHosted = () => boolean;
const activeIsSelfHosted: IsSelfHosted = () => profileStore.active().kind === 'selfhost';

/** Stands in when signed out or the build has no list call: the general error, never a 404. */
export const unavailableList: ListMedia = () =>
  Promise.reject(new Error('Photos and files are unavailable.'));

export function isMissingRoute(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 404;
}

function merge(existing: readonly MediaItem[], incoming: readonly MediaItem[]): MediaItem[] {
  const seen = new Set(existing.map((item) => item.id));
  const out = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Pages one agent's photos and files, newest first. One request at a time: a refresh cancels a
 * load-more, a load-more is ignored while anything is in flight, and nothing retries on its own.
 */
export class MediaPager {
  private state: MediaState = INITIAL;
  private cursor: string | null = null;
  private inflight: AbortController | undefined;
  private readonly listeners = new Set<(state: MediaState) => void>();
  private disposed = false;

  constructor(
    private readonly agentId: string,
    private readonly list: ListMedia,
    private readonly selfHosted: IsSelfHosted = activeIsSelfHosted,
  ) {}

  get current(): MediaState {
    return this.state;
  }

  subscribe(listener: (state: MediaState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** First load, a retry after an error, or pull to refresh (keeps the list on screen). */
  refresh(): void {
    if (this.disposed) return;
    const refreshing = this.state.status === 'ready';
    this.set({
      ...this.state,
      status: refreshing ? 'ready' : 'loading',
      refreshing,
      loadingMore: false,
      error: undefined,
      moreError: undefined,
    });
    this.fetch(undefined, (page) => {
      this.cursor = page.next_cursor;
      this.set({
        status: 'ready',
        items: merge([], page.items),
        hasMore: page.next_cursor !== null,
        refreshing: false,
        loadingMore: false,
      });
    });
  }

  loadMore(): void {
    if (this.disposed || this.inflight !== undefined) return;
    if (this.state.status !== 'ready' || this.cursor === null) return;
    this.set({ ...this.state, loadingMore: true, moreError: undefined });
    this.fetch(this.cursor, (page) => {
      this.cursor = page.next_cursor;
      this.set({
        ...this.state,
        items: merge(this.state.items, page.items),
        hasMore: page.next_cursor !== null,
        loadingMore: false,
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.inflight?.abort();
    this.inflight = undefined;
    this.listeners.clear();
  }

  private fetch(cursor: string | undefined, apply: (page: MediaPageResponse) => void): void {
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    const options =
      cursor === undefined ? { limit: MEDIA_PAGE_SIZE } : { cursor, limit: MEDIA_PAGE_SIZE };
    this.list(this.agentId, options, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        this.inflight = undefined;
        apply(page);
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        this.inflight = undefined;
        if (isMissingRoute(reason) && !this.selfHosted()) {
          this.cursor = null;
          this.set({ ...INITIAL, status: 'gone' });
        } else if (cursor !== undefined) {
          this.set({ ...this.state, loadingMore: false, moreError: apiErrorCopy(reason) });
        } else if (isMissingRoute(reason)) {
          this.set({ ...INITIAL, status: 'not_yet' });
        } else if (this.state.items.length > 0) {
          // A failed pull to refresh keeps what is on screen and says why.
          this.set({ ...this.state, refreshing: false, moreError: apiErrorCopy(reason) });
        } else {
          this.set({ ...INITIAL, status: 'error', error: apiErrorCopy(reason) });
        }
      },
    );
  }

  private set(next: MediaState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

/** The app's own list call, or undefined when signed out or the build has none. */
function defaultList(): ListMedia | undefined {
  const api = twringApi();
  const listMedia = api?.listMedia?.bind(api);
  return listMedia;
}

export interface Media extends MediaState {
  refresh: () => void;
  loadMore: () => void;
}

/** One agent's photos and files; loads on mount and cancels its request on unmount. */
export function useMedia(
  agentId: string,
  list: ListMedia | undefined = defaultList(),
  selfHosted: IsSelfHosted = activeIsSelfHosted,
): Media {
  const pager = useRef<MediaPager | undefined>(undefined);
  const [state, setState] = useState<MediaState>(INITIAL);
  useEffect(() => {
    const next = new MediaPager(agentId, list ?? unavailableList, selfHosted);
    next.subscribe(setState);
    pager.current = next;
    next.refresh();
    return () => next.dispose();
    // `list` and `selfHosted` are read once per agent: a new function identity must not restart the load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);
  return {
    ...state,
    refresh: () => pager.current?.refresh(),
    loadMore: () => pager.current?.loadMore(),
  };
}
