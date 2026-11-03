import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform/secure-store', () => ({ secureStore: {} }));

import { createTwringApi } from '../api/client';
import type { SecureKeyValue } from '../auth/storage';
import { selfhostAuth } from './auth';
import { createProfileStore, type SelfhostProfile } from './profiles';

const REMOVED = 'This phone was removed from the server. Ask an admin for a new code.';

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setup() {
  const store = createProfileStore(fakeStorage());
  await store.save(home, { deviceToken: 'twd_secret', sealKey: 'seal' });
  await store.activate(home.serverId);
  const leave = vi.fn(async (serverId: string, remove: boolean) => {
    if (remove) await store.remove(serverId);
    else await store.activate('hosted');
  });
  const auth = selfhostAuth(store, { leave });
  await auth.start();
  // The identity check of this activation passed.
  auth.markChecked(home.serverId);
  return { store, auth, leave };
}

describe('self-hosted sign-in', () => {
  it('is signed in as the paired person', async () => {
    const { auth } = await setup();
    expect(auth.state()).toEqual({ status: 'signed_in', userId: 'per_1', name: 'Ann' });
    expect(auth.api.token()).toBe('twd_secret');
  });

  it('is loading until the profiles are read', () => {
    const store = createProfileStore(fakeStorage());
    const auth = selfhostAuth(store, { leave: vi.fn() });
    expect(auth.loaded()).toBe(false);
    expect(auth.state()).toEqual({ status: 'loading' });
  });

  it('sends the device token as a bearer token', async () => {
    const { auth } = await setup();
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(json(200, { agents: [] })),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    await api.listAgents().catch(() => undefined);
    const headers = fetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer twd_secret');
  });

  it('a removed phone signs out once, with no refresh and no second request', async () => {
    const { auth, store, leave } = await setup();
    const refresh = vi.spyOn(auth.api, 'refresh');
    const removed = vi.spyOn(auth.api, 'removed');
    const fetch = vi.fn(() =>
      Promise.resolve(
        json(401, { error: { code: 'device_removed', message: REMOVED, request_id: 'r1' } }),
      ),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    await expect(api.listAgents()).rejects.toMatchObject({ code: 'device_removed' });
    await expect(api.listAgents()).rejects.toMatchObject({ code: 'device_removed' });
    await vi.waitFor(() => expect(store.active()).toEqual({ kind: 'hosted' }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledOnce();
    expect(leave).toHaveBeenCalledWith('srv_1', true);
    expect(store.list()).toEqual([]);
    expect(auth.notice()).toBe(REMOVED);
    expect(auth.api.token()).toBeUndefined();
  });

  it('a removed phone is shown as signed out at once', async () => {
    const { auth } = await setup();
    auth.api.removed(REMOVED);
    expect(auth.state()).toEqual({ status: 'signed_out', notice: REMOVED });
  });

  it('auth_required from a self-hosted server signs out with its message', async () => {
    const { auth, store } = await setup();
    const message = 'Pair this phone with your server first.';
    const refresh = vi.spyOn(auth.api, 'refresh');
    const fetch = vi.fn(() =>
      Promise.resolve(json(401, { error: { code: 'auth_required', message, request_id: 'r1' } })),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    await expect(api.listAgents()).rejects.toMatchObject({ code: 'auth_required' });
    await vi.waitFor(() => expect(store.list()).toEqual([]));
    expect(fetch).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(auth.notice()).toBe(message);
  });

  it('signing out of a changed server keeps its profile', async () => {
    const { auth, store, leave } = await setup();
    const changed =
      'This address now answers as a different server. Pair this phone again with a new code.';
    await auth.endSession(changed, false);
    expect(leave).toHaveBeenCalledWith('srv_1', false);
    expect(store.list()).toEqual([home]);
    expect(store.active()).toEqual({ kind: 'hosted' });
    expect(auth.notice()).toBe(changed);
  });

  it('a later sign-in to a saved server clears the old notice', async () => {
    const { auth, store } = await setup();
    await auth.endSession('gone', false);
    await store.activate(home.serverId);
    await auth.ready();
    auth.markChecked(home.serverId);
    expect(auth.notice()).toBeUndefined();
    expect(auth.state()).toMatchObject({ status: 'signed_in' });
  });

  it('holds the token until the identity check of this activation resolves', async () => {
    const store = createProfileStore(fakeStorage());
    await store.save(home, { deviceToken: 'twd_secret', sealKey: 'seal' });
    await store.activate(home.serverId);
    const auth = selfhostAuth(store, { leave: vi.fn() });
    await auth.start();
    expect(auth.api.token()).toBeUndefined();
    expect(auth.state()).toEqual({ status: 'loading' });
    auth.markChecked(home.serverId);
    expect(auth.api.token()).toBe('twd_secret');
    expect(auth.state()).toMatchObject({ status: 'signed_in' });
  });

  it('a profile whose secrets cannot be read falls back to hosted, kept in the list', async () => {
    const store = createProfileStore(fakeStorage());
    await store.save(home, { deviceToken: 'twd_secret', sealKey: 'seal' });
    await store.activate(home.serverId);
    vi.spyOn(store, 'secrets').mockResolvedValue(undefined);
    const auth = selfhostAuth(store, { leave: vi.fn() });
    await auth.start();
    await vi.waitFor(() => expect(store.active()).toEqual({ kind: 'hosted' }));
    expect(store.list()).toEqual([home]);
    expect(auth.notice()).toBeUndefined();
    expect(auth.state()).toEqual({ status: 'signed_out' });
  });

  it('a failing leave still ends on hosted', async () => {
    const store = createProfileStore(fakeStorage());
    await store.save(home, { deviceToken: 'twd_secret', sealKey: 'seal' });
    await store.activate(home.serverId);
    const auth = selfhostAuth(store, { leave: () => Promise.reject(new Error('boom')) });
    await auth.start();
    auth.markChecked(home.serverId);
    await auth.endSession('gone', false);
    expect(store.active()).toEqual({ kind: 'hosted' });
  });
});

describe('a refusal that arrives after a switch', () => {
  it('is ignored when it answered a token that is not the current one', async () => {
    const { auth, store, leave } = await setup();
    let answer!: (res: Response) => void;
    const fetch = vi.fn(
      (_url: string, _init: RequestInit) => new Promise<Response>((r) => (answer = r)),
    );
    const api = createTwringApi({ baseUrl: home.address, fetch, auth: auth.api });
    const pending = api.listAgents().catch(() => undefined);
    // Re-paired meanwhile: the active server now has another token.
    await store.save(home, { deviceToken: 'twd_new', sealKey: 'seal' });
    await store.activate('hosted');
    await store.activate(home.serverId);
    await auth.ready();
    auth.markChecked(home.serverId);
    expect(auth.api.token()).toBe('twd_new');
    answer(json(401, { error: { code: 'device_removed', message: 'gone', request_id: 'r' } }));
    await pending;
    auth.api.expired('twd_secret');
    expect(leave).not.toHaveBeenCalled();
    expect(store.active()).toEqual(home);
    expect(auth.api.token()).toBe('twd_new');
  });
});
