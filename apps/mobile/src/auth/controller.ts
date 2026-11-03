/**
 * Sign-in state for the app (ADR-021): Google (Android: an ID token from the device; iPhone: the
 * browser sign-in) or Apple (iPhone: an ID token with our nonce) gives a Supabase Auth session, and
 * the Twring gateway verifies that session's access token. Pure and dependency-injected so it is
 * testable without native modules; `./index` wires the real ones.
 */

import { systemTimers, type Timers } from '../call/timers';

/** The parts of a Supabase session Twring uses. */
export interface AuthSession {
  accessToken: string;
  userId: string;
  email?: string;
  name?: string;
  /** The account signs in with Apple: deleting it also ends Sign in with Apple. */
  apple?: true;
}

/** Supabase Auth, reduced to what Twring calls. */
export interface AuthBackend {
  /** The stored session, if any (refreshing it first when it has expired). */
  getSession(): Promise<AuthSession | null>;
  /** Called on every session change: sign-in, refresh, sign-out. Returns an unsubscribe. */
  onChange(listener: (session: AuthSession | null) => void): () => void;
  /**
   * Exchanges an ID token for a session: Google's by default, or Apple's with the raw nonce whose
   * hash Apple signed. Apple gives the name only on the first sign-in; it is saved when given.
   * Throws `AuthBackendError` on failure.
   */
  signInWithIdToken(idToken: string, apple?: AppleIdToken): Promise<AuthSession>;
  /**
   * A fresh session. Null when the refresh token is no longer valid (the user must sign in again);
   * throws when Supabase could not be reached, which is not a reason to sign the user out.
   */
  refresh(): Promise<AuthSession | null>;
  /** Ends the session on this device. Never throws. */
  signOut(): Promise<void>;
}

export class AuthBackendError extends Error {
  constructor(readonly kind: 'network' | 'rejected') {
    super(`auth backend ${kind}`);
    this.name = 'AuthBackendError';
  }
}

export interface AppleIdToken {
  provider: 'apple';
  nonce: string;
  name?: { full: string; given?: string; family?: string };
}

/**
 * Google sign-in. On Android the device gives an ID token; on the iPhone the browser sign-in
 * returns a finished session (the iOS Google SDK's nonce cannot be checked, ADR-021).
 */
export interface GoogleSignIn {
  signIn(): Promise<
    | { type: 'success'; idToken: string | null }
    | { type: 'session'; session: AuthSession }
    | { type: 'cancelled' }
  >;
  /** Forgets the Google account choice so the next sign-in can pick another. Never throws. */
  signOut(): Promise<void>;
}

export class GoogleSignInError extends Error {
  constructor(readonly kind: 'in_progress' | 'play_services' | 'failed') {
    super(`google sign-in ${kind}`);
    this.name = 'GoogleSignInError';
  }
}

/** Sign in with Apple (iPhone only). The nonce is the raw value; Apple signed its SHA-256. */
export interface AppleSignIn {
  signIn(): Promise<
    | { type: 'success'; idToken: string | null; nonce: string; name?: AppleIdToken['name'] }
    | { type: 'cancelled' }
  >;
}

export class AppleSignInError extends Error {
  constructor(readonly kind: 'failed') {
    super(`apple sign-in ${kind}`);
    this.name = 'AppleSignInError';
  }
}

export type SignInProvider = 'google' | 'apple';

export type AuthState =
  /** Sign-in is not configured (development only): the app talks to an AUTH_MODE=dev gateway. */
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'signed_out'; notice?: string }
  | { status: 'signed_in'; userId: string; email?: string; name?: string; apple?: true };

/** Why "Continue with Google" or "Continue with Apple" did not sign in, as user copy. */
export function signInErrorCopy(error: unknown, provider: SignInProvider = 'google'): string {
  if (error instanceof AppleSignInError) return "Apple sign-in didn't finish. Try again.";
  if (error instanceof GoogleSignInError) {
    switch (error.kind) {
      case 'in_progress':
        return 'Sign-in is already open. Finish it, or close it and try again.';
      case 'play_services':
        return 'Google Play services is missing or out of date. Update it from the Play Store, then try again.';
      case 'failed':
        return "Google sign-in didn't finish. Try again.";
    }
  }
  if (error instanceof AuthBackendError && error.kind === 'network') {
    return "Twring couldn't reach its sign-in service. Check your internet connection and try again.";
  }
  return provider === 'apple'
    ? "Twring couldn't sign you in with that Apple Account. Try again."
    : "Twring couldn't sign you in with that Google account. Try again, or use another account.";
}

