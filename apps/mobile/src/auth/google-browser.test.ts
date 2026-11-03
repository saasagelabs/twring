import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { AuthBackendError, GoogleSignInError } from './controller';
import { googleBrowserSignIn, redirectParams, type OpenAuthSession } from './google-browser';

const REDIRECT = 'cord://auth/callback';
const AUTHORIZE = 'https://x.supabase.co/auth/v1/authorize?p=1';
const USER = { id: 'user-1', email: 'a@example.com', user_metadata: { full_name: 'Alex' } };
const SESSION = { access_token: 'tok-1', user: USER };

function fakeAuth(
  overrides: { oauthError?: Error; exchangeError?: Error; noSession?: boolean } = {},
) {
  return {
    signInWithOAuth: vi.fn(() =>
      Promise.resolve(
        overrides.oauthError
          ? { data: { provider: 'google', url: null }, error: overrides.oauthError }
          : { data: { provider: 'google', url: AUTHORIZE }, error: null },
      ),
    ),
    exchangeCodeForSession: vi.fn((_code: string) =>
      Promise.resolve(
        overrides.exchangeError
          ? { data: { session: null, user: null }, error: overrides.exchangeError }
          : { data: { session: overrides.noSession ? null : SESSION, user: USER }, error: null },
      ),
    ),
  };
}

type SheetResult = Awaited<ReturnType<OpenAuthSession>>;

function signIn(auth: ReturnType<typeof fakeAuth>, result: SheetResult) {
  const open = vi.fn((_url: string, _redirectTo: string) => Promise.resolve(result));
  // The fake returns the fields the code reads; the real client's types are much wider.
  const google = googleBrowserSignIn(auth as never, open, REDIRECT);
  return { open, run: () => google.signIn() };
}

const back = (query: string): SheetResult => ({ type: 'success', url: `${REDIRECT}?${query}` });

describe('Google sign-in in the browser (iPhone)', () => {
  it('opens the PKCE sign-in in the sheet and exchanges the returned code', async () => {
    const auth = fakeAuth();
    const { open, run } = signIn(auth, back('code=abc%2B1'));
    await expect(run()).resolves.toEqual({
      type: 'session',
      session: { accessToken: 'tok-1', userId: 'user-1', email: 'a@example.com', name: 'Alex' },
    });
    expect(auth.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: REDIRECT, skipBrowserRedirect: true },
    });
    expect(open).toHaveBeenCalledWith(AUTHORIZE, REDIRECT);
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith('abc+1');
  });

  it.each<[string, SheetResult]>([
    ['the sheet is closed', { type: 'cancel' }],
    ['the sheet is dismissed', { type: 'dismiss' }],
    ['Google consent is backed out of', back('error=access_denied')],
  ])('is a cancel, not an error, when %s', async (_name, result) => {
    const auth = fakeAuth();
    await expect(signIn(auth, result).run()).resolves.toEqual({ type: 'cancelled' });
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it('fails when the redirect has no code', async () => {
    const { run } = signIn(fakeAuth(), back('error=server_error'));
    await expect(run()).rejects.toEqual(new GoogleSignInError('failed'));
  });

  it('reports an unreachable sign-in service as network, a refused code as rejected', async () => {
    const offline = fakeAuth({ exchangeError: new AuthRetryableFetchError('offline', 0) });
    await expect(signIn(offline, back('code=c')).run()).rejects.toEqual(
      new AuthBackendError('network'),
    );

    const refused = fakeAuth({ exchangeError: new AuthApiError('bad code', 400, 'bad_code') });
    await expect(signIn(refused, back('code=c')).run()).rejects.toEqual(
      new AuthBackendError('rejected'),
    );

    const empty = fakeAuth({ noSession: true });
    await expect(signIn(empty, back('code=c')).run()).rejects.toEqual(
      new AuthBackendError('rejected'),
    );
  });

  it('fails before opening the sheet when the sign-in address cannot be made', async () => {
    const auth = fakeAuth({ oauthError: new AuthRetryableFetchError('offline', 0) });
    const { open, run } = signIn(auth, { type: 'cancel' });
    await expect(run()).rejects.toEqual(new AuthBackendError('network'));
    expect(open).not.toHaveBeenCalled();
  });
});

describe('redirectParams', () => {
  it('reads the query, decodes it, and ignores the fragment and bad pairs', () => {
    expect(redirectParams('cord://auth/callback?code=a%20b&state=x+y#frag=1')).toEqual({
      code: 'a b',
      state: 'x y',
    });
    expect(redirectParams('cord://auth/callback')).toEqual({});
    expect(redirectParams('cord://auth/callback?code=%E0%A4%A&ok=1')).toEqual({ ok: '1' });
  });
});
