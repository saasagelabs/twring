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

/**
 * The stored session as Supabase saved it, or null when it is missing or not a session. Read only
 * when Supabase could not refresh an expired one; the tokens are passed on, never logged.
 */
function parseStored(raw: string | null): Session | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const stored = value as Partial<Session>;
    const user = stored.user as { id?: unknown } | undefined;
    if (
      typeof stored.access_token !== 'string' ||
      typeof stored.refresh_token !== 'string' ||
      typeof user !== 'object' ||
      user === null ||
      typeof user.id !== 'string'
    ) {
      return null;
    }
    return stored as Session;
  } catch {
    return null;
  }
}

/**
 * Supabase Auth behind the controller's `AuthBackend` (ADR-021). No native modules. `readStored`
 * returns the raw session Supabase keeps in its storage, for starting offline.
 */
export function supabaseBackend(
  auth: SupabaseClient['auth'],
  readStored?: () => Promise<string | null>,
): AuthBackend {
  return {
    async getSession() {
      const { data, error } = await auth.getSession();
      if (data.session !== null || error === null || sessionIsOver(error)) {
        return toSession(data.session);
      }
      // An expired session that could not be refreshed right now (offline, outage, rate limit):
      // Supabase keeps it, so the user stays signed in. Requests with its old access token are
      // refused and refreshed (or kept waiting) as usual, and auto refresh renews it once online.
      if (readStored === undefined) return null;
      return toSession(parseStored(await readStored().catch(() => null)));
    },
    async storedSession() {
      if (readStored === undefined) return null;
      return toSession(parseStored(await readStored().catch(() => null)));
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange((event, session) => {
        // The first event repeats `getSession`, which the controller reads itself. Without a
        // session it may only mean the refresh failed for now: never let it sign the user out.
        if (event === 'INITIAL_SESSION' && session === null) return;
        listener(toSession(session));
      });
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
    async signInWithPassword(email, password) {
      const { data, error } = await auth.signInWithPassword({ email, password });
      if (error !== null) {
        throw new AuthBackendError(isAuthRetryableFetchError(error) ? 'network' : 'rejected');
      }
      const session = toSession(data.session);
      if (session === null) throw new AuthBackendError('rejected');
      return session;
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