export const SESSION_ENDED_NOTICE = 'Your session ended. Sign in again to continue.';

/**
 * How long the splash waits for the stored session. A secure store that never answers (a wedged
 * Keystore) must not hang the app on its splash: past this the user is shown Sign in.
 */
export const RESTORE_TIMEOUT_MS = 8_000;

export interface AuthControllerDeps {
  backend: AuthBackend;
  google: GoogleSignIn;
  /** Sign in with Apple; only on the iPhone. */
  apple?: AppleSignIn;
  /** Runs before signing out, e.g. to end a live call. Failures do not stop the sign-out. */
  beforeSignOut?: () => Promise<void>;
  timers?: Timers;
}

export class AuthController {
  private state: AuthState = { status: 'loading' };
  private session: AuthSession | null = null;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private signingOut: Promise<void> | undefined;

  constructor(private readonly deps: AuthControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): AuthState => this.state;

  /** Loads the stored session once and follows changes. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.deps.backend.onChange((session) => this.apply(session));
    let timedOut = false;
    const cancelTimeout = (this.deps.timers ?? systemTimers).setTimeout(() => {
      timedOut = true;
      if (this.state.status === 'loading') this.apply(null);
    }, RESTORE_TIMEOUT_MS);
    this.deps.backend.getSession().then(
      (session) => {
        cancelTimeout();
        // A session read after the timeout still counts, unless something else decided since.
        const waiting =
          this.state.status === 'loading' ||
          (timedOut && session !== null && this.state.status === 'signed_out');
        if (waiting) this.apply(session);
      },
      () => {
        cancelTimeout();
        if (this.state.status === 'loading') this.apply(null);
      },
    );
  }

  /** The current access token, or undefined when signed out. */
  accessToken(): string | undefined {
    return this.session?.accessToken;
  }

  /** Whether "Continue with Apple" is offered (the iPhone). */
  get appleAvailable(): boolean {
    return this.deps.apple !== undefined;
  }

  /** "Continue with Google". Resolves with user copy on failure, undefined on success or cancel. */
  async signInWithGoogle(): Promise<string | undefined> {
    let idToken: string | null;
    try {
      const result = await this.deps.google.signIn();
      if (result.type === 'cancelled') return undefined;
      if (result.type === 'session') {
        this.apply(result.session);
        return undefined;
      }
      idToken = result.idToken;
    } catch (error) {
      return signInErrorCopy(error);
    }
    if (idToken === null) return signInErrorCopy(new GoogleSignInError('failed'));
    try {
      this.apply(await this.deps.backend.signInWithIdToken(idToken));
      return undefined;
    } catch (error) {
      // Leave no half-chosen Google account behind a failed exchange.
      await this.deps.google.signOut();
      return signInErrorCopy(error);
    }
  }

  /** "Continue with Apple". Resolves with user copy on failure, undefined on success or cancel. */
  async signInWithApple(): Promise<string | undefined> {
    const apple = this.deps.apple;
    if (apple === undefined) return signInErrorCopy(new AppleSignInError('failed'), 'apple');
    let result: Awaited<ReturnType<AppleSignIn['signIn']>>;
    try {
      result = await apple.signIn();
    } catch (error) {
      return signInErrorCopy(error, 'apple');
    }
    if (result.type === 'cancelled') return undefined;
    if (result.idToken === null) return signInErrorCopy(new AppleSignInError('failed'), 'apple');
    try {
      this.apply(
        await this.deps.backend.signInWithIdToken(result.idToken, {
          provider: 'apple',
          nonce: result.nonce,
          ...(result.name !== undefined && { name: result.name }),
        }),
      );
      return undefined;
    } catch (error) {
      return signInErrorCopy(error, 'apple');
    }
  }

  /**
   * A fresh access token after the gateway refused the current one. Undefined means the session is
   * over; throws when the refresh could not be attempted (offline), which keeps the user signed in.
   */
  async refreshAccessToken(): Promise<string | undefined> {
    const session = await this.deps.backend.refresh();
    if (session === null) return undefined;
    this.apply(session);
    return session.accessToken;
  }

  /** Signs out: ends any live call first, then the Supabase session and the Google choice. */
  signOut(notice?: string): Promise<void> {
    this.signingOut ??= (async () => {
      try {
        await this.deps.beforeSignOut?.().catch(() => undefined);
        await this.deps.backend.signOut();
        await this.deps.google.signOut();
      } finally {
        this.session = null;
        this.set({ status: 'signed_out', ...(notice !== undefined && { notice }) });
        this.signingOut = undefined;
      }
    })();
    return this.signingOut;
  }

