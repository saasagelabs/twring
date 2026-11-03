import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthBackendError } from './controller';
import { chunkedSecureStorage, type SecureKeyValue } from './storage';
import { supabaseBackend } from './supabase-backend';

// The real Supabase client against a scripted Auth server: what a failed refresh means for the
// signed-in user (ADR-021). Offline, rate limits, and Supabase outages keep the session; a refused
// refresh token ends it.

const URL = 'https://cord-test.supabase.invalid';
const USER = {
  id: '8f1c2a52-0000-4000-8000-000000000001',
  email: 'a@example.com',
  aud: 'authenticated',
};

class MemoryStore implements SecureKeyValue {
  readonly items = new Map<string, string>();
  getItemAsync(key: string) {
    return Promise.resolve(this.items.get(key) ?? null);
  }
  setItemAsync(key: string, value: string) {
    this.items.set(key, value);
    return Promise.resolve();
  }
  deleteItemAsync(key: string) {
    this.items.delete(key);
    return Promise.resolve();
  }
}

function session(accessToken: string, expiresInS: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: accessToken,
    refresh_token: `refresh-for-${accessToken}`,
    token_type: 'bearer',
    expires_in: expiresInS,
    expires_at: now + expiresInS,
    user: USER,
  };
}

type Answer = { status: number; body?: object } | 'offline';

const clients: { stopAutoRefresh(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stopAutoRefresh();
});

async function signedInClient(refreshAnswer: Answer | Promise<Answer>) {
  const store = new MemoryStore();
  const storage = chunkedSecureStorage(store);
  await storage.setItem('cord.auth', JSON.stringify(session('tok-1', 3600)));
  const refreshes: string[] = [];
  const fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('grant_type=refresh_token')) return new Response(null, { status: 204 });
    refreshes.push(url);
    const answer = await refreshAnswer;
    if (answer === 'offline') throw new TypeError('Network request failed');
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const supabase = createClient(URL, 'sb_publishable_test', {
    auth: {
      storage,
      storageKey: 'cord.auth',
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
    },
    global: { fetch },
  });
  clients.push(supabase.auth);
  const backend = supabaseBackend(supabase.auth);
  expect((await backend.getSession())?.accessToken).toBe('tok-1');
  return { backend, refreshes, store };
}

/** A signed-in client whose refresh request waits until the test answers it. */
async function signedInClientWithHeldRefresh() {
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => (release = resolve));
  const client = await signedInClient(held);
  return {
    ...client,
    releaseRefresh: (body: object) => release({ status: 200, body }),
  };
}

/** Runs `start` with fake timers advanced until it settles (Supabase's retry backoff). */
async function withFakeClock<T>(start: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    let settled: PromiseSettledResult<T> | undefined;
    start().then(
      (value) => (settled = { status: 'fulfilled', value }),
      (reason: unknown) => (settled = { status: 'rejected', reason }),
    );
    for (let step = 0; step < 600 && settled === undefined; step += 1) {
      await vi.advanceTimersByTimeAsync(250);
    }
    if (settled === undefined) throw new Error('refresh never settled');
    return settled;
  } finally {
    vi.useRealTimers();
  }
}

describe('supabase backend refresh', () => {
  it('reads a trimmed display name from user metadata', async () => {
    const { backend } = await signedInClient({
      status: 200,
      body: {
        ...session('tok-2', 3600),
        user: { ...USER, user_metadata: { full_name: '  Alex Smith  ', name: 'Other' } },
      },
    });
    await expect(backend.refresh()).resolves.toMatchObject({ name: 'Alex Smith' });
  });

  it('falls back to the metadata name', async () => {
    const { backend } = await signedInClient({
      status: 200,
      body: {
        ...session('tok-2', 3600),
        user: { ...USER, user_metadata: { name: '  Alex  ' } },
      },
    });
    await expect(backend.refresh()).resolves.toMatchObject({ name: 'Alex' });
  });

  it('returns the fresh session', async () => {
    const { backend } = await signedInClient({ status: 200, body: session('tok-2', 3600) });
    await expect(backend.refresh()).resolves.toMatchObject({
      accessToken: 'tok-2',
      userId: USER.id,
    });
  });

  it.each<[string, Answer]>([
    ['offline', 'offline'],
    ['a Supabase outage (503)', { status: 503, body: { msg: 'unavailable' } }],
    ['rate limited (429)', { status: 429, body: { code: 'over_request_rate_limit', msg: 'slow' } }],
    ['a Supabase server error (500)', { status: 500, body: { msg: 'boom' } }],
  ])('keeps the user signed in when the refresh fails because %s', async (_name, answer) => {
    const { backend, refreshes } = await signedInClient(answer);
    // Supabase retries passing failures with backoff; run its clock fast.
    const outcome = await withFakeClock(() => backend.refresh());
    expect(outcome).toEqual({ status: 'rejected', reason: new AuthBackendError('network') });
    expect(refreshes.length).toBeGreaterThan(0);
    // Supabase kept the session; the app must not throw it away either.
    expect((await backend.getSession())?.accessToken).toBe('tok-1');
  });

  it.each<[string, Answer]>([
    ['revoked', { status: 400, body: { code: 'refresh_token_not_found', msg: 'Invalid' } }],
    ['reused', { status: 400, body: { code: 'refresh_token_already_used', msg: 'Used' } }],
    ['for a deleted user', { status: 403, body: { code: 'user_not_found', msg: 'gone' } }],
  ])('ends the session when the refresh token is %s', async (_name, answer) => {
    const { backend } = await signedInClient(answer);
    const outcome = await withFakeClock(() => backend.refresh());
    expect(outcome).toEqual({ status: 'fulfilled', value: null });
  });

  it('shares one refresh between concurrent 401s (single flight)', async () => {
    const { backend, refreshes } = await signedInClient({
      status: 200,
      body: session('tok-2', 3600),
    });
    const tokens = await Promise.all([backend.refresh(), backend.refresh(), backend.refresh()]);
    expect(tokens.map((next) => next?.accessToken)).toEqual(['tok-2', 'tok-2', 'tok-2']);
    expect(refreshes).toHaveLength(1);
  });

  it('a sign-out during a refresh wins: the rotated session is not stored', async () => {
    const { backend, store, releaseRefresh } = await signedInClientWithHeldRefresh();
    const refreshing = backend.refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await backend.signOut();
    releaseRefresh(session('tok-2', 3600));
    await expect(refreshing).resolves.toBeNull();
    expect(await backend.getSession()).toBeNull();
    expect([...store.items.keys()].filter((key) => key.startsWith('cord.auth'))).toEqual([]);
  });

  it('ends the session when there is none to refresh', async () => {
    const { backend } = await signedInClient({ status: 200, body: session('tok-2', 3600) });
    await backend.signOut();
    await expect(backend.refresh()).resolves.toBeNull();
  });
});

