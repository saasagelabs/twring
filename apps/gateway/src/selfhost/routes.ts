import {
  base64urlEncode,
  normalizePairingCode,
  pairRequestSchema,
  relayHandleRequestSchema,
  type AudioMode,
  type DeviceSummary,
  type ErrorCode,
  type ErrorResponse,
  type PairResponse,
  type ServerInfo,
  SERVER_PROOF_AUDIENCE,
  serverNonceSchema,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { bearerToken, type UserResolver } from '../auth';
import { ipKey } from '../connectors/link-requests';
import { FixedWindowLimiter } from '../rate-limit';

import type { ServerIdentity } from './identity';
import type { PairedDeviceRecord, PersonRecord, SelfhostStores } from './people';
import type { PersonRemover } from './removal';
import { mintDeviceTicket } from './tickets';

export const PAIR_CODE_FAILED = "That code didn't work. Ask for a new one.";
const ADMIN_ONLY = 'Only an admin can do that.';

/** What the ring service says about this install (from the relay, cached). */
export type RingServiceStatus = ServerInfo['ring_service'];
export type RingServiceProvider = () => Promise<RingServiceStatus>;

/** For tests and tools without a relay: active, with a far `paid_until`. */
export const placeholderRingService: RingServiceProvider = () =>
  Promise.resolve({ state: 'active', paid_until: '2099-12-31T00:00:00.000Z' });

export interface SelfhostRoutesOptions {
  stores: SelfhostStores;
  remover: PersonRemover;
  identity: ServerIdentity;
  serverName: string;
  audio: AudioMode;
  spaceId: string;
  ringService: RingServiceProvider;
  /** `TWRING_RELAY_URL`: where a phone registers for rings with its device ticket. */
  relayUrl: string;
  userFor: UserResolver;
  /** Pair attempts per minute per address (Global Constraints: 5). */
  pairPerMinutePerIp?: number;
  /** Wrong well-formed codes per hour for the whole server (6000; codes are 1 of 31^8; malformed
   * ones count per address only). */
  pairPerHour?: number;
  nowMs?: () => number;
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

export function deviceSummary(device: PairedDeviceRecord): DeviceSummary {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
  };
}

const personView = (p: PersonRecord) => ({ id: p.id, display_name: p.display_name, role: p.role });

/**
 * Self-hosted server routes (`TWRING_MODE=selfhost` only): the server's identity, pairing a phone
 * with a code, and people and phones. Removing a phone never touches a live call: the next
 * request from that phone simply answers 401.
 */
export function registerSelfhostRoutes(app: FastifyInstance, options: SelfhostRoutesOptions): void {
  const { stores, identity, userFor } = options;
  const now = options.nowMs ?? (() => performance.now());
  const ipLimiter = new FixedWindowLimiter(options.pairPerMinutePerIp ?? 5, 60_000, now);
  const serverLimiter = new FixedWindowLimiter(options.pairPerHour ?? 6000, 60 * 60_000, now);

  const serverInfo = async (): Promise<ServerInfo> => ({
    server_id: identity.id,
    name: options.serverName,
    mode: 'selfhost',
    audio: options.audio,
    ring_service: await options.ringService(),
  });

  /** The acting person, if still on the server (the auth hook already refused removed ones). */
  const actor = async (request: FastifyRequest): Promise<PersonRecord | undefined> => {
    const person = await stores.people.get(userFor(request));
    return person?.removed_at === undefined ? person : undefined;
  };

  /** The phone making this request (the auth hook already refused removed ones). */
  const currentDevice = async (request: FastifyRequest) => {
    const token = bearerToken(request);
    const found = token === undefined ? undefined : await stores.devices.resolve(token);
    return found?.device.removed_at === undefined &&
      found?.person !== undefined &&
      found.person.removed_at === undefined
      ? found.device
      : undefined;
  };
  const relayLimiter = new FixedWindowLimiter(10, 60_000, now);

  // With `?nonce=`: the public key and a proof by the server key, so the app can tell this server
  // really holds the key behind its id (contracts verifyServerProof).
  app.get<{ Querystring: { nonce?: string } }>('/v1/server', async (request, reply) => {
    const info = await serverInfo();
    if (request.query.nonce === undefined) return info;
    const nonce = serverNonceSchema.safeParse(request.query.nonce);
    if (!nonce.success) return sendError(reply, 400, 'bad_request', 'That check was not valid.');
    const proof = await identity.sign({
      aud: SERVER_PROOF_AUDIENCE,
      server_id: identity.id,
      nonce: nonce.data,
      iat: Math.floor(Date.now() / 1000),
    });
    return { ...info, public_key: base64urlEncode(identity.publicKeyRaw), proof };
  });

  app.post('/v1/pair', { bodyLimit: 4096 }, async (request, reply) => {
    const tooMany = () =>
      sendError(reply, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    // Per address (an IPv6 /64 counts as one); the server-wide budget is charged below, only for
    // well-formed codes that fail, so junk requests cannot lock everyone out of pairing.
    if (!ipLimiter.tryAcquire(`ip:${ipKey(request.ip)}`) || !serverLimiter.hasRoom('server')) {
      return tooMany();
    }
    const raw: unknown = request.body;
    const body =
      typeof raw === 'object' && raw !== null && 'code' in raw && typeof raw.code === 'string'
        ? { ...raw, code: normalizePairingCode(raw.code) ?? raw.code }
        : raw;
    const parsed = pairRequestSchema.safeParse(body);
    if (!parsed.success) {
      const codeBad =
        typeof body === 'object' &&
        body !== null &&
        parsed.error.issues.some((issue) => issue.path[0] === 'code');
      return codeBad
        ? sendError(reply, 400, 'pairing_invalid', PAIR_CODE_FAILED)
        : sendError(reply, 400, 'bad_request', 'Check your name and try again.');
    }
    const grant = await stores.codes.consume(parsed.data.code);
    if (grant === undefined) {
      if (!serverLimiter.tryAcquire('server')) return tooMany();
      request.log.info({ event: 'pair_refused' }, 'pairing code refused');
      return sendError(reply, 400, 'pairing_invalid', PAIR_CODE_FAILED);
    }
    const person = await stores.people.create({
      displayName: parsed.data.display_name,
      role: grant.role,
      spaceId: grant.spaceId,
    });
    const { device, token } = await stores.devices.create({
      personId: person.id,
      name: parsed.data.device_name,
      platform: parsed.data.platform,
      sealPublicKey: parsed.data.seal_public_key,
    });
    request.log.info(
      { event: 'phone_paired', role: person.role, platform: device.platform },
      'phone paired',
    );
    const response: PairResponse = {
      person: personView(person),
      device: { id: device.id, token },
      server: await serverInfo(),
      seal_server_public_key: device.server_seal_public_key,
    };
    return reply.code(201).send(response);
  });

  /** `?removed=1` (admins): people removed but not purged, so they can still be purged. */
  app.get<{ Querystring: { removed?: string } }>('/v1/people', async (request, reply) => {
    const me = await actor(request);
    if (me === undefined) return sendError(reply, 404, 'not_found', 'No such person.');
    const removed = request.query.removed === '1';
    if (removed && me.role !== 'admin') return sendError(reply, 403, 'forbidden', ADMIN_ONLY);
    const people = removed
      ? await stores.people.listRemoved(me.space_id)
      : me.role === 'admin'
        ? await stores.people.list(me.space_id)
        : [me];
    return {
      people: await Promise.all(
        people.map(async (p) => ({
          ...personView(p),
          devices: (await stores.devices.listFor(p.id)).map(deviceSummary),
        })),
      ),
    };
  });

  app.post('/v1/people/codes', async (request, reply) => {
    const me = await actor(request);
    if (me?.role !== 'admin') return sendError(reply, 403, 'forbidden', ADMIN_ONLY);
    const { code, expiresAt } = await stores.codes.mint('member', me.space_id);
    return reply.code(201).send({ code, expires_at: expiresAt.toISOString() });
  });

  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    '/v1/people/:id',
    async (request, reply) => {
      const me = await actor(request);
      if (me?.role !== 'admin') return sendError(reply, 403, 'forbidden', ADMIN_ONLY);
      const target = await stores.people.get(request.params.id);
      if (target === undefined || target.space_id !== me.space_id) {
        return sendError(reply, 404, 'not_found', 'No such person.');
      }
      const outcome = await options.remover.remove(target.id, {
        purge: request.query.purge === '1',
        log: request.log,
      });
      if (outcome === 'not_found') return sendError(reply, 404, 'not_found', 'No such person.');
      if (outcome === 'last_admin') {
        return sendError(
          reply,
          409,
          'last_admin',
          "A server needs at least one admin, so this person can't be removed.",
        );
      }
      if (outcome === 'unavailable') {
        return sendError(
          reply,
          503,
          'service_unavailable',
          "Couldn't delete their data. Try again.",
        );
      }
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string; deviceId: string } }>(
    '/v1/people/:id/devices/:deviceId',
    async (request, reply) => {
      const me = await actor(request);
      if (me?.role !== 'admin') return sendError(reply, 403, 'forbidden', ADMIN_ONLY);
      const target = await stores.people.get(request.params.id);
      const device = await stores.devices.get(request.params.deviceId);
      if (
        target === undefined ||
        target.space_id !== me.space_id ||
        device?.person_id !== target.id ||
        !(await stores.devices.remove(device.id))
      ) {
        return sendError(reply, 404, 'not_found', 'No such phone.');
      }
      request.log.info({ event: 'phone_removed', by: 'admin' }, 'phone removed');
      return reply.code(204).send();
    },
  );

  /** A one-time ticket for this phone only, to register its push tokens with the relay. */
  app.post('/v1/me/paired-devices/current/ticket', async (request, reply) => {
    const device = await currentDevice(request);
    if (device === undefined) return sendError(reply, 404, 'not_found', 'No such phone.');
    if (!relayLimiter.tryAcquire(`ticket:${device.id}`)) {
      return sendError(reply, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    }
    return { ticket: await mintDeviceTicket(identity, device.id), relay_url: options.relayUrl };
  });

  /** The handle the relay gave this phone; rings for it go there from now on. */
  app.put('/v1/me/paired-devices/current/relay', { bodyLimit: 1024 }, async (request, reply) => {
    const device = await currentDevice(request);
    if (device === undefined) return sendError(reply, 404, 'not_found', 'No such phone.');
    if (!relayLimiter.tryAcquire(`handle:${device.id}`)) {
      return sendError(reply, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    }
    const parsed = relayHandleRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'This phone could not be set up for rings.');
    }
    const outcome = await stores.devices.setRelayHandle(device.id, parsed.data.handle);
    if (outcome === 'not_found') return sendError(reply, 404, 'not_found', 'No such phone.');
    if (outcome === 'taken') {
      return sendError(
        reply,
        409,
        'relay_handle_taken',
        'This phone could not be set up for rings.',
      );
    }
    request.log.info(
      { event: 'phone_ring_ready', platform: device.platform },
      'phone set up for rings',
    );
    return reply.code(204).send();
  });

  /** The phone turned rings off: forget its handle (the relay is told) so nothing is pushed to it. */
  app.delete('/v1/me/paired-devices/current/relay', async (request, reply) => {
    const device = await currentDevice(request);
    if (device === undefined) return sendError(reply, 404, 'not_found', 'No such phone.');
    if (!relayLimiter.tryAcquire(`handle:${device.id}`)) {
      return sendError(reply, 429, 'rate_limited', 'Too many tries. Wait a minute and try again.');
    }
    if (!(await stores.devices.dropRelayHandle(device.id))) {
      return sendError(reply, 404, 'not_found', 'No such phone.');
    }
    request.log.info({ event: 'phone_rings_off', platform: device.platform }, 'phone rings off');
    return reply.code(204).send();
  });

  /** Leave this server: a person removes one of their own phones (an admin may remove any). */
  app.delete<{ Params: { id: string } }>('/v1/me/paired-devices/:id', async (request, reply) => {
    const me = await actor(request);
    const device = await stores.devices.get(request.params.id);
    const owner = device && (await stores.people.get(device.person_id));
    const allowed =
      me !== undefined &&
      owner !== undefined &&
      (owner.id === me.id || (me.role === 'admin' && owner.space_id === me.space_id));
    if (!allowed || device === undefined || !(await stores.devices.remove(device.id))) {
      return sendError(reply, 404, 'not_found', 'No such phone.');
    }
    request.log.info({ event: 'phone_removed', by: 'self' }, 'phone removed');
    return reply.code(204).send();
  });
}
