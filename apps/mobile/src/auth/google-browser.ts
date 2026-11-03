import { isAuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';

import { AuthBackendError, GoogleSignInError, type GoogleSignIn } from './controller';
import { toSession } from './supabase-backend';

/** Apple's sign-in sheet (`expo-web-browser` `openAuthSessionAsync`), reduced to what is used. */
export type OpenAuthSession = (
  url: string,
  redirectTo: string,
) => Promise<{ type: 'success'; url: string } | { type: string }>;

/** The query parameters of a redirect such as `cord://auth/callback?code=...`. */
export function redirectParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const query = url.split('#')[0]?.split('?')[1] ?? '';
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const [key = '', value = ''] = pair.split('=');
    try {
      params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      // A malformed pair is skipped; a missing code then fails the sign-in.
    }
  }
  return params;
}

/**
 * Google on the iPhone: Supabase's OAuth sign-in with PKCE, in
 * Apple's sign-in sheet. The iOS Google SDK puts a nonce in its token that the app cannot read, so
 * the device flow would need Supabase's nonce check off (ADR-021).
 */
export function googleBrowserSignIn(
  auth: Pick<SupabaseClient['auth'], 'signInWithOAuth' | 'exchangeCodeForSession'>,
  open: OpenAuthSession,
  redirectTo: string,
): GoogleSignIn {
  return {
    async signIn() {
      const { data, error } = await auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error !== null) {
        throw new AuthBackendError(isAuthRetryableFetchError(error) ? 'network' : 'rejected');
      }
      const result = await open(data.url, redirectTo);
      if (result.type !== 'success' || !('url' in result)) return { type: 'cancelled' };
      const params = redirectParams(result.url);
      // Backing out of Google's consent page comes back as access_denied: a cancel, not an error.
      if (params.error === 'access_denied') return { type: 'cancelled' };
      const code = params.code;
      if (code === undefined || code === '') throw new GoogleSignInError('failed');
      const exchanged = await auth.exchangeCodeForSession(code);
      if (exchanged.error !== null) {
        throw new AuthBackendError(
          isAuthRetryableFetchError(exchanged.error) ? 'network' : 'rejected',
        );
      }
      const session = toSession(exchanged.data.session);
      if (session === null) throw new AuthBackendError('rejected');
      return { type: 'session', session };
    },
    // The sheet keeps no Google choice of ours; signing out of Supabase is enough.
    signOut: () => Promise.resolve(),
  };
}
