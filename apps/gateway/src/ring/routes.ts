import {
  answeredTurnText,
  connectorEndpointUrl,
  connectorMessageRequestSchema,
  connectorWordsRequestSchema,
  declineRequestSchema,
  deviceIdSchema,
  deviceRegistrationSchema,
  fileUploadQuerySchema,
  fileUploadResponseSchema,
  MAX_AGENT_KEYTERMS,
  MAX_FILE_BYTES,
  inviteIdSchema,
  localAgentIdSchema,
  sessionScopeSchema,
  RING_MAX_WAIT_S,
  ringRequestSchema,
  ringSettingsSchema,
  sessionRefSchema,
  stripHangupMarkers,
  type CreateCallResponse,
  type ConnectorMessageResponse,
  type ConnectorWordsResponse,
  type ErrorCode,
  type ErrorResponse,
  type Invite,
  type InviteListResponse,
  type RingResponse,
  type RingSettings,
  type RingStatusResponse,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { devUserResolver, type UserResolver } from '../auth';
import type { CallStarter } from '../calls/routes';
import { hashConnectorToken } from '../connectors/pairing';
import type { ConnectorRecord } from '../connectors/store';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import { sniffFile } from '../files/sniff';
import type { FileService } from '../files/service';
import { FileStoreError } from '../threads/store';
import type { Stores } from '../store/repositories';
import { addAgentWords } from '../agents/words';
import type { SharedAgents } from '../agents/shared';

import type { RingRefusal, RingService } from './service';
import type { InviteRecord, RingStores } from './store';
import type { ThreadService } from '../threads/service';

export interface RingRoutesOptions {
  /** Undefined when saved agents are not configured (development without a key): 503. */
  stores: Stores | undefined;
  /** Self-hosted only: results and files from someone's own session on a shared agent. */
  sharedAgents?: SharedAgents;
  ringStores: RingStores;
  service: RingService;
  /** `PUT/DELETE /v1/me/devices/:deviceId` (default on); off on a self-hosted server. */
  pushRegistration?: boolean;
  threads?: ThreadService;
  files?: FileService;
  /** Starts the answered call with every `POST /v1/calls` rule. Undefined: calling is off (503). */
  startCall: CallStarter | undefined;
  userFor?: UserResolver;
  /** Connector-token requests per IP per minute (bounds token guessing). */
  connectorRatePerMinute: number;
  /** Phone writes (devices, settings, decline) per client per minute. */
  writeRatePerMinute: number;
  /** Phone and long-poll reads per client per minute. Unlimited when unset. */
  readRatePerMinute?: number;
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

/** What the connector prints for each refusal. */
const REFUSALS: Record<RingRefusal, [number, string]> = {
  agent_not_saved: [
    404,
    "This agent isn't saved in your Twring app yet. In the app choose Add agent, then On my computer, and pick it.",
  ],
  owner_unavailable: [409, "Do Not Disturb or quiet hours is on, so your phone won't ring."],
  owner_busy: [409, "You're on another call right now, so your phone won't ring."],
  no_ring_phone: [409, "Your phone can't ring yet: open Twring on your phone and sign in."],
  ring_pending: [409, 'Your phone is already ringing for another call.'],
  ring_rate_limited: [409, 'This agent has rung 6 times in the last hour. Try again later.'],
};

const INVITE_NOT_FOUND = 'No such call invite.';
const INVITE_EXPIRED = 'This call already stopped ringing.';
const INVITE_HANDLED = 'This call was already answered or declined.';

const COMPUTER_OFFLINE_NOTE = "Couldn't connect: computer offline";
const REFUSED_NOTES: Partial<Record<ErrorCode, string>> = {
  agent_offline: COMPUTER_OFFLINE_NOTE,
  agent_not_on_computer: COMPUTER_OFFLINE_NOTE,
  daily_limit_reached: "Couldn't connect: daily calling used",
  service_busy: "Couldn't connect: Twring busy today",
  capacity_exceeded: "Couldn't connect: all lines busy",
  call_in_progress: "Couldn't connect: already on a call",
};

/** What the agent hears when its owner answered but the call could not start. */
export function refusedNote(code: ErrorCode): string {
  return REFUSED_NOTES[code] ?? "Couldn't connect the call";
}

/** A connector token: `cct_` + 43 base64url characters (same as the relay socket). */
const CONNECTOR_BEARER = /^Bearer +(cct_[A-Za-z0-9_-]{43})$/i;

/**
 * Rings (ADR-024). The connector side authenticates with the connector token and can only reach
 * its own user's agents and invites; the phone side is signed in and owner-scoped, so another
 * user's invite is the same 404 as an unknown one.
 */
export function registerRingRoutes(app: FastifyInstance, options: RingRoutesOptions): void {
  const { stores, ringStores, service } = options;
  const userFor = options.userFor ?? devUserResolver;
  const now = options.now ?? (() => new Date());
  const connectorLimiter = new FixedWindowLimiter(options.connectorRatePerMinute, 60_000);
  const writeLimiter = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const readLimiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);
  const tooMany = (reply: FastifyReply) =>
    sendError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
  const unavailable = (reply: FastifyReply) =>
    sendError(reply, 503, 'service_unavailable', 'Saved agents are not configured on this server.');

  /**
   * The connector a request's token belongs to, or undefined once a 401/429/503 was sent. A sent
   * reply is never returned from this async helper: FastifyReply is a thenable, so awaiting it
   * resolves to undefined and the caller would throw after the response went out.
   */
  const connectorFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<ConnectorRecord | undefined> => {
    if (stores === undefined) {
      unavailable(reply);
      return undefined;
    }
    if (!connectorLimiter.tryAcquire(request.ip)) {
      tooMany(reply);
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
        : await stores.connectors.findByTokenHash(hashConnectorToken(token));
    if (record === undefined) {
      void reply.header('www-authenticate', 'Bearer');
      sendError(
        reply,
        401,
        'connector_invalid',
        'This computer is not paired any more. Pair it again from the Twring app.',
      );
      return undefined;
    }
    return record;
  };

  const statusOf = (invite: InviteRecord): RingStatusResponse => ({
    status: invite.status,
    ...(invite.note !== undefined && { note: invite.note }),
  });

  // Phone: devices

  if (options.pushRegistration !== false) {
    app.put<{ Params: { deviceId: string } }>(
      '/v1/me/devices/:deviceId',
      async (request, reply): Promise<FastifyReply> => {
        if (!writeLimiter.tryAcquire(rateKey(request, userFor))) return tooMany(reply);
        const deviceId = deviceIdSchema.safeParse(request.params.deviceId);
        const body = deviceRegistrationSchema.safeParse(request.body);
        if (!deviceId.success || !body.success) {
          return sendError(reply, 400, 'bad_request', 'The device details are not valid.');
        }
        await ringStores.devices.upsert({
          ...body.data,
          user_id: userFor(request),
          device_id: deviceId.data,
          updated_at: now().toISOString(),
        });
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { deviceId: string } }>(
      '/v1/me/devices/:deviceId',
      async (request, reply): Promise<FastifyReply> => {
        if (!writeLimiter.tryAcquire(rateKey(request, userFor))) return tooMany(reply);
        if (!deviceIdSchema.safeParse(request.params.deviceId).success) {
          return sendError(reply, 404, 'not_found', 'No such device.');
        }
        const deleted = await ringStores.devices.delete(userFor(request), request.params.deviceId);
        return deleted
          ? reply.code(204).send()
          : sendError(reply, 404, 'not_found', 'No such device.');
      },
    );
  }

  // Phone: ring settings

  app.get('/v1/me/ring-settings', async (request, reply): Promise<RingSettings | FastifyReply> => {
    if (readLimiter !== undefined && !readLimiter.tryAcquire(rateKey(request, userFor)))
      return tooMany(reply);
    return ringStores.settings.get(userFor(request));
  });

  app.put('/v1/me/ring-settings', async (request, reply): Promise<RingSettings | FastifyReply> => {
    if (!writeLimiter.tryAcquire(rateKey(request, userFor))) return tooMany(reply);
    const parsed = ringSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'bad_request', 'The ring settings are not valid.');
    }
    return ringStores.settings.put(userFor(request), parsed.data);
  });

  // Connector: ring, wait, cancel

  const messageLimiter = new FixedWindowLimiter(30, 60_000);
  /**
   * Who a result or file from this computer is for: its owner, or, with a `session_scope` from a
   * shared computer, the person in the owner's space whose session made it. Undefined: refuse (a
   * scope that matches nobody, any scope on a computer that is not shared, or hosted Twring).
   */
  const recipientFor = async (
    connector: ConnectorRecord,
    scope: unknown,
  ): Promise<string | undefined> => {
    if (scope === undefined) return connector.user_id;
    const parsed = sessionScopeSchema.safeParse(scope);
    if (!parsed.success || connector.shared !== true || options.sharedAgents === undefined)
      return undefined;
    return options.sharedAgents.personForScope(connector.user_id, parsed.data);
  };
  const SCOPE_REFUSED = 'That session is not known here.';
  /**
   * True when an unscoped ring or result names a session known to be a team member's: it would
   * reach (and let the owner resume) someone else's conversation.
   */
  const memberSessionUnscoped = (
    connector: ConnectorRecord,
    scope: string | undefined,
    sessionRef: string | undefined,
  ): boolean =>
    scope === undefined &&
    sessionRef !== undefined &&
    connector.scoped_refs?.some((s) => s.ref === sessionRef) === true;
  /** True when a scoped ring or result names a session known to be another member's. */
  const otherMemberSession = (
    connector: ConnectorRecord,
    scope: string | undefined,
    sessionRef: string | undefined,
  ): boolean =>
    scope !== undefined &&
    sessionRef !== undefined &&
    connector.scoped_refs?.some((s) => s.ref === sessionRef && s.scope !== scope) === true;
  /** Remembers which member a scoped session belongs to. */
  const noteScoped = async (
    connector: ConnectorRecord,
    scope: string | undefined,
    sessionRef: string | undefined,
  ): Promise<void> => {
    if (scope === undefined || sessionRef === undefined || stores === undefined) return;
    await stores.connectors.noteScopedRef(connector.id, sessionRef, scope);
  };
  const fileLimiter = new FixedWindowLimiter(30, 60_000);
  if (options.files)
    app.register((filesApp, _opts, done) => {
      filesApp.removeAllContentTypeParsers();
      filesApp.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, next) =>
        next(null, body),
      );
      filesApp.addHook('onRequest', (request, _reply, next) => {
        if (request.headers['content-type']?.trim() === '')
          request.headers['content-type'] = 'application/octet-stream';
        next();
      });
      // The token is checked before the body (up to 10 MB) is read, so a stranger cannot make the
      // gateway buffer files.
      const authenticated = new WeakMap<FastifyRequest, ConnectorRecord>();
      filesApp.addHook('onRequest', async (request, reply) => {
        const found = await connectorFor(request, reply);
        if (!found) return reply;
        authenticated.set(request, found);
        return undefined;
      });
      filesApp.post<{ Querystring: Record<string, unknown> }>(
        '/v1/connectors/files',
        { bodyLimit: MAX_FILE_BYTES + 1024 },
        async (request, reply) => {
          const connector = authenticated.get(request);
          if (!connector) return sendError(reply, 401, 'connector_invalid', 'Pair again.');
          const localAgent = request.query.local_agent;
          const query = fileUploadQuerySchema.safeParse({
            client_id: request.query.client_id,
            name: request.query.name,
          });
          if (!query.success || !localAgentIdSchema.safeParse(localAgent).success)
            return sendError(reply, 400, 'bad_request', 'Invalid file request.');
          const url = connectorEndpointUrl(connector.id, localAgent as string);
          const agent = (await stores!.agents.list(connector.user_id)).find(
            (a) => a.protocol === 'cord-connector' && a.endpoint_url === url,
          );
          if (!agent) return sendError(reply, 404, 'not_found', 'No such saved agent.');
          const recipient = await recipientFor(connector, request.query.session_scope);
          if (recipient === undefined) return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
          if (!fileLimiter.tryAcquire(connector.id)) return tooMany(reply);
          if (!Buffer.isBuffer(request.body) || request.body.length === 0)
            return sendError(reply, 400, 'bad_request', 'File is empty.');
          if (request.body.length > MAX_FILE_BYTES)
            return sendError(reply, 413, 'file_too_large', 'The file is too large.');
          const type = sniffFile(request.body, request.headers['content-type'], query.data.name);
          if (!type)
            return sendError(
              reply,
              415,
              'unsupported_file_type',
              'This file type is not supported.',
            );
          try {
            const result = await options.files!.upload({
              userId: recipient,
              agentId: agent.id,
              clientId: query.data.client_id,
              name: query.data.name,
              mimeType: type.mimeType,
              bytes: request.body,
              direction: 'agent',
              ...('width' in type && { width: type.width }),
              ...('height' in type && { height: type.height }),
            });
            return reply.code(result.created ? 201 : 200).send(
              fileUploadResponseSchema.parse({
                file: options.files!.store.attachment(result.file),
              }),
            );
          } catch (cause) {
            if (cause instanceof FileStoreError)
              return cause.code === 'storage_full'
                ? sendError(reply, 507, 'storage_full', 'Storage is full.')
                : cause.code === 'bad_attachment'
                  ? sendError(reply, 400, 'bad_request', 'Invalid file request.')
                  : sendError(reply, 429, 'files_daily_limit', 'Daily file limit reached.');
            throw cause;
          }
        },
      );
      done();
    });
  app.post(
    '/v1/connectors/messages',
    async (request, reply): Promise<ConnectorMessageResponse | FastifyReply> => {
      const connector = await connectorFor(request, reply);
      if (connector === undefined) return reply;
      if (options.threads === undefined)
        return sendError(reply, 404, 'not_found', 'Messages are unavailable.');
      if (!messageLimiter.tryAcquire(connector.id)) return tooMany(reply);
      const parsed = connectorMessageRequestSchema.safeParse(request.body);
      const key = request.headers['idempotency-key'];
      if (!parsed.success || typeof key !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(key))
        return sendError(reply, 400, 'bad_request', 'The message or Idempotency-Key is invalid.');
      const url = connectorEndpointUrl(connector.id, parsed.data.local_agent);
      const agent = (await stores!.agents.list(connector.user_id)).find(
        (a) => a.protocol === 'cord-connector' && a.endpoint_url === url,
      );
      if (agent === undefined) return sendError(reply, 404, 'not_found', 'No such saved agent.');
      const recipient = await recipientFor(connector, parsed.data.session_scope);
      if (recipient === undefined) return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
      if (
        memberSessionUnscoped(connector, parsed.data.session_scope, parsed.data.session_ref) ||
        otherMemberSession(connector, parsed.data.session_scope, parsed.data.session_ref)
      )
        return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
      await noteScoped(connector, parsed.data.session_scope, parsed.data.session_ref);
      // A call reply can end with the agent's hang-up marker; it is never shown.
      const text = stripHangupMarkers(parsed.data.text);
      if (text === '' && !parsed.data.file_ids?.length)
        return sendError(reply, 400, 'bad_request', 'The message is empty.');
      if (parsed.data.file_ids && !options.files)
        return sendError(reply, 400, 'bad_request', 'Files are unavailable.');
      let result;
      try {
        result = await options.threads.deliverResult(recipient, agent.id, {
          text,
          ...(parsed.data.file_ids && { fileIds: parsed.data.file_ids }),
          origin: parsed.data.origin,
          ...(parsed.data.turn_id !== undefined && { turnId: parsed.data.turn_id }),
          ...(parsed.data.session_ref !== undefined && { sessionRef: parsed.data.session_ref }),
          idempotencyKey: key,
          target: {
            connectorId: connector.id,
            localAgent: parsed.data.local_agent,
            agentName: agent.name,
          },
        });
      } catch (cause) {
        if (cause instanceof FileStoreError && cause.code === 'bad_attachment')
          return sendError(reply, 400, 'bad_request', 'Invalid file attachment.');
        throw cause;
      }
      void reply.code(result.created ? 201 : 200);
      return { message_id: result.messageId, delivery: result.delivery };
    },
  );

  app.post('/v1/connectors/ring', async (request, reply): Promise<RingResponse | FastifyReply> => {
    const connector = await connectorFor(request, reply);
    if (connector === undefined) return reply;
    if (stores === undefined) return unavailable(reply);
    const parsed = ringRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'bad_request',
        'The ring is not valid. The reason must be 1 to 140 characters.',
      );
    }
    // A team member's session rings that person, never the owner.
    const recipient = await recipientFor(connector, parsed.data.session_scope);
    if (recipient === undefined) return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
    if (
      memberSessionUnscoped(connector, parsed.data.session_scope, parsed.data.session_ref) ||
      otherMemberSession(connector, parsed.data.session_scope, parsed.data.session_ref)
    )
      return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
    await noteScoped(connector, parsed.data.session_scope, parsed.data.session_ref);
    const url = connectorEndpointUrl(connector.id, parsed.data.local_agent);
    const agent = (await stores.agents.list(connector.user_id)).find(
      (a) => a.protocol === 'cord-connector' && a.endpoint_url === url,
    );
    const result =
      agent === undefined
        ? { refused: 'agent_not_saved' as const }
        : await service.ring({
            userId: recipient,
            connectorId: connector.id,
            localAgent: parsed.data.local_agent,
            agentId: agent.id,
            agentName: agent.name,
            reason: parsed.data.reason,
            ...(parsed.data.session_ref !== undefined && { sessionRef: parsed.data.session_ref }),
          });
    if ('refused' in result) {
      const [status, message] = REFUSALS[result.refused];
      return sendError(reply, status, result.refused, message);
    }
    void reply.code(201);
    return { invite_id: result.invite.id, expires_at: result.invite.expires_at };
  });

  // An agent teaches its calls words to hear right (names, projects, places): added after the
  // owner's own on the Words page, once each, up to the list's limit.
  app.post(
    '/v1/connectors/words',
    async (request, reply): Promise<ConnectorWordsResponse | FastifyReply> => {
      const connector = await connectorFor(request, reply);
      if (connector === undefined) return reply;
      if (stores === undefined) return unavailable(reply);
      const parsed = connectorWordsRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          'bad_request',
          `Send 1 to ${MAX_AGENT_KEYTERMS} words or short phrases, each at most 50 characters.`,
        );
      }
      const recipient = await recipientFor(connector, parsed.data.session_scope);
      if (recipient === undefined) return sendError(reply, 400, 'bad_request', SCOPE_REFUSED);
      const url = connectorEndpointUrl(connector.id, parsed.data.local_agent);
      const added = await addAgentWords(
        stores.agents,
        connector.user_id,
        async () =>
          (await stores.agents.list(connector.user_id)).find(
            (a) => a.protocol === 'cord-connector' && a.endpoint_url === url,
          ),
        parsed.data.words,
        now(),
        // A team member's session teaches that person's own list.
        recipient === connector.user_id ? undefined : recipient,
      );
      if (added.ok) return { words: added.words, not_added: added.notAdded };
      if (added.reason === 'not_found') {
        const [status, message] = REFUSALS.agent_not_saved;
        return sendError(reply, status, 'agent_not_saved', message);
      }
      return sendError(
        reply,
        503,
        'service_unavailable',
        'The word list is changing right now. Try again.',
      );
    },
  );

  app.get<{
    Params: { inviteId: string };
    Querystring: { wait?: string; session_scope?: string };
  }>(
    '/v1/connectors/ring/:inviteId',
    async (request, reply): Promise<RingStatusResponse | FastifyReply> => {
      // Listen before any await: a client that leaves during auth must not hold a waiter.
      const gone = new AbortController();
      const onClose = () => gone.abort();
      reply.raw.once('close', onClose);
      try {
        const connector = await connectorFor(request, reply);
        if (connector === undefined) return reply;
        if (!inviteIdSchema.safeParse(request.params.inviteId).success) {
          return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
        }
        const requested = Number.parseInt(request.query.wait ?? '0', 10);
        const waitS = Number.isFinite(requested)
          ? Math.min(Math.max(requested, 0), RING_MAX_WAIT_S)
          : 0;
        // A team member's ring is theirs: looked up under them.
        const recipient = await recipientFor(connector, request.query.session_scope);
        if (recipient === undefined) return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
        const invite = await service.waitForOutcome(
          recipient,
          request.params.inviteId,
          waitS * 1000,
          gone.signal,
        );
        return invite === undefined
          ? sendError(reply, 404, 'not_found', INVITE_NOT_FOUND)
          : statusOf(invite);
      } finally {
        reply.raw.off('close', onClose);
      }
    },
  );

  app.delete<{ Params: { inviteId: string }; Querystring: { session_scope?: string } }>(
    '/v1/connectors/ring/:inviteId',
    async (request, reply): Promise<RingStatusResponse | FastifyReply> => {
      const connector = await connectorFor(request, reply);
      if (connector === undefined) return reply;
      const recipient = await recipientFor(connector, request.query.session_scope);
      const invite =
        recipient !== undefined && inviteIdSchema.safeParse(request.params.inviteId).success
          ? await service.cancel(recipient, request.params.inviteId)
          : undefined;
      return invite === undefined
        ? sendError(reply, 404, 'not_found', INVITE_NOT_FOUND)
        : statusOf(invite);
    },
  );

  // Phone: invites

  app.get<{ Querystring: { status?: string } }>(
    '/v1/invites',
    async (request, reply): Promise<InviteListResponse | FastifyReply> => {
      if (readLimiter !== undefined && !readLimiter.tryAcquire(rateKey(request, userFor)))
        return tooMany(reply);
      if (request.query.status !== undefined && request.query.status !== 'pending') {
        return sendError(reply, 400, 'bad_request', 'Only status=pending is supported.');
      }
      const invites = await service.listPending(userFor(request));
      return { invites: invites.map((invite) => service.toInvite(invite)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/invites/:id',
    async (request, reply): Promise<Invite | FastifyReply> => {
      if (readLimiter !== undefined && !readLimiter.tryAcquire(rateKey(request, userFor)))
        return tooMany(reply);
      const invite = inviteIdSchema.safeParse(request.params.id).success
        ? await service.get(userFor(request), request.params.id)
        : undefined;
      return invite === undefined
        ? sendError(reply, 404, 'not_found', INVITE_NOT_FOUND)
        : service.toInvite(invite);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/invites/:id/answer',
    async (
      request,
      reply,
    ): Promise<
      (CreateCallResponse & { mode: 'call' }) | { mode: 'chat'; agent_id: string } | FastifyReply
    > => {
      if (options.startCall === undefined) {
        const invite = await service.get(userFor(request), request.params.id);
        if (invite?.connector_id !== undefined) {
          return sendError(
            reply,
            503,
            'service_unavailable',
            'Calling is not configured on this server.',
          );
        }
      }
      if (!inviteIdSchema.safeParse(request.params.id).success) {
        return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
      }
      const claim = await service.claimAnswer(userFor(request), request.params.id);
      switch (claim.kind) {
        case 'not_found':
          return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
        case 'expired':
          return sendError(reply, 410, 'invite_expired', INVITE_EXPIRED);
        case 'handled':
          return sendError(reply, 409, 'invite_already_handled', INVITE_HANDLED);
        case 'claimed':
          break;
      }
      const { invite } = claim;
      if (invite.connector_id === undefined) {
        let answered = false;
        try {
          if (options.threads === undefined)
            return sendError(reply, 503, 'service_unavailable', 'Chat is unavailable.');
          if (invite.message_id === undefined) {
            await options.threads.deliverResult(invite.user_id, invite.agent_id, {
              text: invite.reason,
              origin: 'agent',
              idempotencyKey: `ring:${invite.id}`,
              target: { agentName: invite.agent_name },
            });
          }
          answered = true;
          return { mode: 'chat', agent_id: invite.agent_id };
        } finally {
          await claim.release(answered);
        }
      }
      if (options.startCall === undefined)
        return sendError(
          reply,
          503,
          'service_unavailable',
          'Calling is not configured on this server.',
        );
      const openingLine = invite.reason.trim();
      let answered = false;
      let refused: string | undefined;
      try {
        const result = await options.startCall(
          request,
          reply,
          invite.agent_id,
          {
            openingTurn: answeredTurnText(invite.reason, { spoken: openingLine !== '' }),
            ...(openingLine !== '' && { openingLine }),
            ...(invite.session_ref !== undefined &&
              sessionRefSchema.safeParse(invite.session_ref).success && {
                resumeRef: invite.session_ref,
              }),
          },
          (code) => {
            refused = refusedNote(code);
          },
        );
        answered = result !== undefined;
        return result ? { ...result, mode: 'call' } : reply;
      } finally {
        await claim.release(answered, refused);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/invites/:id/decline',
    async (request, reply): Promise<RingStatusResponse | FastifyReply> => {
      if (!writeLimiter.tryAcquire(rateKey(request, userFor))) return tooMany(reply);
      const parsed = declineRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, 'bad_request', 'The note is too long.');
      if (!inviteIdSchema.safeParse(request.params.id).success) {
        return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
      }
      const result = await service.decline(userFor(request), request.params.id, parsed.data.note);
      if ('invite' in result) return statusOf(result.invite);
      switch (result.error) {
        case 'not_found':
          return sendError(reply, 404, 'not_found', INVITE_NOT_FOUND);
        case 'expired':
          return sendError(reply, 410, 'invite_expired', INVITE_EXPIRED);
        case 'handled':
          return sendError(reply, 409, 'invite_already_handled', INVITE_HANDLED);
      }
    },
  );
}
