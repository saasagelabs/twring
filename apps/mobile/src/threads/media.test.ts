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

import { ApiError } from '@/api';
import { MediaPager, type ListMedia } from './media';

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

  it('maps a 404 to the calm "not yet" state', async () => {
    const { calls, list } = deferred();
    const pager = new MediaPager('a1', list);
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
});
