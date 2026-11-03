import {
  isAuthRetryableFetchError,
  type AuthError,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';

import { AuthBackendError, type AuthBackend, type AuthSession } from './controller';

export function toSession(session: Session | null): AuthSession | null {
  if (session === null) return null;
  const metadata = session.user.user_metadata as Record<string, unknown> | undefined;
  const rawName = metadata?.full_name ?? metadata?.name;
  const name = typeof rawName === 'string' ? rawName.trim() : undefined;
  const providers: unknown = session.user.app_metadata?.providers;
  const apple =
    session.user.app_metadata?.provider === 'apple' ||
    (Array.isArray(providers) && providers.includes('apple'));
  return {
    accessToken: session.access_token,
    userId: session.user.id,
    ...(session.user.email !== undefined && { email: session.user.email }),
    ...(name && { name }),
    ...(apple && { apple: true as const }),
  };
}

/**
 * Whether a failed refresh means the session is over. Unreachable or failing Supabase (which the
 * client already reports as retryable) and a rate limit (429, which it does not) are passing: the
 * refresh token may still be good, so the user stays signed in, as Supabase itself keeps the
 * session. A refused refresh token or a missing session is final.
 */
function sessionIsOver(error: AuthError): boolean {
  if (isAuthRetryableFetchError(error)) return false;
  const status = error.status;
  return !(status === 429 || (status !== undefined && status >= 500));
}

/** Supabase Auth behind the controller's `AuthBackend` (ADR-021). No native modules. */
export function supabaseBackend(auth: SupabaseClient['auth']): AuthBackend {
  return {
    async getSession() {
      const { data } = await auth.getSession();
      return toSession(data.session);
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange((_event, session) => listener(toSession(session)));
      return () => data.subscription.unsubscribe();
    },
    async signInWithIdToken(idToken, apple) {
      const { data, error } = await auth.signInWithIdToken(
        apple === undefined
          ? { provider: 'google', token: idToken }
          : { provider: 'apple', token: idToken, nonce: apple.nonce },
      );
      if (error !== null) {
        throw new AuthBackendError(isAuthRetryableFetchError(error) ? 'network' : 'rejected');
      }
      const session = toSession(data.session);
      if (session === null) throw new AuthBackendError('rejected');
      const name = apple?.name;
      if (name === undefined || session.name !== undefined) return session;
      // Apple shares the name once, outside its token: keep it on the account. Best effort.
      await auth
        .updateUser({
          data: {
            full_name: name.full,
            ...(name.given !== undefined && { given_name: name.given }),
            ...(name.family !== undefined && { family_name: name.family }),
          },
        })
        .catch(() => undefined);
      return { ...session, name: name.full };
    },
    async refresh() {
      const { data, error } = await auth.refreshSession();
      if (error !== null) {
        if (!sessionIsOver(error)) throw new AuthBackendError('network');
        return null;
      }
      return toSession(data.session);
    },
    async signOut() {
      // Local scope: ends this device's session even offline; never throws.
      await auth.signOut({ scope: 'local' }).catch(() => undefined);
    },
  };
}
