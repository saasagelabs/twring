import type { ErrorCode, ErrorResponse } from '@twring/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * The single local user of `AUTH_MODE=dev` (development only). Data saved before sign-in existed
 * stays under this id; it is not migrated to signed-in accounts (ADR-021).
 */
export const DEV_USER_ID = 'dev-user';

/**
 * Resolves the acting user for a request. Never taken from the request body or query: with sign-in
 * it reads the id `RequestAuth` verified for this request.
 */
export type UserResolver = (request: FastifyRequest) => string;

export const devUserResolver: UserResolver = () => DEV_USER_ID;

/** Why a request could not be authenticated. `status` and `code` go to the client as they are. */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly code: Extract<
      ErrorCode,
      'auth_required' | 'auth_invalid' | 'auth_unavailable' | 'device_removed'
    >,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** A verified user, with what the sign-in says about them (shown back to them, never trusted). */
export interface AuthenticatedUser {
  id: string;
  /** Display name from the sign-in provider, if any. */
  name?: string;
  email?: string;
}

/** Returns the verified user (or just its id) for a request, or throws `AuthError`. */
export type Authenticator = (request: FastifyRequest) => Promise<string | AuthenticatedUser>;

/** Resolves who the acting user is, for showing their own account back to them. */
export type ProfileResolver = (request: FastifyRequest) => Omit<AuthenticatedUser, 'id'>;

/** `AUTH_MODE=dev`: every request is the one development user. */
/** A load test's simulated user (development only), e.g. `x-cord-dev-user: load-7`. */
const DEV_USER_SUFFIX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `AUTH_MODE=dev`, which config allows only in development. One user, unless a load test names a
 * simulated one (`dev-user-<name>`) so several calls can run at once (one call per user).
 */
export const devAuthenticator: Authenticator = (request) => {
  const named = request.headers['x-cord-dev-user'];
  return Promise.resolve(
    typeof named === 'string' && DEV_USER_SUFFIX.test(named)
      ? `${DEV_USER_ID}-${named}`
      : DEV_USER_ID,
  );
};

/** RFC 6750 credentials; the scheme is case-insensitive and may be followed by several spaces. */
const BEARER = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i;
/** A Supabase Auth user id (auth.users.id): a uuid in Postgres' canonical lower-case form. */
const SUPABASE_USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Well above any Supabase access token; stops oversized headers before any parsing. */
const MAX_TOKEN_LENGTH = 8192;

/** The bearer token of a request, or undefined when there is none. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 7) return undefined;
  return BEARER.exec(header.trim())?.[1];
}

export interface SupabaseAuthOptions {
  /** The project URL, e.g. `https://<ref>.supabase.co` (no trailing path). */
  supabaseUrl: string;
  /** Key source; defaults to the project's JWKS endpoint. Tests pass a local one. */
  keys?: JWTVerifyGetKey;
  /** Allowed clock skew for exp/nbf/iat, in seconds. */
  clockToleranceS?: number;
}

export interface McpIdentity extends AuthenticatedUser {
  clientId: string;
}

