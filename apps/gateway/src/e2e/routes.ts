import { EventEmitter } from 'node:events';

import type { GatewayEnv } from '@twring/config/gateway';
import {
  base64urlDecode,
  deviceIdFor,
  e2eDeviceIdSchema,
  pairClaimSchema,
  phoneApprovalAcceptSchema,
  phoneApprovalActorSchema,
  phoneApprovalIdSchema,
  phoneApprovalRequestSchema,
  pairOfferIdSchema,
  publicKeySchema,
  recoveryBackupRequestSchema,
  typedPairHandleSchema,
  type E2eDevice,
  type E2eDeviceWithNote,
  type PhoneApproval,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { devUserResolver, type UserResolver } from '../auth';
import { hashConnectorToken } from '../connectors/pairing';
import type { ConnectorRecord, ConnectorRepository } from '../connectors/store';
import { FixedWindowLimiter } from '../rate-limit';
import { E2eDeviceError, type E2eDeviceStore } from './devices-store';
import type { GatewayErrorCode } from './guard';
import { privateChatsAllowed } from './flag';

/** How long a pairing offer can be claimed. */
export const PAIR_OFFER_TTL_MS = 10 * 60_000;
/** Longest wait a computer may ask for while it polls its offer. */
export const PAIR_WAIT_MAX_S = 25;
const BODY_LIMIT = 4 * 1024;
/** A recovery backup: a sealed device key and a short trusted list, well under this. */
const RECOVERY_BODY_LIMIT = 16 * 1024;
/** How long a revoked device stays in the computer's list, so an offline computer still hears. */
export const REVOKED_SHOWN_MS = 30 * 24 * 60 * 60_000;
/** How long a new phone's request to be approved stays open (C3 #11 P4b ruling 1). */
export const PHONE_APPROVAL_TTL_MS = 10 * 60_000;
/** A trust note: well under this (6 device entries sealed). */
const APPROVAL_BODY_LIMIT = 16 * 1024;

export interface E2eRoutesOptions {
  env: Pick<GatewayEnv, 'PRIVATE_CHATS_ENABLED' | 'PRIVATE_CHATS_USERS'>;
  devices: E2eDeviceStore;
  connectors: Pick<ConnectorRepository, 'findByTokenHash'>;
  userFor?: UserResolver;
  /** Phone claims per account per minute (pairing guesses). */
  claimRatePerMinute?: number;
  /** Phone typed-code lookups per account per minute (handle guesses). */
  lookupRatePerMinute?: number;
  /** Connector requests per address per minute, as for the other connector routes. */
  connectorRatePerMinute: number;
  /** Phone reads and writes per account per minute. */
  writeRatePerMinute: number;
  /** Recovery backup reads per account per minute (each one lets the words be guessed offline). */
  recoveryReadRatePerMinute?: number;
  /** A new phone's approval status polls per account per minute (every 2 s while open). */
  approvalPollRatePerMinute?: number;
  /** After a device was removed: tells the account's connected computers (C3 #11). */
  onDevicesChanged?: (userId: string) => void;
  /** A device was removed: its re-wrapped message keys go too (C3 #11 Task 28). */
  onDeviceRemoved?: (userId: string, deviceId: string) => void;
  now?: () => Date;
}

/** An older computer sends no `handle` and `key_mac`; a newer one sends both (typed code). */
const offerRequestSchema = z
  .object({
    connector_public_key: publicKeySchema,
    connector_device_id: e2eDeviceIdSchema,
    handle: typedPairHandleSchema.optional(),
    key_mac: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine((body) => (body.handle === undefined) === (body.key_mac === undefined));
const lookupRequestSchema = z.object({ handle: typedPairHandleSchema }).strict();
const addDevicesRequestSchema = z.object({ offer_id: pairOfferIdSchema }).strict();
const waitQuerySchema = z
  .object({
    wait: z
      .string()
      .regex(/^\d{1,2}$/)
      .transform(Number)
      .optional(),
  })
  .strict();

const CONNECTOR_BEARER = /^Bearer +(cct_[A-Za-z0-9_-]{43})$/i;

const MESSAGES: Partial<Record<GatewayErrorCode, string>> = {
  private_chats_off: 'Private chats are not available for this account.',
  device_cap: 'This account already has 5 devices for private chats. Remove one first.',
  device_conflict: 'This device is already set up differently. Set it up again.',
  offer_expired: 'This code expired. Make a new one on your computer.',
  offer_claimed: 'This code was already used. Make a new one on your computer.',
  not_found: 'No such pairing.',
  no_backup: 'There is no recovery key saved for this account.',
  handle_taken: 'This code is in use. Make a new one.',
  rate_limited: 'Too many tries. Wait a minute and try again.',
  already_added: 'This phone is already set up for private chats.',
  approval_cap: 'Too many phones are waiting for approval. Try again in a few minutes.',
  approval_closed: 'This request was already answered.',
  expired: 'This request expired. Ask again from the new phone.',
  bad_request: 'Invalid request.',
  connector_invalid: 'This computer is not paired any more. Pair it again from the Twring app.',
};

function sendError(reply: FastifyReply, status: number, code: GatewayErrorCode): FastifyReply {
  const body = {
    error: { code, message: MESSAGES[code] ?? 'Request refused.', request_id: reply.request.id },
  };
  return reply.code(status).send(body);
}

const devicesBody = (devices: E2eDevice[] | E2eDeviceWithNote[]) => ({ devices });

/** `?notes=1`: newer clients read each row's trust note (C3 #11 P4b ruling 3). */
const wantsNotes = (request: FastifyRequest) =>
  (request.query as Record<string, unknown> | undefined)?.notes === '1';

/** A device id from the query string, or undefined. */
const queryDevice = (request: FastifyRequest): string | undefined => {
  const value = (request.query as Record<string, unknown> | undefined)?.device_id;
  return e2eDeviceIdSchema.safeParse(value).success ? (value as string) : undefined;
};

const isOpen = (approval: PhoneApproval) =>
  approval.state === 'pending' || approval.state === 'claimed';

/**
 * Private chat pairing and device lists (ADR-044). Everything here is public keys, ids and an
 * HMAC the phone made; the server can neither open a message nor pass pairing off as verified,
 * because the phone checks the MAC and the safety code itself. Logs carry ids and counts only.
 */
export function registerE2eRoutes(app: FastifyInstance, options: E2eRoutesOptions): void {
  const { devices } = options;
  const userFor = options.userFor ?? devUserResolver;
  const now = options.now ?? (() => new Date());
  const claims = new FixedWindowLimiter(options.claimRatePerMinute ?? 5, 60_000);
  const lookups = new FixedWindowLimiter(options.lookupRatePerMinute ?? 5, 60_000);
  const writes = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const recoveryReads = new FixedWindowLimiter(options.recoveryReadRatePerMinute ?? 10, 60_000);
  const approvalPolls = new FixedWindowLimiter(options.approvalPollRatePerMinute ?? 40, 60_000);
  const connectorLimiter = new FixedWindowLimiter(options.connectorRatePerMinute, 60_000);
  const claimed = new EventEmitter();
  claimed.setMaxListeners(0);
  const allowed = (userId: string) => privateChatsAllowed(options.env, userId);

  /** The token's connector, or undefined once a refusal was sent (never returns the reply). */
  const connectorFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ConnectorRecord | undefined> => {
    if (!connectorLimiter.tryAcquire(request.ip)) {
      sendError(reply, 429, 'rate_limited');
      return undefined;
    }
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.length < 256
        ? CONNECTOR_BEARER.exec(header.trim())?.[1]
        : undefined;
    const record =
      token === undefined
        ? undefined
        : await options.connectors.findByTokenHash(hashConnectorToken(token));
    if (record === undefined) {
      void reply.header('www-authenticate', 'Bearer');
      sendError(reply, 401, 'connector_invalid');
      return undefined;
    }
    if (!allowed(record.user_id)) {
      sendError(reply, 404, 'private_chats_off');
      return undefined;
    }
    return record;
  };
  /** The signed-in phone's account, or undefined once a refusal was sent. */
  const phoneFor = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const userId = userFor(request);
    if (!allowed(userId)) {
      sendError(reply, 404, 'private_chats_off');
      return undefined;
    }
    return userId;
  };

  // Computer: offer a pairing. The QR it shows carries the offer id, its key and a secret.
  app.post('/v1/e2e/pairings', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const connector = await connectorFor(request, reply);
    if (connector === undefined) return reply;
    const body = offerRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request');
    let offer;
    try {
      offer = devices.createOffer(connector.user_id, {
        connectorId: connector.id,
        connectorDeviceId: body.data.connector_device_id,
        connectorPublicKey: body.data.connector_public_key,
        expiresAt: new Date(now().getTime() + PAIR_OFFER_TTL_MS),
        ...(body.data.handle !== undefined && { handle: body.data.handle }),
        ...(body.data.key_mac !== undefined && { keyMac: body.data.key_mac }),
      });
    } catch (cause) {
      // The computer picks another code and offers again.
      if (cause instanceof E2eDeviceError && cause.code === 'handle_taken')
        return sendError(reply, 409, 'handle_taken');
      throw cause;
    }
    request.log.info(
      { event: 'e2e_pair_offered', offer_id: offer.id, connector_id: connector.id },
      'e2e pairing offered',
    );
    return { offer_id: offer.id, expires_at: offer.expiresAt };
  });

  // Phone: find the offer a typed code names (C3 #11), in this account only. The handle is the
  // code's first group; the rest never reaches the server. Answers the computer key with the
  // computer's commitment to it, which the phone checks with the secret before trusting the key.
  app.post('/v1/e2e/pairings/lookup', { bodyLimit: BODY_LIMIT }, (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!lookups.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const body = lookupRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request');
    // Unknown, expired, claimed and another account's all answer the same 404.
    const offer = devices.offerByHandle(userId, body.data.handle);
    if (offer?.keyMac === undefined) return sendError(reply, 404, 'not_found');
    request.log.info({ event: 'e2e_pair_looked_up', offer_id: offer.id }, 'e2e pairing looked up');
    return {
      offer_id: offer.id,
      connector_public_key: offer.connectorPublicKey,
      connector_device_id: offer.connectorDeviceId,
      key_mac: offer.keyMac,
    };
  });

  // Phone: claim the offer it scanned. Answers the computer key the server holds, so the phone
  // can check it against the QR before it trusts anything.
  app.post<{ Params: { offerId: string } }>(
    '/v1/e2e/pairings/:offerId/claim',
    { bodyLimit: BODY_LIMIT },
    (request, reply) => {
      const userId = phoneFor(request, reply);
      if (userId === undefined) return reply;
      if (!claims.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const body = pairClaimSchema.safeParse(request.body);
      if (!body.success || body.data.offer_id !== request.params.offerId)
        return sendError(reply, 400, 'bad_request');
      const offer = devices.offer(userId, body.data.offer_id);
      // A typed claim names a key the offer never registered: no such typed code, and the
      // offer stays open for its QR.
      if (offer === undefined || (body.data.key === 'typed' && offer.keyMac === undefined))
        return sendError(reply, 404, 'not_found');
      if (offer.claim !== undefined) return sendError(reply, 409, 'offer_claimed');
      if (Date.parse(offer.expiresAt) <= now().getTime())
        return sendError(reply, 410, 'offer_expired');
      const { offer_id: offerId, ...claim } = body.data;
      const result = devices.claimOffer(userId, offerId, claim);
      if (result === 'already_claimed') return sendError(reply, 409, 'offer_claimed');
      if (result === 'missing') return sendError(reply, 404, 'not_found');
      claimed.emit(offerId);
      request.log.info(
        { event: 'e2e_pair_claimed', offer_id: offerId, device_id: claim.phone_device_id },
        'e2e pairing claimed',
      );
      // The connector id lets the phone bind this computer to its agents (C3 #11 P4a): a
      // reply in a chat is taken only from the computer serving that chat's agent.
      return {
        connector_public_key: offer.connectorPublicKey,
        connector_device_id: offer.connectorDeviceId,
        connector_id: offer.connectorId,
      };
    },
  );

  // Computer: wait for the phone's claim (long poll up to PAIR_WAIT_MAX_S seconds), 204 if none.
  app.get<{ Params: { offerId: string }; Querystring: Record<string, unknown> }>(
    '/v1/e2e/pairings/:offerId',
    async (request, reply) => {
      const connector = await connectorFor(request, reply);
      if (connector === undefined) return reply;
      const query = waitQuerySchema.safeParse(request.query);
      if (!query.success || !pairOfferIdSchema.safeParse(request.params.offerId).success)
        return sendError(reply, 400, 'bad_request');
      const offerId = request.params.offerId;
      const read = () => {
        const offer = devices.offer(connector.user_id, offerId);
        return offer?.connectorId === connector.id ? offer : undefined;
      };
      let offer = read();
      if (offer === undefined) return sendError(reply, 404, 'not_found');
      const waitMs = Math.min(query.data.wait ?? 0, PAIR_WAIT_MAX_S) * 1000;
      if (offer.claim === undefined && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            claimed.off(offerId, done);
            request.raw.off('close', done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          claimed.on(offerId, done);
          request.raw.on('close', done);
        });
        offer = read();
        if (offer === undefined) return sendError(reply, 404, 'not_found');
      }
      if (offer.claim === undefined) {
        if (Date.parse(offer.expiresAt) <= now().getTime())
          return sendError(reply, 410, 'offer_expired');
        return reply.code(204).send();
      }
      return offer.claim;
    },
  );

  // Computer: it checked the phone's MAC, so both devices join the account's list together.
  app.post('/v1/e2e/computer/devices', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const connector = await connectorFor(request, reply);
    if (connector === undefined) return reply;
    const body = addDevicesRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request');
    const offer = devices.offer(connector.user_id, body.data.offer_id);
    if (offer === undefined || offer.connectorId !== connector.id)
      return sendError(reply, 404, 'not_found');
    if (offer.claim === undefined) return sendError(reply, 409, 'not_ready');
    if (Date.parse(offer.expiresAt) <= now().getTime())
      return sendError(reply, 410, 'offer_expired');
    try {
      devices.addAll(connector.user_id, [
        {
          id: offer.connectorDeviceId,
          kind: 'computer',
          name: connector.name.slice(0, 60) || 'Computer',
          public_key: offer.connectorPublicKey,
          connector_id: connector.id,
        },
        {
          id: offer.claim.phone_device_id,
          kind: 'phone',
          name: offer.claim.phone_name,
          public_key: offer.claim.phone_public_key,
        },
      ]);
    } catch (cause) {
      if (cause instanceof E2eDeviceError)
        return sendError(
          reply,
          409,
          cause.code === 'device_cap' ? 'device_cap' : 'device_conflict',
        );
      throw cause;
    }
    devices.deleteOffer(connector.user_id, offer.id);
    const list = devices.list(connector.user_id);
    request.log.info(
      { event: 'e2e_devices_paired', connector_id: connector.id, devices: list.length },
      'e2e devices paired',
    );
    return devicesBody(list);
  });

  // Computer: the account's devices, plus those revoked lately (with `revoked_at`), so the
  // computer stops wrapping to a removed device; an absent device is never taken as revoked.
  app.get('/v1/e2e/computer/devices', async (request, reply) => {
    const connector = await connectorFor(request, reply);
    if (connector === undefined) return reply;
    const since = new Date(now().getTime() - REVOKED_SHOWN_MS);
    return devicesBody(
      wantsNotes(request)
        ? devices.listWithNotes(connector.user_id, since)
        : devices.listWithRevoked(connector.user_id, since),
    );
  });

  // Computer: `private reset` made a new key, so its old device leaves the list (C3 #11 P4a).
  // A computer may remove only its own computer devices, never a phone or another computer.
  app.delete<{ Params: { id: string } }>('/v1/e2e/computer/devices/:id', async (request, reply) => {
    const connector = await connectorFor(request, reply);
    if (connector === undefined) return reply;
    const id = request.params.id;
    if (!e2eDeviceIdSchema.safeParse(id).success) return sendError(reply, 404, 'not_found');
    const own = devices
      .list(connector.user_id)
      .find((d) => d.id === id && d.kind === 'computer' && d.connector_id === connector.id);
    if (own === undefined || !devices.revoke(connector.user_id, id))
      return sendError(reply, 404, 'not_found');
    options.onDeviceRemoved?.(connector.user_id, id);
    request.log.info(
      { event: 'e2e_device_reset', device_id: id, connector_id: connector.id },
      'e2e computer device reset',
    );
    options.onDevicesChanged?.(connector.user_id);
    return reply.code(204).send();
  });

  // Phone: the same list as the computer's, revoked ones marked, so the phone also stops
  // wrapping to a removed device (P4 ruling 3) and its devices screen shows the active ones.
  app.get('/v1/e2e/devices', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const since = new Date(now().getTime() - REVOKED_SHOWN_MS);
    return devicesBody(
      wantsNotes(request)
        ? devices.listWithNotes(userId, since)
        : devices.listWithRevoked(userId, since),
    );
  });

  app.delete<{ Params: { id: string } }>('/v1/e2e/devices/:id', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    if (!e2eDeviceIdSchema.safeParse(request.params.id).success)
      return sendError(reply, 404, 'not_found');
    if (!devices.revoke(userId, request.params.id)) return sendError(reply, 404, 'not_found');
    options.onDeviceRemoved?.(userId, request.params.id);
    request.log.info(
      { event: 'e2e_device_revoked', device_id: request.params.id },
      'e2e device revoked',
    );
    options.onDevicesChanged?.(userId);
    return reply.code(204).send();
  });

  // Phone: the optional recovery backup (C3 #11). The server keeps a salt, a check value and
  // ciphertext; the words and the key never reach it. One backup per account, for an active
  // phone of that account.
  app.put('/v1/e2e/recovery', { bodyLimit: RECOVERY_BODY_LIMIT }, (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const body = recoveryBackupRequestSchema.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'bad_request');
    const device = devices.get(userId, body.data.device_id);
    if (device?.kind !== 'phone') return sendError(reply, 404, 'not_found');
    const saved = devices.putRecovery(userId, body.data);
    request.log.info(
      { event: 'e2e_recovery_saved', device_id: saved.device_id },
      'e2e recovery saved',
    );
    return { updated_at: saved.updated_at };
  });

  app.get('/v1/e2e/recovery', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!recoveryReads.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const backup = devices.recovery(userId);
    if (backup === undefined) return sendError(reply, 404, 'no_backup');
    return { ...backup, device_removed: devices.get(userId, backup.device_id) === undefined };
  });

  app.delete('/v1/e2e/recovery', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    if (devices.deleteRecovery(userId))
      request.log.info({ event: 'e2e_recovery_deleted' }, 'e2e recovery deleted');
    return reply.code(204).send();
  });

  // Approving a second phone (C3 #11, Task 27). The server only relays: the new phone and the
  // approving phone compare a safety code, and the note the approving phone seals is what the
  // other devices check. A hostile server can only make the codes differ.

  /** The body's or query's device, when it is an active phone of this account. */
  const approverFor = (userId: string, deviceId: string | undefined) => {
    const device = deviceId === undefined ? undefined : devices.get(userId, deviceId);
    return device?.kind === 'phone' ? device : undefined;
  };
  /** This account's approval named in the path, or undefined once a refusal was sent. */
  const approvalFor = (userId: string, id: string, reply: FastifyReply) => {
    const approval = phoneApprovalIdSchema.safeParse(id).success
      ? devices.approval(userId, id)
      : undefined;
    if (approval === undefined) {
      sendError(reply, 404, 'not_found');
      return undefined;
    }
    if (approval.state === 'expired') {
      sendError(reply, 410, 'expired');
      return undefined;
    }
    return approval;
  };

  // New phone: ask to be approved. Its device id must be its key's, as at pairing.
  app.post('/v1/e2e/approvals', { bodyLimit: BODY_LIMIT }, (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const body = phoneApprovalRequestSchema.safeParse(request.body);
    if (!body.success || deviceIdFor(base64urlDecode(body.data.public_key)) !== body.data.device_id)
      return sendError(reply, 400, 'bad_request');
    let approval;
    try {
      approval = devices.requestApproval(
        userId,
        body.data,
        new Date(now().getTime() + PHONE_APPROVAL_TTL_MS),
      );
    } catch (cause) {
      if (cause instanceof E2eDeviceError)
        return sendError(
          reply,
          409,
          cause.code === 'already_added' ||
            cause.code === 'approval_cap' ||
            cause.code === 'device_cap'
            ? cause.code
            : 'device_conflict',
        );
      throw cause;
    }
    request.log.info(
      { event: 'e2e_phone_approval_requested', approval_id: approval.id },
      'e2e phone approval requested',
    );
    return approval;
  });

  // Trusted phone: the phones waiting for approval.
  app.get('/v1/e2e/approvals', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    if (approverFor(userId, queryDevice(request)) === undefined)
      return sendError(reply, 404, 'not_found');
    return { approvals: devices.openApprovals(userId) };
  });

  // New phone: its own request, with the approving phone once claimed and the note once accepted.
  app.get<{ Params: { id: string } }>('/v1/e2e/approvals/:id', (request, reply) => {
    const userId = phoneFor(request, reply);
    if (userId === undefined) return reply;
    if (!approvalPolls.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
    const approval = phoneApprovalIdSchema.safeParse(request.params.id).success
      ? devices.approval(userId, request.params.id)
      : undefined;
    if (approval === undefined || approval.device_id !== queryDevice(request))
      return sendError(reply, 404, 'not_found');
    return approval;
  });

  // Trusted phone: take a waiting phone, so both screens can show the same code.
  app.post<{ Params: { id: string } }>(
    '/v1/e2e/approvals/:id/claim',
    { bodyLimit: BODY_LIMIT },
    (request, reply) => {
      const userId = phoneFor(request, reply);
      if (userId === undefined) return reply;
      if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const body = phoneApprovalActorSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'bad_request');
      const approver = approverFor(userId, body.data.device_id);
      if (approver === undefined) return sendError(reply, 404, 'not_found');
      const approval = approvalFor(userId, request.params.id, reply);
      if (approval === undefined) return reply;
      if (!devices.claimApproval(userId, approval.id, approver))
        return sendError(reply, 409, 'approval_closed');
      request.log.info(
        { event: 'e2e_phone_approval_claimed', approval_id: approval.id, device_id: approver.id },
        'e2e phone approval claimed',
      );
      return devices.approval(userId, approval.id);
    },
  );

  // Trusted phone: the codes matched. The new phone joins with the sealed note on its row.
  app.post<{ Params: { id: string } }>(
    '/v1/e2e/approvals/:id/accept',
    { bodyLimit: APPROVAL_BODY_LIMIT },
    (request, reply) => {
      const userId = phoneFor(request, reply);
      if (userId === undefined) return reply;
      if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const body = phoneApprovalAcceptSchema.safeParse(request.body);
      if (
        !body.success ||
        body.data.note.sender_device !== body.data.device_id ||
        body.data.note.approval_id !== request.params.id
      )
        return sendError(reply, 400, 'bad_request');
      const approver = approverFor(userId, body.data.device_id);
      if (approver === undefined) return sendError(reply, 404, 'not_found');
      const approval = approvalFor(userId, request.params.id, reply);
      if (approval === undefined) return reply;
      if (approval.state !== 'claimed' || approval.approver?.id !== approver.id)
        return sendError(reply, 409, 'approval_closed');
      let accepted;
      try {
        accepted = devices.acceptApproval(userId, approval.id, approver.id, body.data.note);
      } catch (cause) {
        if (cause instanceof E2eDeviceError)
          return sendError(
            reply,
            409,
            cause.code === 'device_cap' ? 'device_cap' : 'device_conflict',
          );
        throw cause;
      }
      if (!accepted) return sendError(reply, 409, 'approval_closed');
      request.log.info(
        { event: 'e2e_phone_approved', approval_id: approval.id, device_id: approval.device_id },
        'e2e phone approved',
      );
      options.onDevicesChanged?.(userId);
      return devices.approval(userId, approval.id);
    },
  );

  // Trusted phone: not this phone.
  app.post<{ Params: { id: string } }>(
    '/v1/e2e/approvals/:id/deny',
    { bodyLimit: BODY_LIMIT },
    (request, reply) => {
      const userId = phoneFor(request, reply);
      if (userId === undefined) return reply;
      if (!writes.tryAcquire(userId)) return sendError(reply, 429, 'rate_limited');
      const body = phoneApprovalActorSchema.safeParse(request.body);
      if (!body.success) return sendError(reply, 400, 'bad_request');
      if (approverFor(userId, body.data.device_id) === undefined)
        return sendError(reply, 404, 'not_found');
      const approval = approvalFor(userId, request.params.id, reply);
      if (approval === undefined) return reply;
      if (!isOpen(approval) || !devices.denyApproval(userId, approval.id))
        return sendError(reply, 409, 'approval_closed');
      request.log.info(
        { event: 'e2e_phone_approval_denied', approval_id: approval.id },
        'e2e phone approval denied',
      );
      return reply.code(204).send();
    },
  );
}
