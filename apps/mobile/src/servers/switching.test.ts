import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform/secure-store', () => ({ secureStore: {} }));
vi.mock('../platform/seal-keys', () => ({ sealKeys: { remove: () => Promise.resolve() } }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'android' },
}));
vi.mock('./server-check', () => ({ checkServer: vi.fn() }));

import type { SecureKeyValue } from '../auth/storage';
import { createTwringApi } from '../api/client';
import { selfhostAuth } from './auth';
import { createProfileStore, type SelfhostProfile } from './profiles';
import type { ServerCheckResult } from './server-check';
import { createSwitching } from './switching';

const CHANGED =
  'This address now answers as a different server. Pair this phone again with a new code.';

function fakeStorage(): SecureKeyValue {
  const data = new Map<string, string>();
  return {
    getItemAsync: (k) => Promise.resolve(data.get(k) ?? null),
    setItemAsync: (k, v) => Promise.resolve(void data.set(k, v)),
    deleteItemAsync: (k) => Promise.resolve(void data.delete(k)),
  };
}

const home: SelfhostProfile = {
  kind: 'selfhost',
  serverId: 'srv_1',
  address: 'https://home.example.com',
  name: 'Home',
  publicKey: 'pk',
  person: { id: 'per_1', displayName: 'Ann', role: 'admin' },
  deviceId: 'dev1',
  audio: 'own',
};

const ok: ServerCheckResult = {
  ok: true,
  info: {} as never,
  publicKey: 'pk',
};

async function setup(check: ServerCheckResult = ok, hostedSignedIn = false) {
  const made = await setupUnchecked(check, hostedSignedIn);
  // The identity check of this activation passed.
  made.auth.markChecked(home.serverId);
  return made;
}

async function setupUnchecked(check: ServerCheckResult = ok, hostedSignedIn = false) {
  const store = createProfileStore(fakeStorage());
  await store.save(home, { deviceToken: 'twd_secret', sealKey: 'seal' });
  await store.activate(home.serverId);
  const hosted = { signedIn: hostedSignedIn, signOut: vi.fn(() => Promise.resolve()) };
  const rings = { stop: vi.fn(() => Promise.resolve()), start: vi.fn(() => Promise.resolve()) };
  const beforeSignOut = vi.fn(() => Promise.resolve());
  const sealKeys = { remove: vi.fn(() => Promise.resolve()) };
  const fetch = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 })),
  );
  const checkFn = vi.fn(() => Promise.resolve(check));
  let now = 0;
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = vi.fn((fn: () => void, ms: number) => {
    const timer = { fn, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  });
  // eslint-disable-next-line prefer-const
  let switching: ReturnType<typeof createSwitching>;
  const auth = selfhostAuth(store, {
    leave: (id, remove) => switching.signOutOfServer(id, remove),
  });
  switching = createSwitching({
    store,
    auth,
    sealKeys,
    beforeSignOut,
    hosted: () => hosted,
    check: checkFn,
    fetch,
    rings: () => rings,
    now: () => now,
    setTimer,
  });
  await auth.start();
  return {
    store,
    auth,
    switching,
    hosted,
    rings,
    beforeSignOut,
    sealKeys,
    fetch,
    checkFn,
    advance: (ms: number) => (now += ms),
    /** Waits still pending, in order. */
    pending: () => timers.filter((t) => !t.cancelled),
    /** Runs the next pending wait and the check it starts. */
    fireNext: async () => {
      const next = timers.find((t) => !t.cancelled);
      if (next === undefined) throw new Error('no wait pending');
      next.cancelled = true;
      next.fn();
      await switching.checkActiveServer();
    },
  };
}

