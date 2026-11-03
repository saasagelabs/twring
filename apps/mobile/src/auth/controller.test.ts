import { describe, expect, it, vi } from 'vitest';

import type { Timers } from '../call/timers';

import {
  AppleSignInError,
  AuthBackendError,
  AuthController,
  GoogleSignInError,
  RESTORE_TIMEOUT_MS,
  SESSION_ENDED_NOTICE,
  withAuth,
  type ApiAuth,
  type AppleSignIn,
  type AuthBackend,
  type AuthSession,
  type GoogleSignIn,
} from './controller';

const SESSION: AuthSession = { accessToken: 'tok-1', userId: 'user-1', email: 'a@example.com' };

function fakeBackend(stored: AuthSession | null = null) {
  let listener: ((session: AuthSession | null) => void) | undefined;
  const backend = {
    getSession: vi.fn(() => Promise.resolve(stored)),
    onChange: vi.fn((next: (session: AuthSession | null) => void) => {
      listener = next;
      return () => undefined;
    }),
    signInWithIdToken: vi.fn((_idToken: string) => Promise.resolve(SESSION)),
    refresh: vi.fn(() => Promise.resolve<AuthSession | null>({ ...SESSION, accessToken: 'tok-2' })),
    signOut: vi.fn(() => Promise.resolve()),
  } satisfies AuthBackend;
  return { backend, emit: (session: AuthSession | null) => listener?.(session) };
}

function fakeGoogle(
  result: Awaited<ReturnType<GoogleSignIn['signIn']>> | Error = {
    type: 'success',
    idToken: 'google-id-token',
  },
) {
  return {
    signIn: vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
    signOut: vi.fn(() => Promise.resolve()),
  } satisfies GoogleSignIn;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('auth controller', () => {
  it('starts loading, then restores a stored session', async () => {
    const { backend } = fakeBackend(SESSION);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    expect(auth.getState()).toEqual({ status: 'loading' });
    auth.start();
    await flush();
    expect(auth.getState()).toEqual({
      status: 'signed_in',
      userId: 'user-1',
      email: 'a@example.com',
    });
    expect(auth.accessToken()).toBe('tok-1');
  });

  it('threads an optional name into signed-in state', async () => {
    const { backend } = fakeBackend({ ...SESSION, name: 'Alex Smith' });
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    await flush();
    expect(auth.getState()).toMatchObject({ status: 'signed_in', name: 'Alex Smith' });
  });

  it('is signed out without a stored session, or when reading it fails', async () => {
    const { backend } = fakeBackend(null);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    await flush();
    expect(auth.getState()).toEqual({ status: 'signed_out' });

    const failing = fakeBackend();
    failing.backend.getSession.mockRejectedValue(new Error('keystore'));
    const other = new AuthController({ backend: failing.backend, google: fakeGoogle() });
    other.start();
    await flush();
    expect(other.getState()).toEqual({ status: 'signed_out' });
  });

  it('signs in with the Google ID token', async () => {
    const { backend } = fakeBackend();
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    await flush();
    await expect(auth.signInWithGoogle()).resolves.toBeUndefined();
    expect(backend.signInWithIdToken).toHaveBeenCalledWith('google-id-token');
    expect(auth.getState().status).toBe('signed_in');
  });

  it('says nothing when the user cancels', async () => {
    const { backend } = fakeBackend();
    const auth = new AuthController({ backend, google: fakeGoogle({ type: 'cancelled' }) });
    await expect(auth.signInWithGoogle()).resolves.toBeUndefined();
    expect(backend.signInWithIdToken).not.toHaveBeenCalled();
  });

  it.each([
    [new GoogleSignInError('play_services'), /Google Play services/],
    [new GoogleSignInError('in_progress'), /already open/],
    [new Error('native'), /couldn't sign you in/],
  ])('explains a Google failure (%s)', async (error, copy) => {
    const auth = new AuthController({ backend: fakeBackend().backend, google: fakeGoogle(error) });
    await expect(auth.signInWithGoogle()).resolves.toMatch(copy);
  });

  it('explains a missing ID token and a refused exchange, and forgets the Google choice', async () => {
    const noToken = new AuthController({
      backend: fakeBackend().backend,
      google: fakeGoogle({ type: 'success', idToken: null }),
    });
    await expect(noToken.signInWithGoogle()).resolves.toMatch(/didn't finish/);

    const { backend } = fakeBackend();
    backend.signInWithIdToken.mockRejectedValue(new AuthBackendError('network'));
    const google = fakeGoogle();
    const auth = new AuthController({ backend, google });
    await expect(auth.signInWithGoogle()).resolves.toMatch(/internet connection/);
    expect(google.signOut).toHaveBeenCalled();
    expect(auth.getState().status).not.toBe('signed_in');
  });

  it('signs out after ending the live call, even if that fails', async () => {
    const { backend } = fakeBackend(SESSION);
    const google = fakeGoogle();
    const order: string[] = [];
    const beforeSignOut = vi.fn(() => {
      order.push('call');
      return Promise.reject(new Error('hang-up failed'));
    });
    backend.signOut.mockImplementation(() => {
      order.push('supabase');
      return Promise.resolve();
    });
    const auth = new AuthController({ backend, google, beforeSignOut });
    auth.start();
    await flush();
    await auth.signOut();
    expect(order).toEqual(['call', 'supabase']);
    expect(google.signOut).toHaveBeenCalled();
    expect(auth.getState()).toEqual({ status: 'signed_out' });
    expect(auth.accessToken()).toBeUndefined();
  });

  it('signs out with a notice when the session expires', async () => {
    const { backend, emit } = fakeBackend(SESSION);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    await flush();
    emit(null); // e.g. Supabase refused the refresh token
    expect(auth.getState()).toEqual({ status: 'signed_out', notice: SESSION_ENDED_NOTICE });

    const second = fakeBackend(SESSION);
    const other = new AuthController({ backend: second.backend, google: fakeGoogle() });
    other.start();
    await flush();
    other.sessionExpired();
    await flush();
    expect(other.getState()).toEqual({ status: 'signed_out', notice: SESSION_ENDED_NOTICE });
  });

  it('refreshes the access token, and reports an ended session as undefined', async () => {
    const { backend } = fakeBackend(SESSION);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    await expect(auth.refreshAccessToken()).resolves.toBe('tok-2');
    expect(auth.accessToken()).toBe('tok-2');
    backend.refresh.mockResolvedValue(null);
    await expect(auth.refreshAccessToken()).resolves.toBeUndefined();
  });
});

/** Timers that fire only when the test says so. */
function manualTimers() {
  const pending = new Map<number, { at: number; fire: () => void }>();
  let now = 0;
  let next = 0;
  const timers: Timers = {
    now: () => now,
    setTimeout(callback, ms) {
      const id = (next += 1);
      pending.set(id, { at: now + ms, fire: callback });
      return () => pending.delete(id);
    },
  };
  return {
    timers,
    pending: () => pending.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.fire();
        }
      }
    },
  };
}

