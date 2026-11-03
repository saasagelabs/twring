import type { IncomingMessage } from 'node:http';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  SCOPED_SESSIONS_FEATURE,
  claimRequestSchema,
  connectorEndpointUrl,
  connectorIdSchema,
  createLinkRequestSchema,
  linkRequestIdSchema,
  type CreateLinkResponse,
  type LinkApproveResponse,
  type LinkPollResponse,
  type LinkRequestDetails,
  MAX_RELAY_MESSAGE_BYTES,
  normalizePairingCode,
  parseConnectorEndpoint,
  type ClaimResponse,
  type ConnectorEndpoint,
  type Connector,
  type ConnectorListResponse,
  type ErrorCode,
  type ErrorResponse,
  type LocalAgent,
  type PairingResponse,
  type PairingStatusResponse,
  type RelinkResponse,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocketServer } from 'ws';

import { devUserResolver, type ProfileResolver, type UserResolver } from '../auth';
import { relinkConnectorContact, type RelinkDeps } from '../agents/relink';
import { defaultVoiceId } from '../agents/voices';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import { newAgentId } from '../calls/ids';
import type { ConnectorCallStatus } from '../calls/routes';
import type { AgentRecord, Stores } from '../store/repositories';

import type { ConnectorHub } from './hub';
import {
  FailureLimiter,
  ipKey,
  LinkBook,
  ownerDisplayName,
  type LinkRequest,
} from './link-requests';
import { hashConnectorToken, newConnectorId, newConnectorToken, type PairingBook } from './pairing';
import type { ConnectorRecord } from './store';

export const CONNECTOR_SOCKET_PATH = '/v1/connectors/socket';