/** The project's JWKS endpoint. */
export function supabaseJwksUrl(supabaseUrl: string): URL {
  return new URL(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`);
}

/**
 * The project's signing keys, cached. jose refetches when a token names a key id it has not seen
 * (key rotation), at most once per `cooldownDuration`, and refreshes the cache after `cacheMaxAge`.
 */
export function supabaseJwks(
  supabaseUrl: string,
  { cooldownMs = 30_000, timeoutMs = 5_000 }: { cooldownMs?: number; timeoutMs?: number } = {},
): JWTVerifyGetKey {
  return createRemoteJWKSet(supabaseJwksUrl(supabaseUrl), {
    timeoutDuration: timeoutMs,
    cooldownDuration: cooldownMs,
    cacheMaxAge: 10 * 60_000,
  });
}

/** jose failures that mean the key source, not the token, is at fault: fail closed with 503. */
function isKeySourceFailure(error: unknown): boolean {
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return true;
  }
  // Network errors and non-2xx JWKS answers are not token problems either.
  return !(error instanceof joseErrors.JOSEError) || error.code === 'ERR_JOSE_GENERIC';
}

/**
 * Verifies a Supabase Auth access token (ADR-021): signature against the project's JWKS, issuer
 * `${SUPABASE_URL}/auth/v1`, audience `authenticated`, exp/nbf with a small skew, ES256 or RS256
 * only (so `alg: none` and HS256 are refused). The user id is `sub`. Tokens issued to OAuth
 * client apps (a `client_id` claim) are refused: they are for the connector endpoint only.
 */
export function supabaseAuthenticator(options: SupabaseAuthOptions): Authenticator {
  const verify = createSupabaseVerifier(options);
  return async (request) => {
    const { user, payload } = await verify(request);
    if (payload.client_id !== undefined) {
      throw new AuthError(
        401,
        'auth_invalid',
        'This sign-in is for a connected app, not the Twring app.',
      );
    }
    return user;
  };
}

export function mcpAuthenticator(
  options: SupabaseAuthOptions,
): (request: FastifyRequest) => Promise<McpIdentity> {
  const verify = createSupabaseVerifier(options);
  return async (request) => {
    const { user, payload } = await verify(request);
    if (
      typeof payload.client_id !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.client_id)
    ) {
      throw new AuthError(401, 'auth_invalid', 'This token is not for a connected AI app.');
    }
    return { ...user, clientId: payload.client_id };
  };
}

function createSupabaseVerifier(
  options: SupabaseAuthOptions,
): (request: FastifyRequest) => Promise<{ user: AuthenticatedUser; payload: JWTPayload }> {
  const base = options.supabaseUrl.replace(/\/+$/, '');
  const issuer = `${base}/auth/v1`;
  const keys = options.keys ?? supabaseJwks(base);
  const clockTolerance = options.clockToleranceS ?? 30;

  return async (request) => {
    const token = bearerToken(request);
    if (token === undefined) {
      throw new AuthError(401, 'auth_required', 'Sign in to use Twring.');
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer,
        audience: 'authenticated',
        algorithms: ['ES256', 'RS256'],
        clockTolerance,
        requiredClaims: ['sub', 'exp'],
      }));
    } catch (error) {
      if (isKeySourceFailure(error)) {
        throw new AuthError(503, 'auth_unavailable', 'Sign-in could not be checked. Try again.');
      }
      throw new AuthError(401, 'auth_invalid', 'Your session has ended. Sign in again.');
    }
    // Only a signed-in person: not the anon or service role, not an anonymous sign-in (which a
    // project could enable without Twring noticing). `sub` must be the auth.users uuid Supabase
    // mints, so it can never be `dev-user` or anything else that is not a plain id.
    const { sub, role, is_anonymous: anonymous } = payload;
    // A token Supabase's OAuth server issued to a third-party app (a connector in Claude, ChatGPT,
    // ...) carries `client_id`. It may only ever open the connector endpoint, never the app API:
    // refuse it here, so turning the OAuth server on can't widen what those apps reach.
    if (
      role !== 'authenticated' ||
      anonymous === true ||
      typeof sub !== 'string' ||
      !SUPABASE_USER_ID.test(sub)
    ) {
      throw new AuthError(401, 'auth_invalid', 'Your session has ended. Sign in again.');
    }
    const meta = payload.user_metadata;
    const fromMeta = (key: string): string | undefined => {
      if (typeof meta !== 'object' || meta === null) return undefined;
      const value = (meta as Record<string, unknown>)[key];
      return typeof value === 'string' && value.trim() !== '' ? value : undefined;
    };
    const name = fromMeta('full_name') ?? fromMeta('name');
    const email =
      typeof payload.email === 'string' && payload.email !== '' ? payload.email : undefined;
    return {
      user: { id: sub, ...(name !== undefined && { name }), ...(email !== undefined && { email }) },
      payload,
    };
  };
}

export interface RequestAuth {
  /** Fastify hook: authenticates `/v1` routes, answering 401/503 itself on failure. */
  hook(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  /** The id `hook` verified for this request. Throws if it never ran (fails closed). */
  userFor: UserResolver;
  /** The verified user's name and email, when the sign-in carries them. */
  profileFor: ProfileResolver;
  /** Authenticate an upgrade, which has headers but no Fastify request. */
  authenticateHeaders(headers: IncomingHttpHeaders): Promise<string | AuthenticatedUser>;
}

/**
 * `/v1` routes that authenticate by their own proof instead of a user token: a connector claims
 * with its one-time pairing code (ADR-023). Its relay socket is an HTTP upgrade, not a route.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/v1/waitlist',
  '/v1/connectors/claim',
  // A computer asks to be linked, then polls with its own secret poll token (ADR-025).
  '/v1/connectors/link-requests',
  '/v1/connectors/link-requests/:id',
  // A connector rings its owner with its own token, checked by the route (ADR-024).
  '/v1/connectors/ring',
  '/v1/connectors/ring/:inviteId',
  // A connector adds words its calls listen for, with its own token, checked by the route.
  '/v1/connectors/words',
]);

/** Self-hosted only: the server's identity and pairing, which a phone reaches before it has a token. */
export const SELFHOST_PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/v1/server', '/v1/pair']);

/**
 * Wraps an authenticator as a hook plus the matching resolver for route handlers. `extraPublic`
 * adds routes that skip the hook (main passes `SELFHOST_PUBLIC_ROUTES` in self-hosted mode only).
 */
export function createRequestAuth(
  authenticate: Authenticator,
  extraPublic: ReadonlySet<string> = new Set(),
): RequestAuth {
  const users = new WeakMap<FastifyRequest, AuthenticatedUser>();
  return {
    // Both authenticators read only headers; the upgrade has no Fastify lifecycle.
    authenticateHeaders: (headers) => authenticate({ headers } as FastifyRequest),
    async hook(request, reply) {
      // The matched route's pattern, so only real /v1 routes are gated (not /health or 404s).
      const route = request.routeOptions.url;
      if (
        route === undefined ||
        !route.startsWith('/v1/') ||
        PUBLIC_ROUTES.has(route) ||
        extraPublic.has(route)
      )
        return;
      try {
        const user = await authenticate(request);
        users.set(request, typeof user === 'string' ? { id: user } : user);
      } catch (error) {
        const failure =
          error instanceof AuthError
            ? error
            : new AuthError(503, 'auth_unavailable', 'Sign-in could not be checked. Try again.');
        const body: ErrorResponse = {
          error: { code: failure.code, message: failure.message, request_id: request.id },
        };
        if (failure.status === 401) void reply.header('www-authenticate', 'Bearer');
        return reply.code(failure.status).send(body);
      }
    },
    userFor(request) {
      const user = users.get(request);
      if (user === undefined) throw new Error('request was not authenticated');
      return user.id;
    },
    profileFor(request) {
      const user = users.get(request);
      return {
        ...(user?.name !== undefined && { name: user.name }),
        ...(user?.email !== undefined && { email: user.email }),
      };
    },
  };
}

/**
 * The /v1 authenticator for the configured mode. Fails closed: only `dev` gets the single local
 * user, and `pairing` needs the paired-phone store (`pairing`), refusing to start without it.
 */
export function selectAuthenticator(
  env: { AUTH_MODE: string; SUPABASE_URL?: string | undefined },
  pairing?: { authenticator: Authenticator },
): Authenticator {
  switch (env.AUTH_MODE) {
    case 'dev':
      return devAuthenticator;
    case 'supabase':
      if (env.SUPABASE_URL === undefined) throw new Error('AUTH_MODE=supabase needs SUPABASE_URL');
      return supabaseAuthenticator({ supabaseUrl: env.SUPABASE_URL });
    case 'pairing':
      if (pairing === undefined) throw new Error('AUTH_MODE=pairing needs the paired-phone store');
      return pairing.authenticator;
    default:
      throw new Error(`Unknown AUTH_MODE: ${env.AUTH_MODE}`);
  }
}
