import { readFile } from 'node:fs/promises';

import {
  base64urlEncode,
  errorResponseSchema,
  RELAY_DELETE_INSTALL_PATH,
  relayAudioSessionResponseSchema,
  relayInstallAddressResponseSchema,
  relayInstallProofClaims,
  relayInstallResponseSchema,
  relayIpResponseSchema,
  relayProbeResponseSchema,
  relayPushResponseSchema,
  relayStatusResponseSchema,
  type RelayPushOutcome,
  type RelayPushRequest,
  type ServerInfo,
} from '@twring/contracts';
import type { z } from 'zod';

import type { ServerIdentity } from './identity';
import { newJti, RELAY_PROOF_LIFETIME_SECONDS } from './tickets';

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A push outcome from the relay, or `failed` when it could not be reached (after one retry). */
export type RelayPushResult = RelayPushOutcome | 'failed';
export type RelayStatus = z.infer<typeof relayStatusResponseSchema>;
export type RelayInstall = z.infer<typeof relayInstallResponseSchema>;
export type RelayAudioSession = z.infer<typeof relayAudioSessionResponseSchema>;
export type RelayProbeResult = z.infer<typeof relayProbeResponseSchema>;

/** The relay could not be reached or gave an unusable answer. Never carries the relay's body. */
export class RelayUnavailableError extends Error {
  constructor(
    readonly path: string,
    readonly status?: number,
    /** The relay's own short explanation of a refusal, for the installer to show (never logged). */
    readonly reason?: string,
  ) {
    super(
      status === undefined
        ? `The ring service could not be reached (${path}).`
        : `The ring service answered ${status} (${path}).`,
    );
    this.name = 'RelayUnavailableError';
  }
}

/** Refusals of Twring-run call audio the phone is told about as they are. */
export type RelayAudioRefusal = 'audio_paused' | 'audio_expired' | 'audio_limit_reached';
const AUDIO_REFUSALS: ReadonlySet<string> = new Set<RelayAudioRefusal>([
  'audio_paused',
  'audio_expired',
  'audio_limit_reached',
]);

/** The relay refused call audio for this server: paused, ended, or at its call limit. */
export class RelayAudioRefusedError extends Error {
  constructor(readonly code: RelayAudioRefusal) {
    super(`call audio refused: ${code}`);
    this.name = 'RelayAudioRefusedError';
  }
}

export interface RelayClientOptions {
  /** `TWRING_RELAY_URL`. */
  baseUrl: string;
  /** The relay key; read for every request so a rotated key applies at once. */
  relayKey: () => Promise<string>;
  fetch?: RelayFetch;
  /** Per request (Global Constraints: 5 s). */
  timeoutMs?: number;
  /** The wait before the one retry of a push the relay could not take. */
  retryDelayMs?: number;
  /** Development only: accept a plain `ws://` call audio address. Everywhere else it is `wss://`. */
  allowInsecureAudio?: boolean;
  /**
   * The relay answered 401 to a call with the relay key: it no longer knows this server (its
   * registration was deleted). Told on every such answer; the caller throttles its warning.
   */
  onUnregistered?: () => void;
}

/** Reads `TWRING_RELAY_KEY_FILE`. The key never reaches a log or an error message. */
export function relayKeyFromFile(file: string): () => Promise<string> {
  return async () => {
    let key: string;
    try {
      key = (await readFile(file, 'utf8')).trim();
    } catch {
      throw new RelayUnavailableError('relay key');
    }
    if (!key.startsWith('twr_')) throw new RelayUnavailableError('relay key');
    return key;
  };
}

/**
 * Twring's ring relay, as this self-hosted server uses it: ring service status, sealed pushes,
 * Twring-run call audio, reachability checks, and install registration (which needs no relay key,
 * so the installer can run it before the server starts).
 */
