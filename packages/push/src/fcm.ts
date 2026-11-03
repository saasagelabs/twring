import { readFile } from 'node:fs/promises';

import type { MessagePush, RingCancelPush, RingPush } from '@twring/contracts';
import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

/**
 * FCM HTTP v1 push (ADR-024). Data-only messages with Android priority HIGH and a 30 s TTL, so a
 * ring that can no longer be answered is never delivered late. Authenticates as the Firebase
 * service account: a self-signed RS256 JWT is exchanged for an OAuth2 access token, cached until
 * five minutes before it expires. Tokens and the key are never logged.
 */

export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** A cached access token is renewed this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Attempts per device for transient failures (network, 429, 5xx). */
const SEND_ATTEMPTS = 2;
const SEND_TIMEOUT_MS = 5_000;

export const serviceAccountSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  client_email: z.string().min(3).max(320),
  private_key: z.string().min(1),
  token_uri: z.url().optional(),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

export type PushPayload = RingPush | RingCancelPush | MessagePush;
export interface PushOptions {
  priority: 'high' | 'normal';
  ttlSeconds: number;
}

export interface PushTarget {
  /** The ring token: FCM on Android, the PushKit VoIP token on iOS. */
  token: string;
  platform?: 'android' | 'ios';
  /** iOS only: the alert token for messages and missed rings. */
  apnsToken?: string;
}

/**
 * What happened for one device: `invalid` means the token should be forgotten; `skipped` means
 * this push has no form on that phone (for example no alert token, or its service is off).
 */
export type PushOutcome = 'sent' | 'invalid' | 'failed' | 'skipped';

export interface PushSender {
  send(target: PushTarget, data: PushPayload, options?: PushOptions): Promise<PushOutcome>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface FcmOptions {
  account: ServiceAccount;
  fetch?: FetchFn;
  now?: () => number;
  /** Waits between attempts; tests pass 0. */
  retryDelayMs?: number;
}

/** Reads and validates the service account file. Never includes the file's contents in errors. */
export async function loadServiceAccount(path: string): Promise<ServiceAccount> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('FCM service account file is missing or not JSON');
  }
  const account = serviceAccountSchema.safeParse(parsed);
  if (!account.success) throw new Error('FCM service account file is not a service account key');
  return account.data;
}

const fcmErrorSchema = z.object({
  error: z
    .object({
      status: z.string().optional(),
      message: z.string().optional(),
      details: z.array(z.object({ errorCode: z.string().optional() }).loose()).optional(),
    })
    .loose(),
});

/** FCM says this token will never work again: the app was removed, or the token is malformed. */
function isInvalidToken(status: number, body: unknown): boolean {
  const parsed = fcmErrorSchema.safeParse(body);
  if (!parsed.success) return status === 404;
  const { error } = parsed.data;
  const codes = (error.details ?? []).map((d) => d.errorCode);
  if (codes.includes('UNREGISTERED')) return true;
  // The token belongs to another Firebase project (e.g. the app was rebuilt against a new one).
  if (codes.includes('SENDER_ID_MISMATCH')) return true;
  if (status === 404 && error.status === 'NOT_FOUND') return true;
  // INVALID_ARGUMENT is also used for bad payloads: only a registration-token complaint counts.
  return (
    status === 400 &&
    (codes.includes('INVALID_ARGUMENT') || error.status === 'INVALID_ARGUMENT') &&
    /registration token/i.test(error.message ?? '')
  );
}

export class FcmPushSender implements PushSender {
  private readonly fetch: FetchFn;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(private readonly options: FcmOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  /** An OAuth2 access token, cached until five minutes before it expires. */
  async accessToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && this.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  send(
    target: PushTarget,
    data: PushPayload,
    options: PushOptions = { priority: 'high', ttlSeconds: 30 },
  ): Promise<PushOutcome> {
    return this.sendData(target.token, { ...data }, options);
  }

  /** Sends string `data` as-is to one FCM token (the relay's sealed pushes use this). */
  async sendData(
    token: string,
    data: Readonly<Record<string, string | undefined>>,
    options: PushOptions = { priority: 'high', ttlSeconds: 30 },
  ): Promise<PushOutcome> {
    const { project_id: project } = this.options.account;
    const url = `https://fcm.googleapis.com/v1/projects/${project}/messages:send`;
    const body = JSON.stringify({
      message: {
        token,
        data: { ...data },
        android: { priority: options.priority.toUpperCase(), ttl: `${options.ttlSeconds}s` },
        apns: {
          headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
          payload: { aps: { 'content-available': 1 } },
        },
      },
    });
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        const access = await this.accessToken();
        response = await this.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          redirect: 'error',
        });
      } catch {
        if (attempt < SEND_ATTEMPTS) await this.pause();
        continue;
      }
      if (response.ok) return 'sent';
      const payload: unknown = await response.json().catch(() => undefined);
      if (isInvalidToken(response.status, payload)) return 'invalid';
      // A rejected access token: drop the cache so the retry signs a new one.
      if (response.status === 401) this.cached = undefined;
      const transient =
        response.status === 401 || response.status === 429 || response.status >= 500;
      if (!transient) return 'failed';
      if (attempt < SEND_ATTEMPTS) await this.pause();
    }
    return 'failed';
  }

  private pause(): Promise<void> {
    const ms = this.options.retryDelayMs ?? 500;
    return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async fetchToken(): Promise<string> {
    const { account } = this.options;
    // Always Google's token endpoint: the file's `token_uri` is not trusted as a place to send a
    // signed assertion.
    const audience = GOOGLE_TOKEN_URL;
    const key = await importPKCS8(account.private_key, 'RS256');
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(account.client_email)
      .setSubject(account.client_email)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);
    const response = await this.fetch(audience, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`token exchange failed (HTTP ${response.status})`);
    const parsed = z
      .object({ access_token: z.string().min(1), expires_in: z.number().positive() })
      .safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new Error('token exchange answered without a token');
    this.cached = {
      token: parsed.data.access_token,
      expiresAt: this.now() + parsed.data.expires_in * 1000,
    };
    return parsed.data.access_token;
  }
}
