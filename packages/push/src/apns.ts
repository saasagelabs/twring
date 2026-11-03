import { readFile } from 'node:fs/promises';
import { connect, constants, type ClientHttp2Session } from 'node:http2';

import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';

import type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget } from './fcm';

/**
 * APNs straight from the gateway. A ring is a PushKit VoIP push, which
 * the app must answer with CallKit's incoming-call screen, so nothing else is ever sent as VoIP.
 * Messages and missed rings are alerts; any other end of a ring is a best-effort background push
 * that lets the phone close the call screen. Authenticates with an ES256 JWT from the APNs key,
 * renewed every 50 minutes (Apple: at least every hour, at most every 20 minutes). Tokens and
 * the key are never logged.
 */

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;
/** A signed provider token is reused this long. */
const JWT_LIFETIME_MS = 50 * 60_000;
const SEND_ATTEMPTS = 2;
const SEND_TIMEOUT_MS = 5_000;
/** A missed ring or a message still means something tomorrow. */
const ALERT_TTL_SECONDS = 24 * 60 * 60;

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
  environment: 'production' | 'sandbox';
}

/** One HTTP/2 request to APNs, already mapped from a Twring push. */
export interface ApnsRequest {
  token: string;
  pushType: 'voip' | 'alert' | 'background';
  topic: string;
  priority: 10 | 5;
  ttlSeconds: number;
  collapseId?: string;
  body: Record<string, unknown>;
}

export interface ApnsResponse {
  status: number;
  body: string;
}

/** Sends one request; tests replace it. */
export interface ApnsTransport {
  post(
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<ApnsResponse>;
  close(): void;
}

/** Reads the .p8 key. Errors never include the file's contents. */
export async function loadApnsKey(path: string): Promise<string> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf8');
  } catch {
    throw new Error('APNs key file is missing or unreadable');
  }
  if (!pem.includes('BEGIN PRIVATE KEY')) throw new Error('APNs key file is not a .p8 private key');
  return pem;
}

/**
 * What an iPhone gets for each Twring push. Returns nothing when the push has no iOS form (for
 * example a message to a phone that never gave an alert token).
 */
export function apnsRequestFor(
  target: PushTarget,
  data: PushPayload,
  bundleId: string,
): ApnsRequest | undefined {
  if (data.type === 'cord.ring') {
    return {
      token: target.token,
      pushType: 'voip',
      topic: `${bundleId}.voip`,
      priority: 10,
      ttlSeconds: 30,
      body: { ...data },
    };
  }
  const alertToken = target.apnsToken;
  if (alertToken === undefined) return undefined;
  if (data.type === 'cord.message') {
    const silent = data.silent === '1';
    return {
      token: alertToken,
      pushType: 'alert',
      topic: bundleId,
      priority: silent ? 5 : 10,
      ttlSeconds: ALERT_TTL_SECONDS,
      collapseId: data.message_id,
      body: {
        aps: {
          alert: { title: data.agent_name, body: data.preview },
          'thread-id': data.agent_id,
          ...(silent ? { 'interruption-level': 'passive' } : { sound: 'default' }),
        },
        ...data,
      },
    };
  }
  if (data.status === 'missed') {
    return {
      token: alertToken,
      pushType: 'alert',
      topic: bundleId,
      priority: 10,
      ttlSeconds: ALERT_TTL_SECONDS,
      collapseId: data.invite_id,
      body: {
        aps: {
          alert: { title: data.agent_name ?? 'Twring', body: 'Missed call' },
          sound: 'default',
          'thread-id': 'missed-calls',
          'content-available': 1,
        },
        ...data,
      },
    };
  }
  return {
    token: alertToken,
    pushType: 'background',
    topic: bundleId,
    priority: 5,
    ttlSeconds: 30,
    body: { aps: { 'content-available': 1 }, ...data },
  };
}

const apnsErrorSchema = z.object({ reason: z.string() }).loose();

function reasonOf(body: string): string | undefined {
  try {
    const parsed = apnsErrorSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data.reason : undefined;
  } catch {
    return undefined;
  }
}

/** APNs says this token will never work again: the app was removed or the token is not ours. */
function isInvalidToken(status: number, reason: string | undefined): boolean {
  if (status === 410) return true;
  return status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic');
}