export class RelayClient {
  private readonly base: string;
  private readonly fetch: RelayFetch;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: RelayClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.retryDelayMs = options.retryDelayMs ?? 500;
  }

  async status(): Promise<RelayStatus> {
    return this.json(
      '/v1/status',
      relayStatusResponseSchema,
      await this.request('GET', '/v1/status'),
    );
  }

  /**
   * One sealed push. A relay that is unreachable or answers 5xx is tried once more after a short
   * wait, then `failed`. Every other answer is final: `unsupported`, `limited`, `paused` and
   * `expired` are never retried.
   */
  async push(request: RelayPushRequest): Promise<RelayPushResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      let response: Response;
      try {
        response = await this.request('POST', '/v1/push', request);
      } catch {
        continue;
      }
      if (response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      try {
        const parsed = relayPushResponseSchema.safeParse(await response.json());
        return parsed.success ? parsed.data.outcome : 'failed';
      } catch {
        return 'failed';
      }
    }
    return 'failed';
  }

  /** Forgets a phone at the relay (best effort; the caller ignores failures). */
  async removeDevice(handle: string): Promise<void> {
    const response = await this.request('DELETE', `/v1/devices/${encodeURIComponent(handle)}`);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && response.status !== 404) {
      throw new RelayUnavailableError('/v1/devices', response.status);
    }
  }

  async audioSession(callId: string): Promise<RelayAudioSession> {
    const path = '/v1/audio/sessions';
    const response = await this.request('POST', path, { call_id: callId });
    if (response.status === 403 || response.status === 429) {
      let code: string | undefined;
      try {
        code = errorResponseSchema.safeParse(await response.json()).data?.error.code;
      } catch {
        code = undefined;
      }
      if (code !== undefined && AUDIO_REFUSALS.has(code)) {
        throw new RelayAudioRefusedError(code as RelayAudioRefusal);
      }
      throw new RelayUnavailableError(path, response.status);
    }
    const session = await this.json(path, relayAudioSessionResponseSchema, response);
    // Call audio travels encrypted outside development, whatever the relay answers.
    if (!session.url.startsWith('wss://') && this.options.allowInsecureAudio !== true) {
      throw new RelayUnavailableError(path);
    }
    return session;
  }

  async endAudioSession(room: string): Promise<void> {
    await this.endAudio(`/v1/audio/sessions/${encodeURIComponent(room)}`);
  }

  /** Ends the session of a call whose start answer never arrived (the room is not known). */
  async endAudioSessionByCall(callId: string): Promise<void> {
    await this.endAudio(`/v1/audio/sessions/by-call/${encodeURIComponent(callId)}`);
  }

  private async endAudio(path: string): Promise<void> {
    const response = await this.request('DELETE', path);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && response.status !== 404) {
      throw new RelayUnavailableError('/v1/audio/sessions', response.status);
    }
  }

  async probe(request: {
    address: string;
    checks: ('https' | 'http' | 'tcp7881' | 'udp7882')[];
    nonce: string;
  }): Promise<RelayProbeResult> {
    return this.json(
      '/v1/probe',
      relayProbeResponseSchema,
      await this.request('POST', '/v1/probe', request),
    );
  }

  /** This machine's public address as the relay sees it (no relay key needed). */
  async publicIp(): Promise<string> {
    const path = '/v1/ip';
    return (
      await this.json(
        path,
        relayIpResponseSchema,
        await this.request('GET', path, undefined, { auth: false }),
      )
    ).ip;
  }

  /**
   * Deletes this install at the relay with everything it keeps for it (`twring uninstall`). An
   * install the relay no longer knows (401, 404) counts as deleted.
   */
  async deleteInstall(): Promise<void> {
    const response = await this.request('DELETE', RELAY_DELETE_INSTALL_PATH);
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok && response.status !== 401 && response.status !== 404) {
      throw new RelayUnavailableError(RELAY_DELETE_INSTALL_PATH, response.status);
    }
  }

  /** Sets the address the relay may probe for this install (the only one it ever probes). */
  async setAddress(address: string): Promise<void> {
    const path = '/v1/installs/address';
    await this.json(
      path,
      relayInstallAddressResponseSchema,
      await this.request('PUT', path, { address }),
    );
  }

  /**
   * Registers (or re-registers) this server with the relay, proving it holds the server key with a
   * fresh single-use proof. Returns the relay key, which the caller stores (it replaces any older
   * one). Needs no relay key and no running server.
   */
  async registerInstall(
    request: { email: string; news: boolean; address?: string },
    identity: ServerIdentity,
    nowMs: number = Date.now(),
  ): Promise<RelayInstall> {
    const body = {
      email: request.email,
      news: request.news,
      server_id: identity.id,
      public_key: base64urlEncode(identity.publicKeyRaw),
      ...(request.address !== undefined && { address: request.address }),
    };
    const proof = await identity.sign(
      relayInstallProofClaims(
        { server_id: identity.id, ...request },
        {
          jti: newJti(),
          nowSeconds: Math.floor(nowMs / 1000),
          lifetimeSeconds: RELAY_PROOF_LIFETIME_SECONDS,
        },
      ),
    );
    const path = '/v1/installs';
    return this.json(
      path,
      relayInstallResponseSchema,
      await this.request('POST', path, { ...body, proof }, { auth: false }),
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { auth: boolean } = { auth: true },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (options.auth) headers.authorization = `Bearer ${await this.options.relayKey()}`;
    let response: Response;
    try {
      response = await this.fetch(`${this.base}${path}`, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RelayUnavailableError(path.split('/').slice(0, 3).join('/'));
    }
    // Uninstalling deletes the registration; a later 401 means this server needs `twring register`.
    if (options.auth && response.status === 401) this.options.onUnregistered?.();
    return response;
  }

  private async json<T>(path: string, schema: z.ZodType<T>, response: Response): Promise<T> {
    if (!response.ok) {
      let reason: string | undefined;
      try {
        reason = errorResponseSchema.safeParse(await response.json()).data?.error.message;
      } catch {
        reason = undefined;
      }
      // One short printable line at most.
      reason = reason?.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);
      throw new RelayUnavailableError(path, response.status, reason);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new RelayUnavailableError(path, response.status);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new RelayUnavailableError(path, response.status);
    return result.data;
  }
}

export type RingServiceStatus = ServerInfo['ring_service'];

/** How long a known ring service state is shown before asking the relay again. */
export const RING_STATUS_TTL_MS = 10 * 60_000;
/** After a failed check, the wait before asking again (the last known state is shown meanwhile). */
const RING_STATUS_RETRY_MS = 60_000;

/**
 * `GET /v1/server`'s `ring_service`, from the relay, cached 10 minutes. When the relay cannot be
 * reached the last known state is kept; before the relay ever answered it is `unknown`.
 */
const UNKNOWN: RingServiceStatus = { state: 'unknown' };
const UNREGISTERED: RingServiceStatus = { state: 'unregistered' };

/** Calls `log` at most once an hour (the "no longer registered" warning on every relay call). */
export function onceAnHour(
  log: (line: string) => void,
  now: () => number = () => Date.now(),
): (line: string) => void {
  let next = -Infinity;
  return (line) => {
    if (now() < next) return;
    next = now() + 3_600_000;
    log(line);
  };
}

export function cachedRingService(
  relay: Pick<RelayClient, 'status'>,
  options: { now?: () => number; ttlMs?: number } = {},
): {
  provider: () => Promise<RingServiceStatus>;
  /** A push answer told us the ring service state (`paused` or `expired`). */
  record: (state: 'paused' | 'expired') => void;
  /** A relay call answered 401: the ring service no longer knows this server. */
  unregistered: () => void;
} {
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlMs ?? RING_STATUS_TTL_MS;
  let last: RingServiceStatus | undefined;
  let freshUntil = -Infinity;
  let inFlight: Promise<RingServiceStatus> | undefined;

  const refresh = async (): Promise<RingServiceStatus> => {
    try {
      const status = await relay.status();
      last = { state: status.state, paid_until: status.paid_until };
      freshUntil = now() + ttl;
    } catch (error) {
      if (error instanceof RelayUnavailableError && error.status === 401) {
        last = UNREGISTERED;
        freshUntil = now() + ttl;
      } else {
        freshUntil = now() + RING_STATUS_RETRY_MS;
      }
    }
    return last ?? UNKNOWN;
  };

  return {
    provider: () => {
      if (now() < freshUntil && last !== undefined) return Promise.resolve(last);
      if (now() < freshUntil) {
        return Promise.resolve(UNKNOWN);
      }
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    record: (state) => {
      if (last !== undefined && 'paid_until' in last) last = { ...last, state };
    },
    unregistered: () => {
      last = UNREGISTERED;
      freshUntil = now() + ttl;
    },
  };
}
