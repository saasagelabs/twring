import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Writable } from 'node:stream';

import {
  base64urlDecode,
  base64urlEncode,
  RELAY_INSTALL_PROOF_AUDIENCE,
  RELAY_INSTALL_PROOF_MAX_SECONDS,
  AUDIO_EXPIRED_MESSAGE,
  AUDIO_LIMIT_REACHED_MESSAGE,
  AUDIO_PAUSED_MESSAGE,
  RELAY_AUDIO_TOKEN_TTL_SECONDS,
  RELAY_DELETE_INSTALL_PATH,
  relayAudioCallIdSchema,
  relayAudioRoom,
  relayAudioSessionRequestSchema,
  relayDeviceRequestSchema,
  relayInstallAddressRequestSchema,
  relayInstallRequestSchema,
  relayProbeRequestSchema,
  relayPushRequestSchema,
  type RelayPushOutcome,
  serverIdFor,
  type ErrorCode,
  type ErrorResponse,
} from '@twring/contracts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { importJWK, jwtVerify } from 'jose';

import {
  AudioSessionStore,
  createAudioRooms,
  AUDIO_SWEEP_EVERY_MS,
  createWebhookReceiver,
  roomEventFromWebhook,
  mintAudioTokens,
  type AudioLiveKit,
  type AudioRooms,
} from './audio';
import { freeUntil, type RelayEnv } from './config';
import type { RelayDb } from './db';
import { sha256Hex } from './installs';
import { checkTicket, DeviceStore } from './devices';
import type { EmailSender } from './email';
import {
  InstallStore,
  normalizeEmail,
  partnerFor,
  ringState,
  safeEqual,
  samePublicKey,
  type Install,
  type Partner,
} from './installs';
import { safeUrl, createLoggerOptions } from './logger';
import { Mailer, pruneEmailSends, RESEND_AFTER_MS } from './mailer';
import { ipv6Groups, isPublicIp, nodeProbeNet, runProbe, type ProbeDeps } from './probe';
import { planDelivery, type RelaySenders } from './push';
import { FixedWindowLimiter } from './rate-limit';
import { UsageStore } from './usage';

/** Registrations per address (IPv4) or /64 (IPv6) per hour. */
export const INSTALLS_PER_HOUR = 5;
/** Email link attempts per address per hour (guessing a 32-byte token is hopeless; this bounds noise). */
const VERIFY_PER_HOUR = 60;
/** Phone registrations per address per hour (each needs a fresh ticket from its server anyway). */
const DEVICES_PER_HOUR = 60;
/** Pushes per install per minute and per day, and per phone per minute. */
export const PUSHES_PER_MINUTE = 60;
export const PUSHES_PER_DAY = 2000;
export const PUSHES_PER_HANDLE_PER_MINUTE = 10;
/** Call audio sessions asked for per install per minute. */
export const AUDIO_SESSIONS_PER_MINUTE = 30;
/** Reachability probes per install per hour. */
export const PROBES_PER_HOUR = 10;
/** Address changes per install per hour. */
const ADDRESS_CHANGES_PER_HOUR = 20;
/** "What is my address" lookups per caller address per hour. */
export const IP_LOOKUPS_PER_HOUR = 30;
/** Probes per target IP per hour, across every install (one IP cannot be hammered via many). */
export const PROBES_PER_TARGET_PER_HOUR = 20;
/** Probes per hostname per hour, across installs, charged before the name is resolved. */
export const PROBES_PER_HOST_PER_HOUR = 20;
/** Probes running at once across the whole relay. */
export const PROBES_IN_FLIGHT = 16;
/** How often held verification emails are retried. */
const EMAIL_RETRY_EVERY_MS = 60_000;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface RelayAppOptions {
  env: RelayEnv;
  db: RelayDb;
  email: EmailSender;
  partners: readonly Partner[];
  now?: () => number;
  /** Runs `run` every `ms`; returns a cancel function. Tests drive it by hand. */
  every?: (ms: number, run: () => Promise<void>) => () => void;
  /** Tests capture log lines here. */
  logStream?: Writable;
  /** The push services; a missing one means pushes to that platform answer `unsupported`. */
  senders?: RelaySenders;
  /** Test seam: closing rooms on Twring's LiveKit. */
  audioRooms?: AudioRooms;
  /** Test seam: the probe's network, timeouts and clock. */
  probe?: Partial<ProbeDeps>;
}

