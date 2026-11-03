import { importPKCS8, SignJWT } from 'jose';

/**
 * Ends Twring's Sign in with Apple for an account being deleted (Apple's token revocation rule). The phone sends a fresh authorization
 * code; it is exchanged at Apple for the user's tokens, which are revoked at once. Nothing from
 * Apple is stored.
 *
 * Apple's REST API: https://developer.apple.com/documentation/sign_in_with_apple/revoke_tokens
 */

const APPLE = 'https://appleid.apple.com';

export interface AppleSignInConfig {
  /** The Sign in with Apple key (.p8 PEM). A secret: never logged. */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id (the client id for a native app). */
  clientId: string;
}

export type AppleFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export class AppleRevokeError extends Error {
  constructor(
    readonly step: 'token' | 'revoke',
    readonly status: number | undefined,
  ) {
    super(`apple ${step} failed${status === undefined ? '' : ` (${status})`}`);
    this.name = 'AppleRevokeError';
  }
}

/** `invalid_code`: the code expired or was already used (Apple's `invalid_grant`). */
export type AppleRevokeOutcome = 'revoked' | 'invalid_code';

export class AppleSignInRevoker {
  private secret: { value: string; until: number } | undefined;

  constructor(
    private readonly config: AppleSignInConfig,
    private readonly fetchImpl: AppleFetch = (url, init) => fetch(url, init),
    private readonly options: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  async revokeCode(code: string): Promise<AppleRevokeOutcome> {
    const secret = await this.clientSecret();
    const tokens = await this.post('/auth/token', 'token', {
      client_id: this.config.clientId,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
    });
    if (tokens.status === 400 && errorOf(tokens.body) === 'invalid_grant') return 'invalid_code';
    if (tokens.status !== 200) throw new AppleRevokeError('token', tokens.status);
    const refresh = stringField(tokens.body, 'refresh_token');
    const access = stringField(tokens.body, 'access_token');
    const token = refresh ?? access;
    if (token === undefined) throw new AppleRevokeError('token', tokens.status);
    const revoked = await this.post('/auth/revoke', 'revoke', {
      client_id: this.config.clientId,
      client_secret: secret,
      token,
      token_type_hint: refresh !== undefined ? 'refresh_token' : 'access_token',
    });
    if (revoked.status !== 200) throw new AppleRevokeError('revoke', revoked.status);
    return 'revoked';
  }

  /** The client secret: an ES256 JWT from the key, cached for most of its 10-minute life. */
  private async clientSecret(): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.secret !== undefined && now < this.secret.until) return this.secret.value;
    const key = await importPKCS8(this.config.keyPem, 'ES256');
    const issuedAt = Math.floor(now / 1000);
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setSubject(this.config.clientId)
      .setAudience(APPLE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 600)
      .sign(key);
    this.secret = { value, until: now + 480_000 };
    return value;
  }

  private async post(
    path: string,
    step: AppleRevokeError['step'],
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Awaited<ReturnType<AppleFetch>>;
    try {
      response = await this.fetchImpl(`${APPLE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal,
      });
    } catch {
      throw new AppleRevokeError(step, undefined);
    }
    // Revoke answers 200 with an empty body; the token endpoint answers JSON.
    const body: unknown = await response.json().catch(() => undefined);
    return { status: response.status, body };
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function errorOf(body: unknown): string | undefined {
  return stringField(body, 'error');
}