export interface ConnectorRoutesOptions {
  /** Undefined when saved agents are not configured (development without a key): 503. */
  stores: Stores | undefined;
  hub: ConnectorHub;
  pairings: PairingBook;
  userFor?: UserResolver;
  /** The signed-in user's name and email: a linked computer shows whose account it joined. */
  profileFor?: ProfileResolver;
  /** Pairing creates and revokes per client per minute. */
  writeRatePerMinute: number;
  /** Claims per IP per minute: the brute-force bound on pairing codes. */
  claimRatePerMinute: number;
  /** Relay socket upgrades per IP per minute: the bound on token guessing. */
  socketRatePerMinute: number;
  /** Lists and pairing polls per client per minute. Unlimited if unset. */
  readRatePerMinute?: number;
  /** Honour X-Forwarded-For for the socket rate limit (same meaning as Fastify's trustProxy). */
  trustProxy?: TrustProxy;
  /** Computer-first link requests (ADR-025); a fresh book when unset. */
  links?: LinkBook;
  /** Link requests per IP per hour (unauthenticated). Default 10. */
  linkCreatePerHour?: number;
  /** Wrong link codes per user per hour before the phone must wait. Default 10. */
  linkGuessesPerHour?: number;
  /** Wrong link codes per address per hour, across accounts. Default 30. */
  linkGuessesPerIpPerHour?: number;
  /** Live calls: removing a computer ends the calls to its agents (`buildApp` wires this in). */
  liveCalls?: { endCallsForConnector(userId: string, connectorId: string): Promise<void> };
  /**
   * Self-hosted only: whether a claim for this person may mark the computer shared (an admin).
   * Unset (hosted Twring): `shared` on a claim is ignored.
   */
  mayShare?: (userId: string) => Promise<boolean>;
  /**
   * The voice an agent added by a server-minted code starts with: the same default a new agent
   * from the phone gets. Unset: the standard default.
   */
  defaultVoiceId?: string;
  now?: () => Date;
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

export function toConnector(record: ConnectorRecord, online: boolean): Connector {
  return {
    id: record.id,
    name: record.name,
    agents: record.agents,
    online,
    created_at: record.created_at,
    ...(record.last_seen_at !== undefined && { last_seen_at: record.last_seen_at }),
  };
}

/**
 * Whether a call to `endpoint` can start now (`POST /v1/calls` checks this before counting the
 * call): the computer must still be paired, connected, and offering the agent.
 */
export function connectorCallStatus(
  connectors: Pick<Stores['connectors'], 'get'>,
  hub: ConnectorHub,
): (userId: string, endpoint: ConnectorEndpoint, scoped?: boolean) => Promise<ConnectorCallStatus> {
  return async (userId, endpoint, scoped = false) => {
    if ((await connectors.get(userId, endpoint.connectorId)) === undefined) return 'removed';
    const status = hub.agentStatus(userId, endpoint.connectorId, endpoint.localAgent);
    if (
      status === 'online' &&
      scoped &&
      !hub.supports(endpoint.connectorId, SCOPED_SESSIONS_FEATURE)
    )
      return 'outdated';
    return status;
  };
}

/** Revokes every connector of a user: rows gone, sockets closed, open codes dropped. */
export async function revokeAllConnectors(
  stores: Pick<Stores, 'connectors'>,
  hub: ConnectorHub,
  pairings: PairingBook,
  userId: string,
  links?: Pick<LinkBook, 'forgetUser'>,
): Promise<number> {
  pairings.forgetUser(userId);
  // Approvals a computer has not collected yet would otherwise still hand out a token.
  links?.forgetUser(userId);
  const ids = await stores.connectors.deleteAllForUser(userId);
  for (const id of ids) hub.disconnect(id);
  // A socket that authenticated just before the delete is closed too.
  hub.disconnectUser(userId);
  return ids.length;
}

/** Writes a removed computer's name onto the contacts that pointed at it. */
async function keepComputerName(
  stores: Stores,
  userId: string,
  connectorId: string,
  name: string,
): Promise<void> {
  for (const agent of await stores.agents.list(userId)) {
    if (agent.protocol !== 'cord-connector') continue;
    if (parseConnectorEndpoint(agent.endpoint_url)?.connectorId !== connectorId) continue;
    await stores.agents.update(userId, agent.id, { computer_name: name }, new Date());
  }
}

/**
 * Adds each advertised agent to the person's list exactly as the phone's create would
 * (`cord-connector`, the agent's label, the default voice): an existing contact for it is kept,
 * and one whose computer is gone (same name, removed or offline) moves over. Returns how many new
 * contacts it made.
 */
async function addAdvertisedAgents(
  deps: RelinkDeps & { stores: Stores },
  userId: string,
  connectorId: string,
  agents: readonly LocalAgent[],
  voiceId: string,
): Promise<number> {
  let added = 0;
  for (const agent of agents) {
    const url = connectorEndpointUrl(connectorId, agent.id);
    if ((await relinkConnectorContact(deps, userId, url, undefined)) !== undefined) continue;
    const stamp = deps.now().toISOString();
    const record: AgentRecord = {
      id: newAgentId(),
      user_id: userId,
      name: agent.label,
      protocol: 'cord-connector',
      endpoint_url: url,
      voice_id: voiceId,
      keyterms: [],
      status: 'untested',
      created_at: stamp,
      updated_at: stamp,
      revision: 0,
    };
    await deps.stores.agents.create(record);
    added += 1;
  }
  return added;
}

const NOT_FOUND = 'No such computer.';
const PAIRING_INVALID =
  'That code is wrong, used, or expired. Get a new code in the Twring app and try again.';

/**
 * Pairing and managing the user's computers (ADR-023). The claim is the only unauthenticated
 * route: it is rate limited per IP, and a code works once, for 10 minutes.
 */
export function registerConnectorRoutes(app: FastifyInstance, options: ConnectorRoutesOptions) {
  const { stores, hub, pairings } = options;
  const userFor = options.userFor ?? devUserResolver;
  const now = options.now ?? (() => new Date());
  const voiceId = options.defaultVoiceId ?? defaultVoiceId();
  const writeLimiter = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const claimLimiter = new FixedWindowLimiter(options.claimRatePerMinute, 60_000);
  const readLimiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);

  const unavailable = (reply: FastifyReply) =>
    sendError(reply, 503, 'service_unavailable', 'Saved agents are not configured on this server.');
  const limited = (limiter: FixedWindowLimiter | undefined, request: FastifyRequest) =>
    limiter !== undefined && !limiter.tryAcquire(rateKey(request, userFor));
  const tooMany = (reply: FastifyReply) =>
    sendError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');