/** A refusal with a stable code; the message is safe to show. */
export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

function sendError(reply: FastifyReply, error: RelayError): FastifyReply {
  const body: ErrorResponse = {
    error: { code: error.code, message: error.message, request_id: reply.request.id },
  };
  return reply.code(error.status).send(body);
}

/** The credential after `scheme` in the Authorization header, if that is the scheme used. */
function credential(request: FastifyRequest, scheme: 'Bearer' | 'Partner'): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const prefix = `${scheme} `;
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : undefined;
}

/** The client address as the relay sees it, with an IPv4-mapped IPv6 address unwrapped. */
function plainIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

/** One spelling per address for comparing: a host is case-insensitive, a trailing slash is noise. */
function sameAddress(a: string, b: string): boolean {
  const norm = (text: string) => text.toLowerCase().replace(/\/$/, '');
  return norm(a) === norm(b);
}

/**
 * The rate-limit key for a client address: IPv4 by full address, IPv6 by its /64 (one customer
 * usually holds a whole /64, so per-address keys would let one client pose as millions).
 */
export function rateKeyFor(ip: string): string {
  if (isIP(ip) !== 6) return `ip:${ip}`;
  const groups = ipv6Groups(ip);
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `ip:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `ip6:${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}`;
}

const BAD_KEY = new RelayError(401, 'auth_invalid', 'This server is not registered for rings.');

/** Resolves the install behind a Bearer relay key. Unknown or revoked keys are 401. */
export function installAuthenticator(
  store: InstallStore,
): (request: FastifyRequest) => Promise<Install> {
  return (request) => {
    const key = credential(request, 'Bearer');
    if (key === undefined || key === '') {
      return Promise.reject(new RelayError(401, 'auth_required', 'A relay key is required.'));
    }
    const install = store.findByKey(key);
    if (install === undefined || install.revokedAt !== undefined) return Promise.reject(BAD_KEY);
    return Promise.resolve(install);
  };
}

/**
 * The proof's `jti` and expiry (ms) when it is a fresh EdDSA JWS by `publicKey` for exactly this
 * request: audience, server id, email, news and address all signed, life at most 600 s.
 */
async function checkProof(
  proof: string,
  publicKey: string,
  request: { server_id: string; email: string; news: boolean; address?: string | undefined },
  now: number,
): Promise<{ jti: string; expiresAt: number } | undefined> {
  try {
    const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: publicKey }, 'EdDSA');
    const { payload } = await jwtVerify(proof, key, {
      algorithms: ['EdDSA'],
      audience: RELAY_INSTALL_PROOF_AUDIENCE,
      currentDate: new Date(now),
      requiredClaims: ['exp', 'iat', 'jti'],
    });
    const exp = payload.exp!;
    const iat = payload.iat!;
    const jti = payload.jti!;
    const holds =
      payload.server_id === request.server_id &&
      payload.email === request.email &&
      payload.news === request.news &&
      payload.address === request.address &&
      jti.length >= 16 &&
      jti.length <= 128 &&
      exp - iat <= RELAY_INSTALL_PROOF_MAX_SECONDS &&
      exp - Math.floor(now / 1000) <= RELAY_INSTALL_PROOF_MAX_SECONDS;
    return holds ? { jti, expiresAt: exp * 1000 } : undefined;
  } catch {
    return undefined;
  }
}

/** A plain page. Only fixed text is rendered, plus `form` (built from a validated link code). */
function page(title: string, text: string, form = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1>${title}</h1><p>${text}</p>${form}</body></html>`;
}

const LINK_FAILED = page(
  'This link did not work',
  'It may have been used already or be more than 7 days old.',
);