  /** The gateway refused even a fresh token: sign out and say why. */
  sessionExpired(): void {
    if (this.state.status === 'signed_in') void this.signOut(SESSION_ENDED_NOTICE);
  }

  private apply(session: AuthSession | null): void {
    if (this.signingOut !== undefined) return;
    this.session = session;
    if (session === null) {
      // Keep a notice already shown; a refresh-token failure reported here says the same thing.
      if (this.state.status === 'signed_out') return;
      this.set(
        this.state.status === 'signed_in'
          ? { status: 'signed_out', notice: SESSION_ENDED_NOTICE }
          : { status: 'signed_out' },
      );
      return;
    }
    this.set({
      status: 'signed_in',
      userId: session.userId,
      ...(session.email !== undefined && { email: session.email }),
      ...(session.name !== undefined && { name: session.name }),
      ...(session.apple === true && { apple: true }),
    });
  }

  private set(next: AuthState): void {
    // States are small flat objects; skip notifying when nothing changed.
    if (JSON.stringify(this.state) === JSON.stringify(next)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/** The auth hooks the API clients use: attach a token, refresh on `auth_invalid`, report expiry. */
export interface ApiAuth {
  token(): string | undefined;
  refresh(): Promise<string | undefined>;
  /** `sentToken` is the token the refused request carried (a self-hosted sign-in ignores a stale one). */
  expired(sentToken?: string): void;
  /**
   * A self-hosted server removed this phone (or refused its token): sign out of that server with
   * the server's message. Never followed by a refresh or a second request with the same token.
   * `sentToken` is the token the refused request carried; a token no longer in use is ignored.
   */
  removed?(message: string, sentToken?: string): void;
}

export function apiAuthFor(controller: AuthController): ApiAuth {
  return {
    token: () => controller.accessToken(),
    refresh: () => controller.refreshAccessToken(),
    expired: () => controller.sessionExpired(),
  };
}

type AuthCode = 'auth_invalid' | 'auth_required' | 'device_removed' | undefined;

const REMOVED_COPY = 'This phone was removed from the server. Ask an admin for a new code.';
const UNPAIRED_COPY =
  'This phone is no longer paired with the server. Pair it again with a new code.';

/** The server's own sentence on a refused request, when the client kept one. */
function serverMessageOf(error: unknown): string | undefined {
  const message = (error as { serverMessage?: unknown } | null)?.serverMessage;
  return typeof message === 'string' && message !== '' ? message : undefined;
}

/**
 * Runs a request with the bearer token. On 401 `auth_invalid` it refreshes the session and tries
 * exactly once more; if that is refused too (or the session cannot be refreshed) the user is signed
 * out. Retrying is safe even for POST: the gateway refuses auth before any handler runs.
 */
export async function withAuth<T>(
  auth: ApiAuth | undefined,
  run: (headers: Record<string, string>) => Promise<T>,
  authCodeOf: (error: unknown) => AuthCode,
): Promise<T> {
  if (auth === undefined) return run({});
  const headers = (token: string | undefined): Record<string, string> =>
    token === undefined ? {} : { authorization: `Bearer ${token}` };
  const sent = auth.token();
  try {
    return await run(headers(sent));
  } catch (error) {
    const code = authCodeOf(error);
    if (code === undefined) throw error;
    // A removed phone is never refreshed or retried. A self-hosted server's `auth_required` means
    // the same: its token is a pairing, not a session that can be renewed.
    if (code === 'device_removed' || (code === 'auth_required' && auth.removed !== undefined)) {
      const fallback = code === 'device_removed' ? REMOVED_COPY : UNPAIRED_COPY;
      // Only once per token: a request sent after the sign-out carried none.
      if (auth.removed !== undefined) {
        if (sent !== undefined) auth.removed(serverMessageOf(error) ?? fallback, sent);
      } else auth.expired(sent);
      throw error;
    }
    let fresh: string | undefined;
    if (code === 'auth_invalid') {
      try {
        fresh = await auth.refresh();
      } catch {
        // Could not refresh right now (offline): report the original failure, stay signed in.
        throw error;
      }
    }
    if (fresh === undefined) {
      auth.expired(sent);
      throw error;
    }
    try {
      return await run(headers(fresh));
    } catch (retryError) {
      if (authCodeOf(retryError) !== undefined) auth.expired(fresh);
      throw retryError;
    }
  }
}