describe('switching servers', () => {
  it('round trip keeps the profile and stops then starts rings once each', async () => {
    const { store, auth, switching, rings, beforeSignOut } = await setup();
    await switching.switchToHosted();
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(store.list()).toEqual([home]);
    expect(auth.notice()).toBeUndefined();
    const result = await switching.switchToServer('srv_1');
    expect(result.ok).toBe(true);
    expect(store.active()).toEqual(home);
    expect(auth.state()).toMatchObject({ status: 'signed_in', userId: 'per_1' });
    expect(rings.stop).toHaveBeenCalledOnce();
    expect(rings.stop).toHaveBeenCalledWith('srv_1');
    expect(rings.start).toHaveBeenCalledOnce();
    expect(rings.start).toHaveBeenCalledWith('srv_1');
    expect(beforeSignOut).toHaveBeenCalledTimes(2);
  });

  it('switching to a server signs out of hosted when signed in there', async () => {
    const { switching, hosted, beforeSignOut } = await setup(ok, true);
    await switching.switchToHosted();
    beforeSignOut.mockClear();
    await switching.switchToServer('srv_1');
    expect(hosted.signOut).toHaveBeenCalledOnce();
    // Hosted sign-out runs the hooks itself.
    expect(beforeSignOut).not.toHaveBeenCalled();
  });

  it('does not switch to a server that changed', async () => {
    const changed: ServerCheckResult = { ok: false, reason: 'changed', message: CHANGED };
    const { store, switching, hosted } = await setup(changed, true);
    await switching.switchToHosted();
    const result = await switching.switchToServer('srv_1');
    expect(result).toEqual(changed);
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(hosted.signOut).not.toHaveBeenCalled();
  });

  it('leaving deletes this phone on the server, then removes everything here', async () => {
    const { store, switching, sealKeys, fetch } = await setup();
    await switching.leaveServer();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://home.example.com/v1/me/paired-devices/dev1');
    expect(init?.method).toBe('DELETE');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer twd_secret');
    expect(init?.redirect).toBe('error');
    expect(store.list()).toEqual([]);
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(await store.secrets('srv_1')).toBeUndefined();
    expect(sealKeys.remove).toHaveBeenCalledWith('srv_1');
  });

  it('leaving stops rings before deleting this phone, and runs nothing after the delete', async () => {
    const { switching, fetch, rings, beforeSignOut } = await setup();
    const order: string[] = [];
    rings.stop.mockImplementation(() => Promise.resolve(void order.push('rings.stop')));
    beforeSignOut.mockImplementation(() => Promise.resolve(void order.push('beforeSignOut')));
    fetch.mockImplementation((url: string) => {
      order.push(`fetch ${url}`);
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await switching.leaveServer();
    const deleted = order.indexOf('fetch https://home.example.com/v1/me/paired-devices/dev1');
    expect(deleted).toBeGreaterThan(-1);
    expect(order.indexOf('rings.stop')).toBeGreaterThan(-1);
    expect(order.indexOf('rings.stop')).toBeLessThan(deleted);
    expect(order.indexOf('beforeSignOut')).toBeLessThan(deleted);
    // Nothing after the phone's delete: its key no longer works.
    expect(order.slice(deleted + 1)).toEqual([]);
    expect(rings.stop).toHaveBeenCalledOnce();
    expect(beforeSignOut).toHaveBeenCalledOnce();
  });

  it('leaving removes everything here even when the server cannot be reached', async () => {
    const { store, switching, fetch, sealKeys } = await setup();
    fetch.mockRejectedValue(new TypeError('offline'));
    await switching.leaveServer();
    expect(store.list()).toEqual([]);
    expect(sealKeys.remove).toHaveBeenCalledWith('srv_1');
  });

  it('a changed server on start signs out, keeps the profile, leaves hosted alone', async () => {
    const changed: ServerCheckResult = { ok: false, reason: 'changed', message: CHANGED };
    const { store, auth, switching, hosted, checkFn } = await setup(changed);
    await switching.checkActiveServer();
    expect(checkFn).toHaveBeenCalledWith(home.address, {
      serverId: 'srv_1',
      publicKey: 'pk',
    });
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(store.list()).toEqual([home]);
    expect(auth.notice()).toBe(CHANGED);
    expect(hosted.signOut).not.toHaveBeenCalled();
  });

  it('an offline start keeps the person signed in', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { store, auth, switching } = await setup(offline);
    await switching.checkActiveServer();
    expect(store.active()).toEqual(home);
    expect(auth.state()).toMatchObject({ status: 'signed_in' });
  });

  it('checks at most every 10 minutes on return to the front', async () => {
    const { switching, checkFn, advance } = await setup();
    await switching.checkActiveServer();
    await switching.checkActiveServer({ throttled: true });
    expect(checkFn).toHaveBeenCalledOnce();
    advance(10 * 60_000);
    await switching.checkActiveServer({ throttled: true });
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  it('does nothing with hosted active', async () => {
    const { store, switching, checkFn } = await setup();
    await store.activate('hosted');
    await switching.checkActiveServer();
    expect(checkFn).not.toHaveBeenCalled();
  });

  it('a request during the start check carries no token; after changed none ever does', async () => {
    let resolve!: (r: ServerCheckResult) => void;
    const { auth, switching, checkFn } = await setupUnchecked();
    checkFn.mockReturnValue(new Promise((r) => (resolve = r)));
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ agents: [] }), { status: 200 })),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    const checking = switching.checkActiveServer();
    await api.listAgents().catch(() => undefined);
    resolve({ ok: false, reason: 'changed', message: CHANGED });
    await checking;
    await api.listAgents().catch(() => undefined);
    for (const [, init] of fetch.mock.calls) {
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    }
  });

  it('after an ok start check requests carry the token', async () => {
    const { auth, switching } = await setupUnchecked();
    await switching.checkActiveServer();
    expect(auth.api.token()).toBe('twd_secret');
  });

  it('an unreachable start check holds the token but shows the person signed in', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { auth, store, switching } = await setupUnchecked(offline);
    await switching.checkActiveServer();
    expect(auth.api.token()).toBeUndefined();
    expect(auth.state()).toMatchObject({ status: 'signed_in', userId: 'per_1' });
    expect(store.list()).toEqual([home]);
    expect(store.active()).toEqual(home);
  });

  it('a 503 identity answer: requests carry no token, a 401 keeps the profile, ok releases', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { auth, store, switching, checkFn, fireNext } = await setupUnchecked(offline);
    await switching.checkActiveServer();
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'auth_required', message: 'no', request_id: 'r' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    await api.listAgents().catch(() => undefined);
    expect((fetch.mock.calls[0][1].headers as Record<string, string>).authorization).toBe(
      undefined,
    );
    expect(store.list()).toEqual([home]);
    expect(store.active()).toEqual(home);
    checkFn.mockResolvedValue(ok);
    await fireNext();
    expect(auth.api.token()).toBe('twd_secret');
  });

  it('an unreachable server is checked again after 15 s, 30 s, 60 s, then every 5 minutes', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { switching, checkFn, pending, fireNext } = await setupUnchecked(offline);
    await switching.checkActiveServer();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(pending()).toHaveLength(1);
      waits.push(pending()[0].ms);
      await fireNext();
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 300_000, 300_000]);
    expect(checkFn).toHaveBeenCalledTimes(6);
    checkFn.mockResolvedValue(ok);
    await fireNext();
    expect(pending()).toHaveLength(0);
  });

  it('a held server is checked again on return to the front even after a recent pass', async () => {
    const { switching, checkFn, auth } = await setupUnchecked();
    await switching.checkActiveServer();
    checkFn.mockResolvedValue({ ok: false, reason: 'unreachable', message: 'x' });
    await switching.checkActiveServer();
    expect(auth.api.token()).toBeUndefined();
    await switching.checkActiveServer({ throttled: true });
    expect(checkFn).toHaveBeenCalledTimes(3);
  });

  it('a switch runs one identity check', async () => {
    const { switching, checkFn, auth } = await setup();
    await switching.switchToHosted();
    await switching.switchToServer('srv_1');
    await switching.checkActiveServer({ throttled: true });
    expect(checkFn).toHaveBeenCalledOnce();
    expect(auth.api.token()).toBe('twd_secret');
  });

  it('forgetting a saved server removes it, its secrets and its seal key, asking no one', async () => {
    const { store, switching, sealKeys, fetch, checkFn } = await setup();
    await switching.switchToHosted();
    await switching.forgetServer('srv_1');
    expect(store.list()).toEqual([]);
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(await store.secrets('srv_1')).toBeUndefined();
    expect(sealKeys.remove).toHaveBeenCalledWith('srv_1');
    expect(fetch).not.toHaveBeenCalled();
    expect(checkFn).not.toHaveBeenCalled();
  });

  it('leaving skips the DELETE when the server changed, and still removes locally', async () => {
    const changed: ServerCheckResult = { ok: false, reason: 'changed', message: CHANGED };
    const { store, switching, fetch, sealKeys, checkFn } = await setup(changed);
    await switching.leaveServer();
    expect(checkFn).toHaveBeenCalledWith(home.address, { serverId: 'srv_1', publicKey: 'pk' });
    expect(fetch).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(sealKeys.remove).toHaveBeenCalledWith('srv_1');
  });

  it('leaving skips the DELETE when the server is unreachable', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { store, switching, fetch } = await setup(offline);
    await switching.leaveServer();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.list()).toEqual([]);
  });

  it('an unreachable check does not start the 10 minute wait', async () => {
    const offline: ServerCheckResult = { ok: false, reason: 'unreachable', message: 'x' };
    const { switching, checkFn } = await setup(offline);
    await switching.checkActiveServer();
    await switching.checkActiveServer({ throttled: true });
    expect(checkFn).toHaveBeenCalledTimes(2);
  });

  it('two checks at once run one request', async () => {
    const { switching, checkFn } = await setup();
    await Promise.all([
      switching.checkActiveServer(),
      switching.checkActiveServer({ throttled: true }),
    ]);
    expect(checkFn).toHaveBeenCalledOnce();
  });
});