describe('auth controller startup', () => {
  it('leaves the splash for Sign in when the secure store never answers', async () => {
    const { backend } = fakeBackend();
    backend.getSession.mockReturnValue(new Promise<never>(() => undefined));
    const clock = manualTimers();
    const auth = new AuthController({ backend, google: fakeGoogle(), timers: clock.timers });
    auth.start();
    await flush();
    clock.advance(RESTORE_TIMEOUT_MS - 1);
    expect(auth.getState()).toEqual({ status: 'loading' });
    clock.advance(1);
    expect(auth.getState()).toEqual({ status: 'signed_out' });
  });

  it('still signs in from a session read that arrives after the timeout', async () => {
    const { backend } = fakeBackend();
    let resolve!: (session: AuthSession | null) => void;
    backend.getSession.mockReturnValue(new Promise((done) => (resolve = done)));
    const clock = manualTimers();
    const auth = new AuthController({ backend, google: fakeGoogle(), timers: clock.timers });
    auth.start();
    clock.advance(RESTORE_TIMEOUT_MS);
    expect(auth.getState().status).toBe('signed_out');
    resolve(SESSION);
    await flush();
    expect(auth.getState().status).toBe('signed_in');
  });

  it('clears the timeout once the session is read, and a late timer changes nothing', async () => {
    const { backend } = fakeBackend(SESSION);
    const clock = manualTimers();
    const auth = new AuthController({ backend, google: fakeGoogle(), timers: clock.timers });
    auth.start();
    await flush();
    expect(clock.pending()).toBe(0);
    clock.advance(RESTORE_TIMEOUT_MS);
    expect(auth.getState().status).toBe('signed_in');
  });

  it('a late empty read never undoes a sign-in made meanwhile', async () => {
    const { backend } = fakeBackend();
    let resolve!: (session: AuthSession | null) => void;
    backend.getSession.mockReturnValue(new Promise((done) => (resolve = done)));
    const clock = manualTimers();
    const auth = new AuthController({ backend, google: fakeGoogle(), timers: clock.timers });
    auth.start();
    clock.advance(RESTORE_TIMEOUT_MS);
    await auth.signInWithGoogle();
    resolve(null);
    await flush();
    expect(auth.getState().status).toBe('signed_in');
  });

  it('start is idempotent', async () => {
    const { backend } = fakeBackend(SESSION);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    auth.start();
    await flush();
    expect(backend.getSession).toHaveBeenCalledOnce();
    expect(backend.onChange).toHaveBeenCalledOnce();
  });
});