export class ApnsPushSender implements PushSender {
  private readonly now: () => number;
  private signed: { token: string; at: number } | undefined;

  constructor(
    private readonly config: ApnsConfig,
    private readonly transport: ApnsTransport = new Http2ApnsTransport(),
    options: { now?: () => number; retryDelayMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  private readonly retryDelayMs: number;

  send(target: PushTarget, data: PushPayload, _options?: PushOptions): Promise<PushOutcome> {
    const request = apnsRequestFor(target, data, this.config.bundleId);
    return request === undefined ? Promise.resolve('skipped') : this.sendRequest(request);
  }

  /** Sends one already-mapped request (the relay builds its own for sealed pushes). */
  async sendRequest(request: ApnsRequest): Promise<PushOutcome> {
    const body = JSON.stringify(request.body);
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      let response: ApnsResponse;
      try {
        response = await this.transport.post(
          HOSTS[this.config.environment],
          `/3/device/${request.token}`,
          {
            authorization: `bearer ${await this.providerToken()}`,
            'apns-topic': request.topic,
            'apns-push-type': request.pushType,
            'apns-priority': String(request.priority),
            'apns-expiration': String(Math.floor(this.now() / 1000) + request.ttlSeconds),
            ...(request.collapseId !== undefined && { 'apns-collapse-id': request.collapseId }),
          },
          body,
        );
      } catch {
        if (attempt < SEND_ATTEMPTS) await this.pause();
        continue;
      }
      if (response.status === 200) return 'sent';
      const reason = reasonOf(response.body);
      if (isInvalidToken(response.status, reason)) return 'invalid';
      // A rejected provider token: sign a new one for the retry.
      const staleJwt =
        response.status === 403 &&
        (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken');
      if (staleJwt) this.signed = undefined;
      const transient = staleJwt || response.status === 429 || response.status >= 500;
      if (!transient) return 'failed';
      if (attempt < SEND_ATTEMPTS) await this.pause();
    }
    return 'failed';
  }

  close(): void {
    this.transport.close();
  }

  private async providerToken(): Promise<string> {
    const signed = this.signed;
    if (signed !== undefined && this.now() - signed.at < JWT_LIFETIME_MS) return signed.token;
    const key = await importPKCS8(this.config.keyPem, 'ES256');
    const at = this.now();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt(Math.floor(at / 1000))
      .sign(key);
    this.signed = { token, at };
    return token;
  }

  private pause(): Promise<void> {
    const ms = this.retryDelayMs;
    return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** One reused HTTP/2 connection to APNs, reopened after an error, GOAWAY or idle close. */
export class Http2ApnsTransport implements ApnsTransport {
  private session: ClientHttp2Session | undefined;

  post(
    origin: string,
    path: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<ApnsResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        run();
      };
      const request = this.connection(origin).request({
        ':method': 'POST',
        ':path': path,
        'content-type': 'application/json',
        ...headers,
      });
      request.setTimeout(SEND_TIMEOUT_MS, () => {
        request.close(constants.NGHTTP2_CANCEL);
        finish(() => reject(new Error('APNs request timed out')));
      });
      let status = 0;
      const chunks: Buffer[] = [];
      request.on('response', (head) => {
        status = Number(head[':status']);
      });
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () =>
        finish(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') })),
      );
      request.on('error', (error: Error) => finish(() => reject(error)));
      request.on('close', () => finish(() => reject(new Error('APNs stream closed'))));
      request.end(body);
    });
  }

  close(): void {
    this.session?.close();
    this.session = undefined;
  }

  private connection(origin: string): ClientHttp2Session {
    const current = this.session;
    if (current !== undefined && !current.closed && !current.destroyed) return current;
    const session = connect(origin);
    session.on('error', () => {
      if (this.session === session) this.session = undefined;
    });
    session.on('goaway', () => {
      if (this.session === session) this.session = undefined;
      session.close();
    });
    session.on('close', () => {
      if (this.session === session) this.session = undefined;
    });
    // Idle connections are closed after a while; the next push reconnects.
    session.setTimeout(10 * 60_000, () => session.close());
    session.unref();
    this.session = session;
    return session;
  }
}