export async function buildApp(options: RelayAppOptions): Promise<FastifyInstance> {
  const { env } = options;
  const now = options.now ?? Date.now;
  const store = new InstallStore(options.db);
  const authInstall = installAuthenticator(store);
  const installLimiter = new FixedWindowLimiter(INSTALLS_PER_HOUR, 3_600_000, now);
  const newInstallLimiter = new FixedWindowLimiter(env.RELAY_INSTALLS_PER_HOUR, 3_600_000, now);
  const verifyLimiter = new FixedWindowLimiter(VERIFY_PER_HOUR, 3_600_000, now);
  const devices = new DeviceStore(options.db);
  const usage = new UsageStore(options.db);
  const senders = options.senders ?? {};
  const deviceLimiter = new FixedWindowLimiter(DEVICES_PER_HOUR, 60 * 60_000, now);
  const installMinute = new FixedWindowLimiter(PUSHES_PER_MINUTE, 60_000, now);
  const installDay = new FixedWindowLimiter(PUSHES_PER_DAY, 86_400_000, now);
  const handleMinute = new FixedWindowLimiter(PUSHES_PER_HANDLE_PER_MINUTE, 60_000, now);
  // One phone's token, however many handles hold it, gets the per-phone budget.
  const tokenMinute = new FixedWindowLimiter(PUSHES_PER_HANDLE_PER_MINUTE, 60_000, now);
  const audioMinute = new FixedWindowLimiter(AUDIO_SESSIONS_PER_MINUTE, 60_000, now);
  const probeHour = new FixedWindowLimiter(PROBES_PER_HOUR, 3_600_000, now);
  const addressLimiter = new FixedWindowLimiter(ADDRESS_CHANGES_PER_HOUR, 3_600_000, now);
  const ipLimiter = new FixedWindowLimiter(IP_LOOKUPS_PER_HOUR, 3_600_000, now);
  const targetLimiter = new FixedWindowLimiter(PROBES_PER_TARGET_PER_HOUR, 3_600_000, now);
  const hostLimiter = new FixedWindowLimiter(PROBES_PER_HOST_PER_HOUR, 3_600_000, now);
  const probeDeps: ProbeDeps = {
    net: options.probe?.net ?? nodeProbeNet,
    timeout: options.probe?.timeout ?? ((ms) => AbortSignal.timeout(ms)),
    clock: options.probe?.clock ?? (() => performance.now()),
    allowTarget: (ip) => targetLimiter.tryAcquire(rateKeyFor(ip)),
    allowHost: (host) => hostLimiter.tryAcquire(host),
  };
  let probesInFlight = 0;
  const audioSessions = new AudioSessionStore(
    options.db,
    usage,
    {
      maxConcurrent: env.RELAY_AUDIO_MAX_CONCURRENT,
      minutesPerDay: env.RELAY_AUDIO_MINUTES_PER_DAY,
      maxConcurrentTotal: env.RELAY_AUDIO_MAX_CONCURRENT_TOTAL,
      minutesPerDayTotal: env.RELAY_AUDIO_DAILY_MINUTES_TOTAL,
    },
    { warn: (fields, message) => app.log.warn(fields, message) },
  );
  const audioLiveKit: AudioLiveKit | undefined =
    env.RELAY_AUDIO_ENABLED &&
    env.RELAY_LIVEKIT_URL !== undefined &&
    env.RELAY_LIVEKIT_API_KEY !== undefined &&
    env.RELAY_LIVEKIT_API_SECRET !== undefined
      ? {
          url: env.RELAY_LIVEKIT_URL,
          apiKey: env.RELAY_LIVEKIT_API_KEY,
          apiSecret: env.RELAY_LIVEKIT_API_SECRET,
        }
      : undefined;
  const audioRooms =
    options.audioRooms ?? (audioLiveKit === undefined ? undefined : createAudioRooms(audioLiveKit));

  const app = Fastify({
    logger: {
      ...createLoggerOptions(env),
      ...(options.logStream !== undefined && { stream: options.logStream }),
    },
    // Fastify's own request lines can carry the full URL; the relay logs the path only (below).
    disableRequestLogging: true,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    bodyLimit: 16 * 1024,
    // Only behind a proxy we control; otherwise X-Forwarded-For would let clients dodge rate limits.
    trustProxy: env.TRUST_PROXY,
  });

  const mailer = new Mailer({
    db: options.db,
    sender: options.email,
    publicUrl: env.RELAY_PUBLIC_URL,
    perDay: env.RELAY_EMAILS_PER_DAY,
    now,
    log: app.log,
  });
  const every =
    options.every ??
    ((ms, run) => {
      const timer = setInterval(() => void run().catch(() => undefined), ms);
      timer.unref();
      return () => clearInterval(timer);
    });
  const stopRetry = every(EMAIL_RETRY_EVERY_MS, () => mailer.retryPending());
  // Retention runs whether or not Twring audio is on: 90-day call records, 1-day send records.
  const stopSweep = every(AUDIO_SWEEP_EVERY_MS, async () => {
    audioSessions.prune(now());
    pruneEmailSends(options.db, now());
    if (audioRooms !== undefined) await audioSessions.sweep(audioRooms, now());
  });
  app.addHook('onClose', () => {
    stopRetry();
    stopSweep();
    return Promise.resolve();
  });

  app.addHook('onResponse', (request, reply, done) => {
    request.log.info(
      {
        method: request.method,
        // The route pattern, not the URL: device paths carry a handle.
        path: request.routeOptions.url ?? safeUrl(request.url),
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  app.setNotFoundHandler((_request, reply) =>
    sendError(reply, new RelayError(404, 'not_found', 'Not found.')),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RelayError) return sendError(reply, error);
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendError(reply, new RelayError(status, 'bad_request', 'That request was not valid.'));
    }
    request.log.error({ err: error }, 'request failed');
    return sendError(reply, new RelayError(500, 'internal_error', 'Something went wrong.'));
  });

  app.get('/health', () => ({ ok: true }));

  app.post('/v1/installs', async (request, reply) => {
    if (!installLimiter.tryAcquire(rateKeyFor(request.ip))) {
      throw new RelayError(429, 'rate_limited', 'Too many registrations. Try again later.');
    }
    let partnerId: string | undefined;
    if (request.headers.authorization !== undefined) {
      const token = credential(request, 'Partner');
      const partner = token === undefined ? undefined : partnerFor(options.partners, token);
      if (partner === undefined) {
        throw new RelayError(401, 'auth_invalid', 'That partner credential is not valid.');
      }
      partnerId = partner.id;
    }

    const parsed = relayInstallRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'Check the email address and try again.');
    }
    const body = parsed.data;
    let publicKeyRaw: Uint8Array;
    try {
      publicKeyRaw = base64urlDecode(body.public_key);
    } catch {
      throw new RelayError(400, 'invalid_request', 'The server key is not valid.');
    }
    // One spelling per key: a variant encoding of the same bytes must not count as another key.
    if (publicKeyRaw.length !== 32 || base64urlEncode(publicKeyRaw) !== body.public_key) {
      throw new RelayError(400, 'invalid_request', 'The server key is not valid.');
    }
    if (serverIdFor(publicKeyRaw) !== body.server_id) {
      throw new RelayError(400, 'invalid_request', 'The server id does not match its key.');
    }
    const at = now();
    const proof = await checkProof(body.proof, body.public_key, body, at);
    if (proof === undefined || !store.useProof(proof.jti, proof.expiresAt, at)) {
      throw new RelayError(401, 'auth_invalid', 'The server could not prove it holds its key.');
    }

    const email = normalizeEmail(body.email);
    const existing = store.findByServerId(body.server_id);
    let result: { install: Install; key: string };
    if (existing === undefined) {
      if (!newInstallLimiter.tryAcquire('all')) {
        throw new RelayError(
          429,
          'rate_limited',
          'Many servers are signing up right now. Try again in an hour.',
        );
      }
      result = store.create(
        {
          serverId: body.server_id,
          publicKey: body.public_key,
          email,
          news: body.news,
          ...(body.address !== undefined && { address: body.address }),
          ...(partnerId !== undefined && { partnerId }),
          paidUntil: freeUntil(env),
        },
        at,
      );
    } else if (existing.revokedAt !== undefined) {
      throw new RelayError(403, 'forbidden', 'This server can no longer use the ring service.');
    } else if (!samePublicKey(existing.publicKey, body.public_key)) {
      throw new RelayError(409, 'invalid_request', 'This server is already registered.');
    } else {
      result = store.reissue(
        existing,
        {
          email,
          news: body.news,
          ...(body.address !== undefined && { address: body.address }),
        },
        at,
      );
    }

    if (result.install.verifiedAt === undefined) {
      const last = store.lastEmailAt(result.install.id);
      if (last === undefined || at - last >= RESEND_AFTER_MS) {
        await mailer.request(result.install.id);
      }
    }
    request.log.info(
      {
        event: existing === undefined ? 'install_created' : 'install_rekeyed',
        install_id: result.install.id,
      },
      'install registered',
    );
    return reply.code(201).send({
      install_id: result.install.id,
      relay_key: result.key,
      paid_until: result.install.paidUntil,
      verified: result.install.verifiedAt !== undefined,
    });
  });

  // GET (and HEAD) only show a Confirm button: link scanners open links, people press buttons.
  app.get<{ Querystring: { t?: unknown } }>('/v1/installs/verify', (request, reply) => {
    reply.type('text/html; charset=utf-8');
    const token = request.query.t;
    if (typeof token !== 'string' || !LINK_TOKEN_PATTERN.test(token)) {
      return reply.code(400).send(LINK_FAILED);
    }
    return reply.send(
      page(
        'Confirm your Twring server',
        'Press Confirm so your phone keeps ringing when it is locked.',
        `<form method="post" action="/v1/installs/verify"><input type="hidden" name="t" value="${token}"><button type="submit" style="font-size:1.1rem;padding:.75rem 1.5rem">Confirm</button></form>`,
      ),
    );
  });

  app.post<{ Body: { t?: unknown } | undefined }>('/v1/installs/verify', (request, reply) => {
    reply.type('text/html; charset=utf-8');
    if (!verifyLimiter.tryAcquire(rateKeyFor(request.ip))) {
      return reply
        .code(429)
        .send(page('Try again later', 'Too many tries. Wait an hour and open the link again.'));
    }
    const token = request.body?.t;
    if (
      typeof token !== 'string' ||
      !LINK_TOKEN_PATTERN.test(token) ||
      !store.verify(token, now())
    ) {
      return reply.code(400).send(LINK_FAILED);
    }
    request.log.info({ event: 'install_verified' }, 'install verified');
    return reply.send(
      page(
        'Your Twring server is confirmed',
        'Thanks. Your phone will keep ringing when it is locked.',
      ),
    );
  });

  app.get('/v1/status', async (request) => {
    const install = await authInstall(request);
    return {
      state: ringState(install, now()),
      paid_until: install.paidUntil,
      verified: install.verifiedAt !== undefined,
    };
  });

  // The server deletes itself (`twring uninstall`): the install, its phones, usage, call records
  // and its address's email send records.
  /** One deletion for the server's own request and an operator's privacy request alike. */
  const deleteInstall = async (installId: string) => {
    if (audioRooms !== undefined) {
      for (const room of audioSessions.openRooms(installId)) {
        await audioRooms.deleteRoom(room).catch(() => undefined);
      }
    }
    store.delete(installId);
  };
  const requireAdmin = (request: FastifyRequest) => {
    const token = credential(request, 'Bearer');
    if (token === undefined || !safeEqual(token, env.RELAY_ADMIN_TOKEN)) {
      throw new RelayError(401, 'auth_invalid', 'Not allowed.');
    }
  };

  app.delete(RELAY_DELETE_INSTALL_PATH, async (request, reply) => {
    const install = await authInstall(request);
    await deleteInstall(install.id);
    request.log.info({ event: 'install_deleted', install_id: install.id }, 'install deleted');
    return reply.code(204).send();
  });

  // Privacy requests (Twring's operations notes, private): the operator deletes by server or by email.
  app.delete<{ Params: { id: string } }>('/v1/admin/installs/:id', async (request, reply) => {
    requireAdmin(request);
    if (store.findById(request.params.id) === undefined) {
      throw new RelayError(404, 'not_found', 'No such install.');
    }
    await deleteInstall(request.params.id);
    request.log.info(
      { event: 'install_deleted_by_admin', install_id: request.params.id },
      'install deleted',
    );
    return reply.code(204).send();
  });

  app.post('/v1/admin/installs/delete-by-email', async (request) => {
    requireAdmin(request);
    const body = request.body as { email?: unknown } | undefined;
    const email = body?.email;
    if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
      throw new RelayError(400, 'invalid_request', 'Send {"email":"..."}.');
    }
    const ids = store.idsByEmail(email);
    for (const id of ids) await deleteInstall(id);
    store.forgetEmailSends(email);
    request.log.info(
      { event: 'installs_deleted_by_email', count: ids.length },
      'installs deleted by email',
    );
    return { deleted: ids.length };
  });

  // The installer asks the relay for its own public address before registering it.
  app.get('/v1/ip', (request) => {
    if (!ipLimiter.tryAcquire(rateKeyFor(request.ip))) {
      throw new RelayError(429, 'rate_limited', 'Too many tries. Try again later.');
    }
    const ip = plainIp(request.ip);
    // A private address here means the relay's proxy setting is wrong, not the caller's address.
    if (!isPublicIp(ip)) {
      request.log.warn({ event: 'relay_misconfigured' }, 'GET /v1/ip saw a non-public address');
      throw new RelayError(503, 'relay_misconfigured', 'Twring could not see your public address.');
    }
    return { ip };
  });

  app.put('/v1/installs/address', async (request) => {
    const install = await authInstall(request);
    if (!addressLimiter.tryAcquire(install.id)) {
      throw new RelayError(429, 'rate_limited', 'Too many changes. Try again later.');
    }
    const parsed = relayInstallAddressRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'That server address is not valid.');
    }
    store.setAddress(install.id, parsed.data.address);
    request.log.info({ event: 'install_address_set', install_id: install.id }, 'address set');
    return { address: parsed.data.address };
  });

  // Reachability from the internet, only ever of the install's own registered address.
  app.post('/v1/probe', async (request) => {
    const install = await authInstall(request);
    const state = ringState(install, now());
    if (state === 'paused' || state === 'expired') {
      throw new RelayError(403, 'forbidden', 'This server cannot use Twring services right now.');
    }
    const parsed = relayProbeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'That check was not valid.');
    }
    const body = parsed.data;
    // The asked-for address only has to match; the target is always the stored one.
    if (install.address === undefined || !sameAddress(install.address, body.address)) {
      throw new RelayError(409, 'invalid_request', 'Register this server address first.');
    }
    if (!probeHour.tryAcquire(install.id)) {
      throw new RelayError(429, 'rate_limited', 'Too many checks. Try again later.');
    }
    if (probesInFlight >= PROBES_IN_FLIGHT) {
      throw new RelayError(429, 'rate_limited', 'Too many checks. Try again later.');
    }
    probesInFlight += 1;
    let outcome: Awaited<ReturnType<typeof runProbe>>;
    try {
      outcome = await runProbe(probeDeps, {
        address: install.address,
        serverId: install.serverId,
        checks: body.checks,
        nonce: body.nonce,
      });
    } finally {
      probesInFlight -= 1;
    }
    if (!outcome.ok && outcome.reason === 'busy') {
      throw new RelayError(429, 'rate_limited', 'Too many checks. Try again later.');
    }
    if (!outcome.ok) {
      throw new RelayError(
        400,
        'invalid_request',
        outcome.reason === 'invalid_address'
          ? 'That server address is not valid.'
          : outcome.reason === 'unresolved'
            ? 'That server address could not be found.'
            : 'That server address is not reachable from the internet.',
      );
    }
    request.log.info({ event: 'probe', install_id: install.id }, 'probe finished');
    return { results: outcome.results };
  });

  app.post<{ Params: { id: string } }>('/v1/admin/installs/:id/revoke', (request) => {
    const token = credential(request, 'Bearer');
    if (token === undefined || !safeEqual(token, env.RELAY_ADMIN_TOKEN)) {
      throw new RelayError(401, 'auth_invalid', 'Not allowed.');
    }
    if (!store.revoke(request.params.id, now())) {
      throw new RelayError(404, 'not_found', 'No such install.');
    }
    request.log.info(
      { event: 'install_revoked', install_id: request.params.id },
      'install revoked',
    );
    return { revoked: true };
  });

  const pushOutcome = (reply: FastifyReply, status: number, outcome: RelayPushOutcome) =>
    reply.code(status).send({ outcome });

  app.post('/v1/devices', async (request, reply) => {
    if (!deviceLimiter.tryAcquire(rateKeyFor(request.ip))) {
      throw new RelayError(429, 'rate_limited', 'Too many tries. Try again later.');
    }
    const parsed = relayDeviceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'That phone could not be set up for rings.');
    }
    const body = parsed.data;
    const at = now();
    const ticket = await checkTicket(body.ticket, store, at);
    if (
      ticket === undefined ||
      !devices.useTicket(ticket.install.serverId, ticket.jti, ticket.expiresAt, at)
    ) {
      throw new RelayError(401, 'auth_invalid', 'This phone could not be set up for rings.');
    }
    const handle = devices.register(
      ticket.install.id,
      ticket.deviceRef,
      {
        platform: body.platform,
        ...(body.fcm_token !== undefined && { fcmToken: body.fcm_token }),
        ...(body.voip_token !== undefined && { voipToken: body.voip_token }),
        ...(body.apns_token !== undefined && { apnsToken: body.apns_token }),
      },
      at,
    );
    request.log.info(
      { event: 'device_registered', install_id: ticket.install.id, platform: body.platform },
      'device registered',
    );
    return reply.code(201).send({ handle });
  });

  app.post('/v1/push', async (request, reply) => {
    const install = await authInstall(request);
    const parsed = relayPushRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'That push was not valid.');
    }
    const body = parsed.data;
    const at = now();
    const state = ringState(install, at);
    if (state === 'paused' || state === 'expired') return pushOutcome(reply, 200, state);
    const device = devices.findForInstall(body.handle, install.id);
    if (device === undefined) return pushOutcome(reply, 404, 'invalid');
    const planned = planDelivery(senders, device, body);
    if (planned === undefined) return pushOutcome(reply, 200, 'unsupported');
    // Budgets are charged only for a send that happens, phone windows checked first, so a noisy
    // phone (or a refused push) never spends the install's budget.
    const tokenKey = sha256Hex(planned.token);
    const windows: [FixedWindowLimiter, string][] = [
      [handleMinute, device.id],
      [tokenMinute, tokenKey],
      [installMinute, install.id],
      [installDay, install.id],
    ];
    if (!windows.every(([limiter, key]) => limiter.allows(key))) {
      return pushOutcome(reply, 429, 'limited');
    }
    for (const [limiter, key] of windows) limiter.tryAcquire(key);
    const outcome = await planned.send();
    request.log.info(
      { event: 'push', install_id: install.id, kind: body.kind, outcome },
      'push delivered',
    );
    if (outcome === 'invalid') {
      devices.markStale(device.id, at);
      return pushOutcome(reply, 404, 'invalid');
    }
    if (outcome === 'skipped') return pushOutcome(reply, 200, 'unsupported');
    if (outcome !== 'sent') {
      throw new RelayError(503, 'service_unavailable', 'The ring could not be sent. Try again.');
    }
    usage.count(install.id, body.kind, at);
    return pushOutcome(reply, 200, 'sent');
  });

  app.delete<{ Params: { handle: string } }>('/v1/devices/:handle', async (request, reply) => {
    const install = await authInstall(request);
    if (!devices.remove(request.params.handle, install.id)) {
      throw new RelayError(404, 'not_found', 'No such phone.');
    }
    request.log.info({ event: 'device_removed', install_id: install.id }, 'device removed');
    return reply.code(204).send();
  });

  app.post('/v1/audio/sessions', async (request, reply) => {
    const install = await authInstall(request);
    if (audioLiveKit === undefined) {
      throw new RelayError(503, 'service_unavailable', 'Twring call audio is not available.');
    }
    const at = now();
    const state = ringState(install, at);
    // Rings keep a grace while the email is unconfirmed; Twring-run audio does not.
    if (state === 'paused' || state === 'unverified') {
      throw new RelayError(403, 'audio_paused', AUDIO_PAUSED_MESSAGE);
    }
    if (state === 'expired') {
      throw new RelayError(403, 'audio_expired', AUDIO_EXPIRED_MESSAGE);
    }
    if (!audioMinute.tryAcquire(install.id)) {
      throw new RelayError(429, 'audio_limit_reached', AUDIO_LIMIT_REACHED_MESSAGE);
    }
    const parsed = relayAudioSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new RelayError(400, 'invalid_request', 'That call id is not valid.');
    }
    const callId = parsed.data.call_id;
    const opened = audioSessions.open(install.id, callId, at);
    if (!opened.ok) {
      if (opened.reason === 'exists') {
        throw new RelayError(409, 'invalid_request', 'That call already has audio.');
      }
      // Calls at once, or today's minutes: one message, the server may try again later.
      throw new RelayError(429, 'audio_limit_reached', AUDIO_LIMIT_REACHED_MESSAGE);
    }
    let tokens: { caller: string; server: string };
    try {
      tokens = await mintAudioTokens(audioLiveKit, opened.room, callId);
    } catch (error) {
      audioSessions.discard(opened.room);
      throw error;
    }
    request.log.info(
      { event: 'audio_session_started', install_id: install.id },
      'audio session started',
    );
    return reply.code(201).send({
      url: audioLiveKit.url,
      room: opened.room,
      caller_token: tokens.caller,
      server_token: tokens.server,
      expires_at: new Date(at + RELAY_AUDIO_TOKEN_TTL_SECONDS * 1000).toISOString(),
    });
  });

  const endSession = (
    request: FastifyRequest,
    reply: FastifyReply,
    install: Install,
    room: string,
  ) => {
    const outcome = audioSessions.requestEnd(install.id, room, now());
    // Another install's room is reported exactly as an unknown one, and never touched.
    if (outcome === 'missing') throw new RelayError(404, 'not_found', 'No such call.');
    if (outcome === 'ending') {
      // The relay closes the room itself; LiveKit's room_finished then settles the minutes.
      void audioRooms?.deleteRoom(room).catch(() => undefined);
      request.log.info(
        { event: 'audio_session_ending', install_id: install.id },
        'audio session ending',
      );
    }
    return reply.code(204).send();
  };

  app.delete<{ Params: { room: string } }>('/v1/audio/sessions/:room', async (request, reply) => {
    const install = await authInstall(request);
    return endSession(request, reply, install, request.params.room);
  });

  // For a start whose answer never reached the server: it knows the call id, not the room.
  app.delete<{ Params: { callId: string } }>(
    '/v1/audio/sessions/by-call/:callId',
    async (request, reply) => {
      const install = await authInstall(request);
      const callId = relayAudioCallIdSchema.safeParse(request.params.callId);
      if (!callId.success) {
        throw new RelayError(400, 'invalid_request', 'That call id is not valid.');
      }
      return endSession(request, reply, install, relayAudioRoom(install.id, callId.data));
    },
  );

  // LiveKit's webhooks (signed with Twring's LiveKit key) end sessions: authoritative for minutes.
  const webhooks = audioLiveKit && createWebhookReceiver(audioLiveKit);
  app.addContentTypeParser(
    'application/webhook+json',
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  );
  app.post('/v1/livekit/webhook', async (request, reply) => {
    if (webhooks === undefined) throw new RelayError(404, 'not_found', 'Not found.');
    const header = request.headers.authorization;
    let roomEvent: Awaited<ReturnType<typeof roomEventFromWebhook>>;
    try {
      roomEvent = await roomEventFromWebhook(
        webhooks,
        typeof request.body === 'string' ? request.body : '',
        typeof header === 'string' ? header : undefined,
      );
    } catch {
      throw new RelayError(401, 'auth_invalid', 'Not allowed.');
    }
    if (roomEvent?.kind === 'finished' && audioSessions.finished(roomEvent.room, now())) {
      request.log.info({ event: 'audio_session_finished' }, 'audio session finished');
    }
    // In use after its end: close it again; the minutes run until it finishes.
    if (roomEvent?.kind === 'started' && audioSessions.started(roomEvent.room, now())) {
      void audioRooms?.deleteRoom(roomEvent.room).catch(() => undefined);
    }
    return reply.code(200).send({ ok: true });
  });

  await app.ready();
  return app;
}