describe('auth controller sign-out races', () => {
  it('a second sign-out while one runs shares it (one call hang-up, one Supabase sign-out)', async () => {
    const { backend } = fakeBackend(SESSION);
    let release!: () => void;
    const beforeSignOut = vi.fn(() => new Promise<void>((done) => (release = done)));
    const auth = new AuthController({ backend, google: fakeGoogle(), beforeSignOut });
    auth.start();
    await flush();
    const first = auth.signOut();
    const second = auth.signOut();
    auth.sessionExpired();
    release();
    await Promise.all([first, second]);
    expect(beforeSignOut).toHaveBeenCalledOnce();
    expect(backend.signOut).toHaveBeenCalledOnce();
    expect(auth.getState()).toEqual({ status: 'signed_out' });
  });

  it('ignores session events that arrive while signing out (e.g. a refresh landing mid-hang-up)', async () => {
    const { backend, emit } = fakeBackend(SESSION);
    let release!: () => void;
    const beforeSignOut = () => new Promise<void>((done) => (release = done));
    const auth = new AuthController({ backend, google: fakeGoogle(), beforeSignOut });
    auth.start();
    await flush();
    const signingOut = auth.signOut();
    emit({ ...SESSION, accessToken: 'tok-refreshed' });
    await expect(auth.refreshAccessToken()).resolves.toBe('tok-2');
    release();
    await signingOut;
    expect(auth.getState()).toEqual({ status: 'signed_out' });
    expect(auth.accessToken()).toBeUndefined();
  });

  it('a request refused after sign-out does not sign out again or show a notice', async () => {
    const { backend } = fakeBackend(SESSION);
    const auth = new AuthController({ backend, google: fakeGoogle() });
    auth.start();
    await flush();
    await auth.signOut();
    auth.sessionExpired();
    await flush();
    expect(backend.signOut).toHaveBeenCalledOnce();
    expect(auth.getState()).toEqual({ status: 'signed_out' });
  });
});

class HttpError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
const codeOf = (error: unknown) =>
  error instanceof HttpError && (error.code === 'auth_invalid' || error.code === 'auth_required')
    ? error.code
    : undefined;

function fakeAuth(overrides: Partial<ApiAuth> = {}) {
  return {
    token: vi.fn(() => 'old'),
    refresh: vi.fn(() => Promise.resolve<string | undefined>('new')),
    expired: vi.fn(),
    ...overrides,
  };
}

