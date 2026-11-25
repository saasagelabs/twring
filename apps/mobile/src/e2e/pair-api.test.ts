import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'old',
  refresh: vi.fn<() => Promise<string | undefined>>(),
  expired: vi.fn(),
}));
vi.mock('@/auth', () => ({
  apiAuth: () => ({
    token: () => mocks.token,
    refresh: mocks.refresh,
    expired: mocks.expired,
  }),
}));
vi.mock('@/servers/active', () => ({ activeServerUrl: () => 'https://gw.example/' }));

import { pairApi } from './pair-api';

const body = {} as never;
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  mocks.token = 'old';
  mocks.refresh.mockReset().mockResolvedValue('fresh');
  mocks.expired.mockReset();
});

describe('pair api', () => {
  it('refreshes an expired sign-in and retries the claim once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'auth_invalid', message: 'x' } }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const answer = await pairApi().claim('off_1', body);
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://gw.example/v1/e2e/pairings/off_1/claim');
    const retry = fetchMock.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(retry.headers.authorization).toBe('Bearer fresh');
  });

  it('passes other refusals through untouched, with no refresh', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json(410, { error: { code: 'offer_expired' } })),
    );
    expect(await pairApi().claim('off_1', body)).toEqual({
      status: 410,
      body: { error: { code: 'offer_expired' } },
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('returns the refusal when the refresh gives no token, and marks the sign-in expired', async () => {
    mocks.refresh.mockResolvedValue(undefined);
    const refused = { error: { code: 'auth_invalid', message: 'x' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, refused)));
    expect(await pairApi().claim('off_1', body)).toEqual({ status: 401, body: refused });
    expect(mocks.expired).toHaveBeenCalledWith('old');
  });

  it('looks up a typed code by its handle only, refreshing an expired sign-in once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(401, { error: { code: 'auth_invalid', message: 'x' } }))
      .mockResolvedValueOnce(json(404, { error: { code: 'not_found' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pairApi().lookup('7KQ2')).toEqual({
      status: 404,
      body: { error: { code: 'not_found' } },
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://gw.example/v1/e2e/pairings/lookup');
    const sent = fetchMock.mock.calls[1]?.[1] as { method: string; body: string };
    expect(sent.method).toBe('POST');
    expect(JSON.parse(sent.body)).toEqual({ handle: '7KQ2' });
  });
});