  app.post('/v1/connectors/pairings', (request, reply): PairingResponse | FastifyReply => {
    if (stores === undefined) return unavailable(reply);
    if (limited(writeLimiter, request)) return tooMany(reply);
    const pairing = pairings.create(userFor(request));
    void reply.code(201);
    return {
      pairing_id: pairing.pairingId,
      code: pairing.code,
      expires_at: new Date(pairing.expiresAt).toISOString(),
      server_time: now().toISOString(),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/connectors/pairings/:id',
    async (request, reply): Promise<PairingStatusResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (limited(readLimiter, request)) return tooMany(reply);
      const userId = userFor(request);
      const pairing = pairings.get(userId, request.params.id);
      if (pairing === undefined) return sendError(reply, 404, 'not_found', 'No such pairing.');
      const expiresAt = new Date(pairing.expiresAt).toISOString();
      const serverTime = now().toISOString();
      if (pairing.connectorId !== undefined) {
        const record = await stores.connectors.get(userId, pairing.connectorId);
        return record === undefined
          ? { status: 'expired', expires_at: expiresAt, server_time: serverTime }
          : {
              status: 'claimed',
              expires_at: expiresAt,
              server_time: serverTime,
              connector: toConnector(record, hub.isOnline(userId, record.id)),
            };
      }
      return {
        status: pairings.isExpired(pairing) ? 'expired' : 'pending',
        expires_at: expiresAt,
        server_time: serverTime,
      };
    },
  );

  app.post(
    '/v1/connectors/claim',
    async (request, reply): Promise<ClaimResponse | RelinkResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (!claimLimiter.tryAcquire(request.ip)) return tooMany(reply);
      const parsed = claimRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, 'bad_request', 'The pairing details are not valid.');
      }
      const code = normalizePairingCode(parsed.data.code);
      // Re-link (ADR-027): a computer that is already linked joins the pairing with its own token.
      const header = request.headers.authorization;
      if (header !== undefined) {
        const existing =
          typeof header === 'string' && header.length < 256
            ? CONNECTOR_BEARER.exec(header.trim())?.[1]
            : undefined;
        const record =
          existing === undefined
            ? undefined
            : await stores.connectors.findByTokenHash(hashConnectorToken(existing));
        if (record === undefined) {
          return sendError(reply, 401, 'connector_invalid', 'This computer is no longer linked.');
        }
        const open = code === undefined ? undefined : pairings.peek(code);
        if (open === undefined) return sendError(reply, 400, 'pairing_invalid', PAIRING_INVALID);
        // The code stays open: after `uninstall --forget`, the same message works.
        if (open.userId !== record.user_id) {
          return sendError(
            reply,
            403,
            'pairing_other_account',
            'This machine is linked to another Twring account.',
          );
        }
        const pairing = pairings.take(open.code);
        if (pairing === undefined) return sendError(reply, 400, 'pairing_invalid', PAIRING_INVALID);
        const updated = await stores.connectors.touch(
          record.id,
          parsed.data.agents,
          now(),
          parsed.data.name,
        );
        if (updated === undefined) {
          return sendError(reply, 401, 'connector_invalid', 'This computer is no longer linked.');
        }
        pairings.completed(pairing, record.id);
        const added =
          pairing.autoAgents === true
            ? await addAdvertisedAgents(
                { stores, hub, now, log: request.log },
                record.user_id,
                record.id,
                updated.agents,
                voiceId,
              )
            : 0;
        request.log.info(
          {
            event: 'connector_relinked',
            connector_id: record.id,
            agents: updated.agents.length,
            ...(added > 0 && { contacts_added: added }),
          },
          'connector relinked',
        );
        return { connector_id: record.id, reused: true };
      }
      const pairing = code === undefined ? undefined : pairings.take(code);
      if (pairing === undefined) return sendError(reply, 400, 'pairing_invalid', PAIRING_INVALID);
      const token = newConnectorToken();
      const shared =
        parsed.data.shared === true &&
        options.mayShare !== undefined &&
        (await options.mayShare(pairing.userId));
      const record: ConnectorRecord = {
        id: newConnectorId(),
        user_id: pairing.userId,
        name: parsed.data.name,
        token_hash: hashConnectorToken(token),
        agents: parsed.data.agents,
        created_at: now().toISOString(),
        ...(shared && { shared: true as const }),
      };
      await stores.connectors.create(record);
      pairings.completed(pairing, record.id);
      const added =
        pairing.autoAgents === true
          ? await addAdvertisedAgents(
              { stores, hub, now, log: request.log },
              record.user_id,
              record.id,
              record.agents,
              voiceId,
            )
          : 0;
      request.log.info(
        {
          event: 'connector_paired',
          connector_id: record.id,
          agents: record.agents.length,
          ...(added > 0 && { contacts_added: added }),
        },
        'connector paired',
      );
      void reply.code(201);
      return { connector_id: record.id, token };
    },
  );

  // Computer-first linking (ADR-025): the computer asks with its agents, the phone approves.
  const links = options.links ?? new LinkBook(() => now().getTime());
  const linkCreateLimiter = new FixedWindowLimiter(options.linkCreatePerHour ?? 10, 3_600_000);
  const linkGuesses = new FailureLimiter(options.linkGuessesPerHour ?? 10, 3_600_000);
  // Per address too: one person with many accounts must not multiply their guesses.
  const linkGuessesByIp = new FailureLimiter(options.linkGuessesPerIpPerHour ?? 30, 3_600_000);
  const LINK_INVALID =
    'That code is wrong, used, or expired. Get a new code on your computer and try again.';
  const LINK_EXPIRED = 'That code expired. Get a new code on your computer and try again.';

  /** A link request's poll token from the Authorization header, if well formed. */
  const pollTokenOf = (request: FastifyRequest): string | undefined => {
    const header = request.headers.authorization;
    return typeof header === 'string' && header.length < 256
      ? LINK_BEARER.exec(header.trim())?.[1]
      : undefined;
  };

  app.post('/v1/connectors/link-requests', (request, reply): CreateLinkResponse | FastifyReply => {
    if (stores === undefined) return unavailable(reply);
    if (!linkCreateLimiter.tryAcquire(ipKey(request.ip))) {
      return sendError(reply, 429, 'rate_limited', 'Too many link requests. Try again later.');
    }
    const parsed = createLinkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'The computer details are not valid.');
    }
    const created = links.create(ipKey(request.ip), parsed.data.computer_name, parsed.data.agents);
    if (!created.ok) {
      return sendError(reply, 503, 'capacity_exceeded', 'Twring is busy. Try again in a minute.');
    }
    void reply.code(201);
    return {
      request_id: created.request.id,
      code: created.request.code,
      poll_token: created.pollToken,
      expires_at: new Date(created.request.expiresAt).toISOString(),
      server_time: now().toISOString(),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
    '/v1/connectors/link-requests/:id',
    async (request, reply): Promise<LinkPollResponse | FastifyReply> => {
      // Listen before any await: a computer that leaves must not hold a waiter.
      const gone = new AbortController();
      const onClose = () => gone.abort();
      reply.raw.once('close', onClose);
      try {
        if (limited(readLimiter, request)) return tooMany(reply);
        const token = pollTokenOf(request);
        if (token === undefined) {
          return sendError(reply, 401, 'auth_required', 'The link request needs its poll token.');
        }
        if (!linkRequestIdSchema.safeParse(request.params.id).success) {
          return sendError(reply, 404, 'not_found', 'No such link request.');
        }
        const requested = Number.parseInt(request.query.wait ?? '0', 10);
        const waitS = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 25) : 0;
        const answer = await links.wait(request.params.id, token, waitS * 1000, gone.signal);
        return answer ?? sendError(reply, 404, 'not_found', 'No such link request.');
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  // The computer withdraws its request (Ctrl+C): the phone then hears "expired".
  app.delete<{ Params: { id: string } }>(
    '/v1/connectors/link-requests/:id',
    (request, reply): FastifyReply => {
      if (limited(readLimiter, request)) return tooMany(reply);
      const token = pollTokenOf(request);
      if (token === undefined) {
        return sendError(reply, 401, 'auth_required', 'The link request needs its poll token.');
      }
      if (
        !linkRequestIdSchema.safeParse(request.params.id).success ||
        !links.cancel(request.params.id, token)
      ) {
        return sendError(reply, 404, 'not_found', 'No such link request.');
      }
      return reply.code(204).send();
    },
  );

  /**
   * The pending request for a code the phone entered, counting wrong guesses per user and address.
   * An expired or cancelled code is not a wrong guess: it answers 410 and counts nothing.
   */
  const linkFor = (
    request: FastifyRequest<{ Params: { code: string } }>,
    reply: FastifyReply,
    find: (code: string, userId: string) => LinkRequest | undefined,
  ): LinkRequest | FastifyReply => {
    const userId = userFor(request);
    const address = ipKey(request.ip);
    if (linkGuesses.blocked(userId) || linkGuessesByIp.blocked(address)) {
      return sendError(reply, 429, 'rate_limited', 'Too many wrong codes. Try again in an hour.');
    }
    const code = normalizePairingCode(request.params.code);
    const found = code === undefined ? undefined : find(code, userId);
    if (found === undefined && code !== undefined && links.isExpiredCode(code)) {
      return sendError(reply, 410, 'pairing_invalid', LINK_EXPIRED);
    }
    if (found === undefined) {
      linkGuesses.fail(userId);
      linkGuessesByIp.fail(address);
      return sendError(reply, 400, 'pairing_invalid', LINK_INVALID);
    }
    return found;
  };
  const isLink = (value: LinkRequest | FastifyReply): value is LinkRequest => 'code' in value;

  app.get<{ Params: { code: string } }>(
    '/v1/link-requests/:code',
    (request, reply): LinkRequestDetails | FastifyReply => {
      if (stores === undefined) return unavailable(reply);
      const link = linkFor(request, reply, (code) => links.pendingByCode(code));
      if (!isLink(link)) return link;
      return {
        computer_name: link.computerName,
        agents: link.agents,
        expires_at: new Date(link.expiresAt).toISOString(),
        server_time: now().toISOString(),
      };
    },
  );

  app.post<{ Params: { code: string } }>(
    '/v1/link-requests/:code/approve',
    async (request, reply): Promise<LinkApproveResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (limited(writeLimiter, request)) return tooMany(reply);
      // The same phone asking again (its first answer was lost) gets the same computer.
      const code = normalizePairingCode(request.params.code);
      const earlier = code === undefined ? undefined : links.approvalFor(code, userFor(request));
      if (earlier !== undefined) return earlier;
      const link = linkFor(request, reply, (code, userId) => links.beginApprove(code, userId));
      if (!isLink(link)) return link;
      const userId = userFor(request);
      const token = newConnectorToken();
      const record: ConnectorRecord = {
        id: newConnectorId(),
        user_id: userId,
        name: link.computerName,
        token_hash: hashConnectorToken(token),
        agents: link.agents.map((a) => ({ id: a.local_agent, label: a.label, kind: a.kind })),
        created_at: now().toISOString(),
      };
      try {
        await stores.connectors.create(record);
      } catch (error) {
        links.abortApprove(link);
        throw error;
      }
      const ownerName = ownerDisplayName(options.profileFor?.(request) ?? {});
      links.approved(link, record.id, token, ownerName);
      request.log.info(
        { event: 'connector_linked', connector_id: record.id, agents: record.agents.length },
        'connector linked',
      );
      return { connector_id: record.id, computer_name: link.computerName, agents: link.agents };
    },
  );

  app.post<{ Params: { code: string } }>(
    '/v1/link-requests/:code/reject',
    (request, reply): FastifyReply => {
      if (stores === undefined) return unavailable(reply);
      if (limited(writeLimiter, request)) return tooMany(reply);
      const link = linkFor(request, reply, (code) => links.pendingByCode(code));
      if (!isLink(link)) return link;
      links.reject(link.code);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/connectors',
    async (request, reply): Promise<ConnectorListResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (limited(readLimiter, request)) return tooMany(reply);
      const userId = userFor(request);
      const records = await stores.connectors.list(userId);
      return { connectors: records.map((r) => toConnector(r, hub.isOnline(userId, r.id))) };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/connectors/:id',
    async (request, reply): Promise<FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (!connectorIdSchema.safeParse(request.params.id).success) {
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      if (limited(writeLimiter, request)) return tooMany(reply);
      const userId = userFor(request);
      const computer = await stores.connectors.get(userId, request.params.id);
      // Its contacts keep the computer's name before it goes, so the same computer linked again
      // finds them (wave 1, track 2.3). Best effort: removing the computer must not fail on it.
      if (computer !== undefined) {
        await keepComputerName(stores, userId, request.params.id, computer.name).catch(() =>
          request.log.warn({ event: 'computer_name_keep_failed' }, 'contacts kept no name'),
        );
      }
      const deleted = await stores.connectors.delete(userId, request.params.id);
      if (!deleted) return sendError(reply, 404, 'not_found', NOT_FOUND);
      // Only after the row is gone: a socket racing in now fails its hello check.
      hub.disconnect(request.params.id);
      // Calls to its agents end now, with the same notice as a computer that went offline.
      await options.liveCalls?.endCallsForConnector(userId, request.params.id);
      request.log.info(
        { event: 'connector_revoked', connector_id: request.params.id },
        'connector revoked',
      );
      return reply.code(204).send();
    },
  );
}

/** A connector token: `cct_` + 43 base64url characters. */
const CONNECTOR_BEARER = /^Bearer +(cct_[A-Za-z0-9_-]{43})$/i;
/** A link request's poll token: `clp_` + 43 base64url characters. */
const LINK_BEARER = /^Bearer +(clp_[A-Za-z0-9_-]{43})$/i;

export function rejectUpgrade(socket: Duplex, status: 401 | 404 | 429 | 503, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** Fastify's trustProxy setting as the gateway configures it: everyone, nobody, or a list. */
export type TrustProxy = boolean | readonly string[];

const proxyLists = new WeakMap<readonly string[], BlockList>();

function listed(proxies: readonly string[], address: string): boolean {
  let list = proxyLists.get(proxies);
  if (list === undefined) {
    list = new BlockList();
    for (const entry of proxies) {
      const [ip = '', prefix] = entry.split('/');
      const type = isIPv6(ip) ? 'ipv6' : 'ipv4';
      if (prefix === undefined) list.addAddress(ip, type);
      else list.addSubnet(ip, Number(prefix), type);
    }
    proxyLists.set(proxies, list);
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const ip = mapped ?? address;
  if (isIPv4(ip)) return list.check(ip, 'ipv4');
  return isIPv6(ip) && list.check(ip, 'ipv6');
}

/**
 * The client address for the socket rate limit. Behind a trusted proxy (loopback, the hosted
 * layout, or an address in the TRUST_PROXY list, such as the self-hosted Caddy container), the
 * last X-Forwarded-For hop is the one that proxy added; earlier hops are client-supplied and
 * ignored. Anyone else's X-Forwarded-For is ignored.
 */
export function clientIp(request: IncomingMessage, trustProxy: TrustProxy): string {
  const remote = request.socket.remoteAddress ?? 'unknown';
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy === false || typeof forwarded !== 'string') return remote;
  const trusted =
    LOOPBACK.test(remote) || (typeof trustProxy !== 'boolean' && listed(trustProxy, remote));
  if (!trusted) return remote;
  const last = forwarded.split(',').at(-1)?.trim();
  return last !== undefined && last !== '' ? last : remote;
}

/**
 * The relay socket (`GET /v1/connectors/socket`, WebSocket). The connector token is checked on
 * the HTTP upgrade itself, so an unauthenticated client never gets a socket, let alone a message.
 */
export function registerConnectorSocket(
  app: FastifyInstance,
  options: Pick<ConnectorRoutesOptions, 'stores' | 'hub' | 'socketRatePerMinute' | 'trustProxy'> & {
    registerUpgrade(
      path: string,
      handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ): void;
  },
): void {
  const { stores, hub } = options;
  const limiter = new FixedWindowLimiter(options.socketRatePerMinute, 60_000);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => undefined);
    if (stores === undefined) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const address = clientIp(request, options.trustProxy ?? false);
    if (!limiter.tryAcquire(address)) {
      rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    const header = request.headers.authorization;
    const token =
      typeof header === 'string' && header.length < 256
        ? CONNECTOR_BEARER.exec(header.trim())?.[1]
        : undefined;
    if (token === undefined) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    stores.connectors.findByTokenHash(hashConnectorToken(token)).then(
      (record) => {
        if (record === undefined) {
          rejectUpgrade(socket, 401, 'Unauthorized');
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          hub.accept(ws, {
            connectorId: record.id,
            userId: record.user_id,
            name: record.name,
            address,
          });
        });
      },
      () => rejectUpgrade(socket, 503, 'Service Unavailable'),
    );
  };

  options.registerUpgrade(CONNECTOR_SOCKET_PATH, onUpgrade);
  app.addHook('onClose', (_instance, done) => {
    hub.closeAll();
    wss.close(() => done());
  });
}