describe('supabase backend Apple sign-in', () => {
  /** A client whose Auth server answers an ID-token sign-in and a profile update. */
  function appleClient(user: object = USER) {
    const requests: { url: string; method: string; body: unknown }[] = [];
    const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      const json = url.includes('grant_type=id_token')
        ? { ...session('tok-apple', 3600), user }
        : { ...user, user_metadata: { full_name: 'Alex Smith' } };
      return Promise.resolve(
        new Response(JSON.stringify(json), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const supabase = createClient(URL, 'sb_publishable_test', {
      auth: {
        storage: chunkedSecureStorage(new MemoryStore()),
        storageKey: 'cord.auth',
        autoRefreshToken: false,
        persistSession: true,
        detectSessionInUrl: false,
      },
      global: { fetch },
    });
    clients.push(supabase.auth);
    return { backend: supabaseBackend(supabase.auth), requests };
  }

  it('sends the raw nonce with the Apple token and keeps the first-time name', async () => {
    const { backend, requests } = appleClient();
    const signedIn = await backend.signInWithIdToken('apple-id-token', {
      provider: 'apple',
      nonce: 'raw-nonce',
      name: { full: 'Alex Smith', given: 'Alex', family: 'Smith' },
    });
    expect(signedIn).toMatchObject({ accessToken: 'tok-apple', name: 'Alex Smith' });
    expect(requests[0]?.body).toMatchObject({
      provider: 'apple',
      id_token: 'apple-id-token',
      nonce: 'raw-nonce',
    });
    const update = requests.find((request) => request.method === 'PUT');
    expect(update?.body).toMatchObject({
      data: { full_name: 'Alex Smith', given_name: 'Alex', family_name: 'Smith' },
    });
  });

  it('does not touch the profile when Apple gave no name or the account has one', async () => {
    const noName = appleClient();
    await noName.backend.signInWithIdToken('t', { provider: 'apple', nonce: 'n' });
    expect(noName.requests.some((request) => request.method === 'PUT')).toBe(false);

    const named = appleClient({ ...USER, user_metadata: { full_name: 'Kept Name' } });
    const signedIn = await named.backend.signInWithIdToken('t', {
      provider: 'apple',
      nonce: 'n',
      name: { full: 'Alex Smith' },
    });
    expect(signedIn.name).toBe('Kept Name');
    expect(named.requests.some((request) => request.method === 'PUT')).toBe(false);
  });

  it('marks an account that signs in with Apple, so deleting it ends Sign in with Apple', async () => {
    const apple = appleClient({
      ...USER,
      app_metadata: { provider: 'apple', providers: ['apple'] },
    });
    await expect(
      apple.backend.signInWithIdToken('t', { provider: 'apple', nonce: 'n' }),
    ).resolves.toMatchObject({ apple: true });

    const linked = appleClient({
      ...USER,
      app_metadata: { provider: 'google', providers: ['google', 'apple'] },
    });
    await expect(linked.backend.signInWithIdToken('t')).resolves.toMatchObject({ apple: true });

    const google = appleClient({
      ...USER,
      app_metadata: { provider: 'google', providers: ['google'] },
    });
    expect((await google.backend.signInWithIdToken('t')).apple).toBeUndefined();
  });
});
