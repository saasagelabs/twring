import type { E2eDevice } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ensureDeviceKey, type E2eConfig, type TrustedDevice } from './keys';
import { PENDING_MAX_MS, reconcileDevices, settlePending, syncDevices } from './sync';
import { baseConfig } from './test-fixtures';

const key = (c: string) => `${c.repeat(42)}A`;
const id = (c: string) => `dev_${c.repeat(20)}`;

const t = (c: string): TrustedDevice => ({
  id: id(c),
  kind: 'phone',
  name: 'Pixel',
  public_key: key(c),
  verified_at: '2026-11-24T00:00:00.000Z',
});
const s = (c: string, extra: Partial<E2eDevice> = {}): E2eDevice => ({
  id: id(c),
  kind: 'phone',
  name: 'Pixel',
  public_key: key(c),
  added_at: '2026-11-24T00:00:00.000Z',
  ...extra,
});

describe('reconcileDevices', () => {
  it('drops revoked, ignores unverified, keeps trusted during an outage', () => {
    const out = reconcileDevices(
      [t('a'), t('b')],
      [s('a', { revoked_at: '2026-11-24T00:00:00.000Z' }), s('x')],
    );
    expect(out.trusted.map((d) => d.id)).toEqual([id('b')]);
    expect(out.revoked).toEqual([id('a')]);
    expect(out.unverified.map((d) => d.id)).toEqual([id('x')]);
  });

  it('never trusts a key the server swapped under a trusted id', () => {
    const out = reconcileDevices([t('a')], [s('a', { public_key: key('z') })]);
    expect(out.trusted).toEqual([t('a')]);
    expect(out.unverified).toEqual([]);
  });

  it('does not list this computer as unverified', () => {
    expect(reconcileDevices([], [s('c', { kind: 'computer' })], id('c')).unverified).toEqual([]);
  });
});

describe('settlePending', () => {
  const now = Date.parse('2026-11-24T00:00:00.000Z');
  it('trusts a phone this computer checked once the server lists it with the same key', () => {
    const out = settlePending([t('a')], [s('a')], now);
    expect(out.confirmed).toEqual([t('a')]);
    expect(out.pending).toEqual([]);
  });

  it('drops a pending phone the server revoked, listed with another key, or never added', () => {
    const late = now + PENDING_MAX_MS + 1;
    expect(
      settlePending([t('a')], [s('a', { revoked_at: '2026-11-24T00:00:00.000Z' })], now),
    ).toEqual({ confirmed: [], pending: [] });
    expect(settlePending([t('a')], [s('a', { public_key: key('z') })], now)).toEqual({
      confirmed: [],
      pending: [],
    });
    expect(settlePending([t('a')], [], late)).toEqual({ confirmed: [], pending: [] });
  });

  it('keeps a recent pending phone the server does not list yet', () => {
    expect(settlePending([t('a')], [], now + 1_000)).toEqual({ confirmed: [], pending: [t('a')] });
  });
});

describe('syncDevices', () => {
  function setup(response: () => Response) {
    let e2e: E2eConfig = { ...ensureDeviceKey(baseConfig).config.e2e!, devices: [t('a'), t('b')] };
    const urls: string[] = [];
    const fetchImpl = ((input: string | URL) => {
      urls.push(String(input));
      return Promise.resolve(response());
    }) as typeof fetch;
    const run = () =>
      syncDevices({
        server: baseConfig.server,
        token: baseConfig.token,
        fetch: fetchImpl,
        now: () => Date.parse('2026-11-24T00:01:00.000Z'),
        persist: (change) => {
          e2e = change(e2e);
          return Promise.resolve(e2e);
        },
      });
    return { run, urls, e2e: () => e2e, set: (next: E2eConfig) => (e2e = next) };
  }

  it('removes a device revoked on the server and saves it', async () => {
    const env = setup(
      () =>
        new Response(
          JSON.stringify({ devices: [s('a', { revoked_at: '2026-11-24T00:00:00.000Z' }), s('b')] }),
          { status: 200 },
        ),
    );
    expect(await env.run()).toEqual({ revoked: 1, unverified: 0, added: 0 });
    expect(env.e2e().devices.map((d) => d.id)).toEqual([id('b')]);
    expect(env.urls).toEqual(['https://api.twring.com/v1/e2e/computer/devices?notes=1']);
  });

  it('finishes a pairing whose last save failed once the server lists the phone', async () => {
    const env = setup(
      () => new Response(JSON.stringify({ devices: [s('a'), s('b'), s('c')] }), { status: 200 }),
    );
    env.set({ ...env.e2e(), pending: [t('c')] });
    await env.run();
    expect(env.e2e().devices.map((d) => d.id)).toEqual([id('a'), id('b'), id('c')]);
    expect(env.e2e().pending ?? []).toEqual([]);
  });

  it('changes nothing when the server cannot be reached or refuses', async () => {
    for (const response of [
      () => new Response('nope', { status: 503 }),
      () => new Response(JSON.stringify({ devices: 'x' }), { status: 200 }),
    ]) {
      const env = setup(response);
      expect(await env.run()).toBeUndefined();
      expect(env.e2e().devices).toHaveLength(2);
    }
  });
});