describe('withAuth', () => {
  it('sends no header when sign-in is off', async () => {
    const run = vi.fn(() => Promise.resolve('ok'));
    await expect(withAuth(undefined, run, codeOf)).resolves.toBe('ok');
    expect(run).toHaveBeenCalledWith({});
  });

  it('refreshes and retries exactly once on auth_invalid', async () => {
    const auth = fakeAuth();
    const run = vi
      .fn<(headers: Record<string, string>) => Promise<string>>()
      .mockRejectedValueOnce(new HttpError('auth_invalid'))
      .mockResolvedValueOnce('ok');
    await expect(withAuth(auth, run, codeOf)).resolves.toBe('ok');
    expect(run.mock.calls).toEqual([
      [{ authorization: 'Bearer old' }],
      [{ authorization: 'Bearer new' }],
    ]);
    expect(auth.expired).not.toHaveBeenCalled();
  });

  it('signs out when the retry is refused too', async () => {
    const auth = fakeAuth();
    const run = vi.fn(() => Promise.reject(new HttpError('auth_invalid')));
    await expect(withAuth(auth, run, codeOf)).rejects.toEqual(new HttpError('auth_invalid'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(auth.expired).toHaveBeenCalledOnce();
  });

  it('signs out without retrying when the session cannot be refreshed', async () => {
    const auth = fakeAuth({ refresh: vi.fn(() => Promise.resolve(undefined)) });
    const run = vi.fn(() => Promise.reject(new HttpError('auth_invalid')));
    await expect(withAuth(auth, run, codeOf)).rejects.toBeInstanceOf(HttpError);
    expect(run).toHaveBeenCalledOnce();
    expect(auth.expired).toHaveBeenCalledOnce();
  });

  it('stays signed in when the refresh itself fails (offline)', async () => {
    const auth = fakeAuth({ refresh: vi.fn(() => Promise.reject(new Error('offline'))) });
    const run = vi.fn(() => Promise.reject(new HttpError('auth_invalid')));
    await expect(withAuth(auth, run, codeOf)).rejects.toEqual(new HttpError('auth_invalid'));
    expect(auth.expired).not.toHaveBeenCalled();
  });

  it('signs out on auth_required without a refresh, and ignores other failures', async () => {
    const auth = fakeAuth();
    await expect(
      withAuth(auth, () => Promise.reject(new HttpError('auth_required')), codeOf),
    ).rejects.toBeInstanceOf(HttpError);
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(auth.expired).toHaveBeenCalledOnce();

    const other = fakeAuth();
    await expect(
      withAuth(other, () => Promise.reject(new HttpError('auth_unavailable')), codeOf),
    ).rejects.toBeInstanceOf(HttpError);
    expect(other.refresh).not.toHaveBeenCalled();
    expect(other.expired).not.toHaveBeenCalled();
  });
});

function fakeApple(
  result: Awaited<ReturnType<AppleSignIn['signIn']>> | Error = {
    type: 'success',
    idToken: 'apple-id-token',
    nonce: 'raw-nonce',
  },
) {
  return {
    signIn: vi.fn(() =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
    ),
  } satisfies AppleSignIn;
}

describe('iPhone sign-in', () => {
  it('signs in with a session from the browser sign-in, with no ID token exchange', async () => {
    const { backend } = fakeBackend();
    const auth = new AuthController({
      backend,
      google: fakeGoogle({ type: 'session', session: SESSION }),
    });
    await expect(auth.signInWithGoogle()).resolves.toBeUndefined();
    expect(backend.signInWithIdToken).not.toHaveBeenCalled();
    expect(auth.getState()).toMatchObject({ status: 'signed_in', userId: 'user-1' });
  });

  it('offers Apple only when it is wired (the iPhone)', () => {
    const { backend } = fakeBackend();
    expect(new AuthController({ backend, google: fakeGoogle() }).appleAvailable).toBe(false);
    expect(
      new AuthController({ backend, google: fakeGoogle(), apple: fakeApple() }).appleAvailable,
    ).toBe(true);
  });

  it('signs in with the Apple ID token, its raw nonce and the name Apple gave', async () => {
    const { backend } = fakeBackend();
    const apple = fakeApple({
      type: 'success',
      idToken: 'apple-id-token',
      nonce: 'raw-nonce',
      name: { full: 'Alex Smith', given: 'Alex', family: 'Smith' },
    });
    const auth = new AuthController({ backend, google: fakeGoogle(), apple });
    await expect(auth.signInWithApple()).resolves.toBeUndefined();
    expect(backend.signInWithIdToken).toHaveBeenCalledWith('apple-id-token', {
      provider: 'apple',
      nonce: 'raw-nonce',
      name: { full: 'Alex Smith', given: 'Alex', family: 'Smith' },
    });
    expect(auth.getState().status).toBe('signed_in');
  });

  it('says nothing when the person cancels Apple', async () => {
    const { backend } = fakeBackend();
    const auth = new AuthController({
      backend,
      google: fakeGoogle(),
      apple: fakeApple({ type: 'cancelled' }),
    });
    await expect(auth.signInWithApple()).resolves.toBeUndefined();
    expect(backend.signInWithIdToken).not.toHaveBeenCalled();
    expect(auth.getState().status).not.toBe('signed_in');
  });

  it('explains Apple failures in Apple words', async () => {
    const failing = (apple: AppleSignIn) =>
      new AuthController({ backend: fakeBackend().backend, google: fakeGoogle(), apple });
    await expect(
      failing(fakeApple(new AppleSignInError('failed'))).signInWithApple(),
    ).resolves.toBe("Apple sign-in didn't finish. Try again.");
    await expect(
      failing(fakeApple({ type: 'success', idToken: null, nonce: 'n' })).signInWithApple(),
    ).resolves.toBe("Apple sign-in didn't finish. Try again.");

    const { backend } = fakeBackend();
    backend.signInWithIdToken.mockRejectedValue(new AuthBackendError('rejected'));
    const refused = new AuthController({ backend, google: fakeGoogle(), apple: fakeApple() });
    await expect(refused.signInWithApple()).resolves.toMatch(/that Apple Account/);
    expect(refused.getState().status).not.toBe('signed_in');

    const noApple = new AuthController({ backend: fakeBackend().backend, google: fakeGoogle() });
    await expect(noApple.signInWithApple()).resolves.toMatch(/Apple sign-in didn't finish/);
  });
});
