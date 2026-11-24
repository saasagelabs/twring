import type { MediaItem, MediaPageResponse } from '@twring/contracts';
import { mediaPageResponseSchema } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api', async () => {
  const client = await import('../api/client');
  return {
    ApiError: client.ApiError,
    apiErrorCopy: () => ({ message: 'Something went wrong.', retryable: true }),
    twringApi: () => undefined,
  };
});

vi.mock('@/servers/profiles', () => ({ profileStore: { active: () => ({ kind: 'hosted' }) } }));

import { ApiError } from '@/api';
import { MediaPager, unavailableList, type ListMedia } from './media';

const item = (id: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  id,
  name: `${id}.jpg`,
  mime_type: 'image/jpeg',
  size_bytes: 10,
  message_id: 'm1',
  direction: 'received',
  created_at: '2026-11-20T10:00:00.000Z',
  ...extra,
});

function deferred() {
  const calls: {
    options: { cursor?: string; limit?: number };
    signal: AbortSignal;
    resolve: (page: MediaPageResponse) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  const list: ListMedia = (_agent, options, signal) =>
    new Promise((resolve, reject) => calls.push({ options, signal, resolve, reject }));
  return { calls, list };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MediaPager', () => {
  it('pages with next_cursor and dedupes items across pages', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    expect(pager.current.status).toBe('loading');
    calls[0].resolve({ items: [item('f1'), item('f2')], next_cursor: 'c1' });
    await flush();
    expect(pager.current).toMatchObject({ status: 'ready', hasMore: true });
    pager.loadMore();
    pager.loadMore(); // ignored while one is in flight
    expect(calls).toHaveLength(2);
    expect(calls[1].options.cursor).toBe('c1');
    calls[1].resolve({ items: [item('f2'), item('f3')], next_cursor: null });
    await flush();
    expect(pager.current.items.map((entry) => entry.id)).toEqual(['f1', 'f2', 'f3']);
    expect(pager.current.hasMore).toBe(false);
    pager.loadMore();
    expect(calls).toHaveLength(2);
  });

  it('aborts its request on dispose and ignores a late answer', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    const seen = vi.fn();
    pager.subscribe(seen);
    pager.refresh();
    seen.mockClear();
    pager.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve({ items: [item('f1')], next_cursor: null });
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });

  it('on a self-hosted server a 404 is the calm "not yet" note', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list, () => true);
    pager.refresh();
    calls[0].reject(new ApiError('http', 'not_found', undefined, undefined, 404));
    await flush();
    expect(pager.current.status).toBe('not_yet');
    expect(pager.current.error).toBeUndefined();
  });

  it('shows an error without retrying by itself, and retries on request', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].reject(new ApiError('network'));
    await flush();
    expect(pager.current.status).toBe('error');
    await flush();
    expect(calls).toHaveLength(1);
    pager.refresh();
    calls[1].resolve({ items: [], next_cursor: null });
    await flush();
    expect(pager.current).toMatchObject({ status: 'ready', items: [] });
  });

  it('keeps the list when loading older fails', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].resolve({ items: [item('f1')], next_cursor: 'c1' });
    await flush();
    pager.loadMore();
    calls[1].reject(new ApiError('network'));
    await flush();
    expect(pager.current.items).toHaveLength(1);
    expect(pager.current.moreError).toBeDefined();
    expect(pager.current.loadingMore).toBe(false);
  });

  it('a pull to refresh cancels a load of older items', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].resolve({ items: [item('f1')], next_cursor: 'c1' });
    await flush();
    pager.loadMore();
    pager.refresh();
    expect(calls[1].signal.aborted).toBe(true);
    expect(pager.current.refreshing).toBe(true);
  });

  it('the contract schema rejects a malformed page', () => {
    expect(
      mediaPageResponseSchema.safeParse({ items: [{ id: 'x' }], next_cursor: null }).success,
    ).toBe(false);
    expect(mediaPageResponseSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('a malformed response from the client becomes an error state', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].reject(new ApiError('invalid_response'));
    await flush();
    expect(pager.current.status).toBe('error');
  });

  it('ignores a late load of older items that a refresh replaced', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].resolve({ items: [item('f1')], next_cursor: 'c1' });
    await flush();
    pager.loadMore();
    pager.refresh();
    calls[1].resolve({ items: [item('old')], next_cursor: 'c2' });
    calls[2].resolve({ items: [item('f0'), item('f1')], next_cursor: null });
    await flush();
    expect(pager.current.items.map((entry) => entry.id)).toEqual(['f0', 'f1']);
    expect(pager.current).toMatchObject({ hasMore: false, loadingMore: false, refreshing: false });
    pager.loadMore();
    expect(calls).toHaveLength(3);
  });

  it('a second refresh wins over a slower first one', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    pager.refresh();
    expect(calls[0].signal.aborted).toBe(true);
    calls[1].resolve({ items: [item('new')], next_cursor: null });
    calls[0].resolve({ items: [item('stale')], next_cursor: 'c9' });
    await flush();
    expect(pager.current.items.map((entry) => entry.id)).toEqual(['new']);
    expect(pager.current.hasMore).toBe(false);
  });

  it('asks for the first page without a cursor', () => {
    const { calls, list } = deferred();
    new MediaPager('a1', list).refresh();
    expect(calls[0].options).toEqual({ limit: 30 });
  });

  it('a signed-out 401 is an error, not the "not yet" note', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
    pager.refresh();
    calls[0].reject(new ApiError('http', 'auth_required', undefined, undefined, 401));
    await flush();
    expect(pager.current.status).toBe('error');
  });

  it('on the hosted server a 404 on refresh means the agent is gone and clears the list', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list, () => false);
    pager.refresh();
    calls[0].resolve({ items: [item('f1')], next_cursor: null });
    await flush();
    pager.refresh();
    calls[1].reject(new ApiError('http', 'not_found', undefined, undefined, 404));
    await flush();
    expect(pager.current).toMatchObject({ status: 'gone', items: [] });
  });

  it('on the hosted server a first-load 404 is "gone", never "not yet"', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list, () => false);
    pager.refresh();
    calls[0].reject(new ApiError('http', 'not_found', undefined, undefined, 404));
    await flush();
    expect(pager.current.status).toBe('gone');
  });

  it('a 404 while loading older items is also "gone" on the hosted server', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list, () => false);
    pager.refresh();
    calls[0].resolve({ items: [item('f1')], next_cursor: 'c1' });
    await flush();
    pager.loadMore();
    calls[1].reject(new ApiError('http', 'not_found', undefined, undefined, 404));
    await flush();
    expect(pager.current).toMatchObject({ status: 'gone', items: [] });
  });

  it('with no list call (signed out) the first load is the general error', async () => {
    const pager = new MediaPager('a1', unavailableList, () => true);
    pager.refresh();
    await flush();
    expect(pager.current.status).toBe('error');
  });
});
