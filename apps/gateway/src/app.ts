import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

import type { GatewayEnv } from '@twring/config/gateway';
import type {
  ErrorCode,
  ErrorResponse,
  HealthLiveResponse,
  HealthReadyResponse,
  ReadinessCheckStatus,
} from '@twring/contracts';
import { parseConnectorEndpoint } from '@twring/contracts';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { registerAgentRoutes, type AgentRoutesOptions } from './agents/routes';
import { defaultVoiceId } from './agents/voices';
import { visibleAgents, type SharedAgents } from './agents/shared';
import { registerVoiceSampleRoutes, type VoiceSampleRoutesOptions } from './agents/voice-samples';
import type { RequestAuth, UserResolver } from './auth';
import { devUserResolver, PUBLIC_ROUTES } from './auth';
import { createBetaMembers } from './beta/members';
import {
  createInviteService,
  inviteCodeRecordSchema,
  redemptionRecordSchema,
  type InviteService,
} from './beta/invites';
import { registerInviteRoutes } from './beta/routes';
import { registerCallRoutes, type CallRoutesOptions, type CallStarter } from './calls/routes';
import { FeedbackStore, feedbackRecordSchema } from './calls/feedback-store';
import { appNoteSchema, NoteStore } from './me/notes';
import type { ConnectorHub } from './connectors/hub';
import { LinkBook } from './connectors/link-requests';
import type { PairingBook } from './connectors/pairing';
import {
  registerConnectorRoutes,
  registerConnectorSocket,
  rejectUpgrade,
  revokeAllConnectors,
} from './connectors/routes';
import {
  createUserDataDeleter,
  registerMeRoutes,
  type MeRoutesOptions,
  type UserDataDeleter,
} from './me/routes';
import { checkSpeechKey } from './voice/key-check';
import { registerSpeechKeyRoutes } from './me/speech-key-routes';
import { UserDeletions } from './me/user-deletions';
import { registerUsageRoutes, type UsageRoutesOptions } from './me/usage-routes';
import { registerPublicPages, type PublicPagesConfig } from './pages/public-pages';
import { toSafeError } from './redact';
import { registerRingRoutes } from './ring/routes';
import { connectorReplacedNotifier } from './selfhost/connector-replaced';
import { registerSelfhostRoutes, type SelfhostRoutesOptions } from './selfhost/routes';
import { registerThreadRoutes } from './threads/routes';
import { registerFileRoutes, type FileRoutesOptions } from './files/routes';
import type { ThreadRoutesOptions } from './threads/routes';
import { registerMessageSpeechRoute, type MessageSpeechOptions } from './threads/speech';
import type { ThreadService } from './threads/service';
import type { SqliteThreadStore } from './threads/store';
import { PHONE_SOCKET_PATH, PhoneSocketHub } from './threads/socket';
import type { RingService } from './ring/service';
import type { RingStores } from './ring/store';
import type { AgentRecord, Stores } from './store/repositories';
import { captureError } from './sentry';
import { registerWaitlistRoutes, type WaitlistRoutesOptions } from './waitlist/routes';
import { JsonFileCollection, type Collection } from './store/collection';
import { connectedAppBlockSchema, McpContacts } from './mcp/contacts';
import { registerConnectedAppRoutes, registerMcpMetadata, registerMcpRoutes } from './mcp/routes';
import type { McpIdentity } from './auth';
import type { FastifyRequest } from 'fastify';
import type { InviteCodeRecord, RedemptionRecord } from './beta/invites';

/** A dependency probe for /health/ready. Must resolve or reject within `timeoutMs`. */
export interface ReadinessCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface BuildAppOptions {
  env: GatewayEnv;
  logger?: FastifyServerOptions['logger'];
  readinessChecks?: readonly ReadinessCheck[];
  readinessTimeoutMs?: number;
  /** Mounts the /v1/calls API when provided. */
  calls?: CallRoutesOptions;
  /** Mounts /v1/agents, /v1/voices, and /v1/calls/history when provided. */
  agents?: AgentRoutesOptions;
  threads?: {
    service: ThreadService;
    store: SqliteThreadStore;
    writeRatePerMinute: number;
    readRatePerMinute: number;
    messagesPerDay: number;
    transcribeVoiceNote?: ThreadRoutesOptions['transcribeVoiceNote'];
    wordsFor?: ThreadRoutesOptions['wordsFor'];
    socketHub?: PhoneSocketHub;
  };
  files?: FileRoutesOptions;
  messageSpeech?: Pick<
    MessageSpeechOptions,
    'deepgram' | 'cartesia' | 'cartesiaDefaults' | 'speech' | 'fetch'
  >;
  /** Mounts GET /v1/voices/:id/sample when provided (needs the voice provider). */
  voiceSamples?: VoiceSampleRoutesOptions;
  /** Mounts DELETE /v1/me/data when provided (with `agents`, whose stores it clears). */
  me?: {
    deleteRatePerMinute: number;
    appleRevoker?: MeRoutesOptions['appleRevoker'];
  };
  /** Mounts /v1/me/speech-keys when provided (with `agents`, whose stores keep the keys). */
  speechKeys?: { enabled: boolean; writeRatePerMinute: number; check?: typeof checkSpeechKey };
  /** Mounts GET /v1/me/usage when provided. */
  usage?: Omit<UsageRoutesOptions, 'userFor'>;
  /** Mounts the public GET /privacy and GET /account-deletion pages when provided. */
  publicPages?: PublicPagesConfig;
  /** Mounts the public beta waitlist when provided. */
  waitlist?: WaitlistRoutesOptions;
  invites?: {
    codesFile: string;
    autoCodes: Collection<InviteCodeRecord>;
    redemptions: Collection<RedemptionRecord>;
  };
  /**
   * Mounts /v1/connectors and the relay socket when provided (with `agents`, whose store keeps
   * the paired computers). ADR-023.
   */
  connectors?: {
    hub: ConnectorHub;
    pairings: PairingBook;
    writeRatePerMinute: number;
    claimRatePerMinute: number;
    socketRatePerMinute: number;
    /** Computer-first link requests (ADR-025). */
    links?: LinkBook;
    linkCreatePerHour?: number;
    linkGuessesPerHour?: number;
  };
  /** Mounts rings, devices, ring settings, and invites when provided (ADR-024). */
  ring?: {
    stores: RingStores;
    service: RingService;
    connectorRatePerMinute: number;
    writeRatePerMinute: number;
  };
  /**
   * Authenticates every `/v1` route (ADR-021) and supplies the acting user. Main always passes one;
   * tests may leave it out and use `userFor` directly.
   */
  auth?: RequestAuth;
  mcp?: { authenticate(request: FastifyRequest): Promise<McpIdentity> };
  /** Self-hosted only (`TWRING_MODE=selfhost`): server identity, pairing, people and phones. */
  selfhost?: Omit<SelfhostRoutesOptions, 'userFor'>;
  /**
   * Self-hosted only: server agents shared with everyone in the space, each person in their own
   * session. The same instance the call resolver and the chats use.
   */
  sharedAgents?: SharedAgents;
  /** Resolves the acting user when `auth` is absent; defaults to the single development user. */
  userFor?: UserResolver;
  /** Receives an already-sanitized Error (redact.ts), never the raw thrown value. */
  onError?: (error: Error, context: { requestId: string }) => void;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function errorBody(code: ErrorCode, message: string, requestId: string): ErrorResponse {
  return { error: { code, message, request_id: requestId } };
}

async function runCheck(check: ReadinessCheck, timeoutMs: number): Promise<ReadinessCheckStatus> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await Promise.race([
      check.check(signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error(`readiness check timed out after ${timeoutMs}ms`)),
          {
            once: true,
          },
        );
      }),
    ]);
    return 'ok';
  } catch {
    return 'failing';
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const {
    env,
    logger = false,
    readinessChecks = [],
    readinessTimeoutMs = 2000,
    onError = captureError,
    calls,
    agents,
    voiceSamples,
    me,
    speechKeys,
    usage,
    publicPages,
    waitlist,
    invites,
    auth,
    connectors,
    ring,
    threads,
    messageSpeech,
    files,
    selfhost,
  } = options;
  const userFor = auth?.userFor ?? options.userFor;
  const profileFor = auth?.profileFor;
  // One book for the routes and for deleting a user's data.
  const links = connectors === undefined ? undefined : (connectors.links ?? new LinkBook());

  // Set while the agent routes are mounted; a self-hosted person removal reuses them.
  let agentStores: Stores | undefined;
  let purgePerson: UserDataDeleter | undefined;
  const app = Fastify({
    logger,
    requestIdHeader: false,
    // Honour a well-formed upstream correlation ID; otherwise mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
    bodyLimit: 64 * 1024,
    // A deploy must not wait out open long-polls (up to 25 s); their clients poll again.
    forceCloseConnections: true,
    // Only behind a proxy we control; otherwise X-Forwarded-For would let clients dodge rate limits.
    trustProxy: env.TRUST_PROXY,
  });
  type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  const upgrades = new Map<string, UpgradeHandler>();
  const registerUpgrade = (path: string, handler: UpgradeHandler) => upgrades.set(path, handler);
  const onUpgrade: UpgradeHandler = (request, socket, head) => {
    socket.on('error', () => undefined);
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
    } catch {
      path = '';
    }
    const handler = upgrades.get(path);
    if (handler === undefined) rejectUpgrade(socket, 404, 'Not Found');
    else handler(request, socket, head);
  };
  app.server.on('upgrade', onUpgrade);
  app.addHook('onClose', (_instance, done) => {
    app.server.off('upgrade', onUpgrade);
    done();
  });
  const phoneHub =
    threads === undefined
      ? undefined
      : (threads.socketHub ??
        new PhoneSocketHub({
          auth: auth ?? {
            authenticateHeaders: () => Promise.reject(new Error('Authentication unavailable')),
          },
          ratePerMinute: env.PHONE_SOCKET_RATE_PER_MINUTE,
          trustProxy: env.TRUST_PROXY,
          log: app.log,
        }));
  if (phoneHub) {
    registerUpgrade(PHONE_SOCKET_PATH, phoneHub.upgrade);
    app.addHook('onClose', (_instance, done) => {
      phoneHub.closeAll();
      done();
    });
  }
  const betaMembers =
    env.BETA_MEMBERS_FILE === undefined
      ? undefined
      : createBetaMembers(env.BETA_MEMBERS_FILE, {
          onUnavailable: () => app.log.warn({ event: 'beta_members_unavailable' }),
        });
  const inviteStores = invites ?? {
    codesFile: join(env.CORD_DATA_DIR, 'invite-codes.json'),
    autoCodes: new JsonFileCollection(
      join(env.CORD_DATA_DIR, 'invite-auto-codes.json'),
      inviteCodeRecordSchema,
    ),
    redemptions: new JsonFileCollection(
      join(env.CORD_DATA_DIR, 'invite-redemptions.json'),
      redemptionRecordSchema,
    ),
  };
  const inviteService: InviteService | undefined = betaMembers
    ? createInviteService({
        members: betaMembers,
        ...inviteStores,
        autoAdmitPerDay: env.AUTO_ADMIT_PER_DAY,
        onUnavailable: () => app.log.warn({ event: 'invite_codes_unavailable' }),
      })
    : undefined;

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-request-id', request.id);
    done();
  });
  // Before any route is registered, so every /v1 route is covered; runs before the body is read.
  if (auth !== undefined)
    app.addHook('onRequest', async (request, reply) => {
      if (
        request.routeOptions.url !== '/v1/connectors/messages' &&
        request.routeOptions.url !== '/v1/connectors/files' &&
        request.routeOptions.url !== '/v1/files/:fileId'
      )
        await auth.hook(request, reply);
    });
  if (auth !== undefined && inviteService !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      const route = request.routeOptions.url;
      if (
        route === undefined ||
        !route.startsWith('/v1/') ||
        PUBLIC_ROUTES.has(route) ||
        route === '/v1/connectors/messages' ||
        route === '/v1/connectors/files' ||
        route === '/v1/me/access' ||
        route === '/v1/me/invite' ||
        route === '/v1/files/:fileId'
      )
        return;
      if (
        request.method === 'DELETE' &&
        (route === '/v1/me/data' || route === '/v1/me/devices/:deviceId')
      )
        return;
      // Deleting an account is open to everyone signed in, members or not.
      if (request.method === 'POST' && route === '/v1/me/apple-revoke') return;
      if (await inviteService.isMember(auth.profileFor(request).email)) return;
      request.log.info({ event: 'beta_access_denied' }, 'beta access denied');
      return reply
        .code(403)
        .send(
          errorBody('not_invited', "This Google account isn't in the Twring beta yet.", request.id),
        );
    });
  }

  app.get('/health/live', (): HealthLiveResponse => ({ status: 'ok' }));

  app.get('/health/ready', async (_request, reply): Promise<HealthReadyResponse> => {
    const results = await Promise.all(
      readinessChecks.map(
        async (check) => [check.name, await runCheck(check, readinessTimeoutMs)] as const,
      ),
    );
    const checks = Object.fromEntries(results);
    const ready = results.every(([, status]) => status === 'ok');
    void reply.code(ready ? 200 : 503);
    return {
      status: ready ? 'ready' : 'not_ready',
      environment: env.CORD_ENV,
      release: env.CORD_RELEASE,
      checks,
    };
  });

  const liveCalls = calls?.registry;
  const notes = new NoteStore(
    new JsonFileCollection(join(env.CORD_DATA_DIR, 'app-notes.json'), appNoteSchema),
  );
  const feedback = new FeedbackStore(
    new JsonFileCollection(join(env.CORD_DATA_DIR, 'call-feedback.json'), feedbackRecordSchema),
  );
  const mcpContacts =
    agents?.stores === undefined
      ? undefined
      : new McpContacts(
          agents.stores.agents,
          new JsonFileCollection(
            join(env.CORD_DATA_DIR, 'connected-app-blocks.json'),
            connectedAppBlockSchema,
          ),
        );
  if (
    env.CONNECTOR_MCP_ENABLED &&
    options.mcp &&
    mcpContacts &&
    threads &&
    ring &&
    env.SUPABASE_URL
  ) {
    registerMcpRoutes(app, {
      publicUrl: env.CORD_PUBLIC_URL,
      supabaseUrl: env.SUPABASE_URL,
      authenticate: (request) => options.mcp!.authenticate(request),
      contacts: mcpContacts,
      agents: agents!.stores!.agents,
      threads: threads.service,
      threadStore: threads.store,
      ring: ring.service,
      ...(files && env.FILES_ENABLED && { files: files.service }),
      fileFetchEnv: env.CORD_ENV,
    });
  } else if (env.CONNECTOR_MCP_ENABLED && env.SUPABASE_URL) {
    registerMcpMetadata(app, env.CORD_PUBLIC_URL, env.SUPABASE_URL);
  }
  let startCall: CallStarter | undefined;
  const sharedAgents = selfhost === undefined ? undefined : options.sharedAgents;
  if (agents !== undefined) {
    registerAgentRoutes(app, {
      onError,
      ...agents,
      ...(sharedAgents !== undefined && { shared: sharedAgents }),
      ...(liveCalls !== undefined && { liveCalls }),
      ...(userFor !== undefined && { userFor }),
      ...(threads !== undefined && {
        noteNewSession: (userId: string, agentId: string) =>
          threads.service.noteNewSession(userId, agentId),
        onAgentDeleted: (userId: string, agentId: string) =>
          threads.service.deleteAgent(userId, agentId).then(() => undefined),
      }),
      ...(mcpContacts !== undefined && {
        onMcpAppDeleted: (userId: string, clientId: string, name: string) =>
          mcpContacts.block(userId, clientId, () => Promise.resolve(), name),
      }),
    });
    const stores = agents.stores;
    agentStores = stores;
    const deletions = new UserDeletions();
    if (speechKeys !== undefined && stores !== undefined) {
      registerSpeechKeyRoutes(app, {
        vault: stores.speechKeys,
        enabled: speechKeys.enabled,
        writeRatePerMinute: speechKeys.writeRatePerMinute,
        check: speechKeys.check ?? checkSpeechKey,
        deletions,
        ...(userFor !== undefined && { userFor }),
      });
    }
    if (me !== undefined) {
      const meOptions: MeRoutesOptions = {
        stores,
        deletions,
        ...(agents.avatars !== undefined && { avatars: agents.avatars }),
        deleteRatePerMinute: me.deleteRatePerMinute,
        ...(me.appleRevoker !== undefined && { appleRevoker: me.appleRevoker }),
        ...(selfhost !== undefined && {
          selfhost: {
            deletePerson: async (userId: string) => {
              await selfhost.stores.devices.deleteAllFor(userId);
              await selfhost.stores.people.delete(userId);
            },
          },
        }),
        feedback,
        notes,
        ...(profileFor !== undefined && { profileFor }),
        ...(mcpContacts && { connectedApps: mcpContacts }),
        ...(liveCalls !== undefined && { liveCalls }),
        ...(userFor !== undefined && { userFor }),
        ...(threads !== undefined && {
          threads: {
            deleteAllForUser: (userId: string) => threads.service.deleteAllForUser(userId),
            closeUser: (userId: string) => phoneHub?.closeUser(userId),
          },
        }),
        ...(ring !== undefined && {
          ring: {
            deleteAllForUser: async (userId: string) => ({
              ringInvites: await ring.service.deleteAllForUser(userId),
              devices: await ring.stores.devices.deleteAllForUser(userId),
              settings: await ring.stores.settings.deleteAllForUser(userId),
            }),
          },
        }),
        ...(connectors !== undefined &&
          stores !== undefined && {
            connectors: {
              revokeAllForUser: (userId: string) =>
                revokeAllConnectors(stores, connectors.hub, connectors.pairings, userId, links),
            },
          }),
      };
      registerMeRoutes(app, meOptions);
      // A self-hosted admin purging a person runs this same Delete my data sequence.
      if (stores !== undefined) purgePerson = createUserDataDeleter({ ...meOptions, stores });
    }
    if (threads !== undefined && stores !== undefined) {
      if (mcpContacts)
        registerConnectedAppRoutes(app, {
          contacts: mcpContacts,
          userFor: userFor ?? (() => 'dev-user'),
          threads: threads.service,
        });
      registerThreadRoutes(app, {
        onError,
        ...threads,
        filesEnabled: env.FILES_ENABLED,
        agents: visibleAgents(stores.agents, sharedAgents),
        ...(sharedAgents !== undefined && {
          linkOutdated: (userId: string, record: AgentRecord) =>
            sharedAgents.linkOutdated(userId, record),
        }),
        ...(userFor !== undefined && { userFor }),
      });
      if (files !== undefined && env.FILES_ENABLED)
        registerFileRoutes(app, {
          ...files,
          agents: visibleAgents(files.agents, sharedAgents),
          ...(userFor !== undefined && { userFor }),
        });
      if (messageSpeech !== undefined)
        registerMessageSpeechRoute(app, {
          onError,
          store: threads.store,
          agents: visibleAgents(stores.agents, sharedAgents),
          ...messageSpeech,
          ...(userFor !== undefined && { userFor }),
        });
    }
    if (connectors !== undefined) {
      registerConnectorRoutes(app, {
        stores,
        hub: connectors.hub,
        pairings: connectors.pairings,
        writeRatePerMinute: connectors.writeRatePerMinute,
        ...(liveCalls !== undefined && { liveCalls }),
        ...(sharedAgents !== undefined && {
          mayShare: (userId: string) => sharedAgents.isAdmin(userId),
        }),
        defaultVoiceId: defaultVoiceId({
          cartesia: agents?.cartesiaVoices ?? false,
          ...(agents?.serverXaiVoices === true && { xaiServer: true }),
        }),
        claimRatePerMinute: connectors.claimRatePerMinute,
        socketRatePerMinute: connectors.socketRatePerMinute,
        ...(links !== undefined && { links }),
        ...(profileFor !== undefined && { profileFor }),
        ...(connectors.linkCreatePerHour !== undefined && {
          linkCreatePerHour: connectors.linkCreatePerHour,
        }),
        ...(connectors.linkGuessesPerHour !== undefined && {
          linkGuessesPerHour: connectors.linkGuessesPerHour,
        }),
        ...(agents.readRatePerMinute !== undefined && {
          readRatePerMinute: agents.readRatePerMinute,
        }),
        ...(userFor !== undefined && { userFor }),
      });
      registerConnectorSocket(app, {
        registerUpgrade,
        stores,
        hub: connectors.hub,
        socketRatePerMinute: connectors.socketRatePerMinute,
        trustProxy: env.TRUST_PROXY,
      });
    }
  }
  if (calls !== undefined) {
    startCall = registerCallRoutes(app, {
      ...(userFor !== undefined && { userFor }),
      ...calls,
      onError,
      feedback,
      ...(agents?.stores !== undefined && { history: agents.stores.history }),
    });
  }
  if (ring !== undefined) {
    registerRingRoutes(app, {
      stores: agents?.stores,
      ...(sharedAgents !== undefined && { sharedAgents }),
      ringStores: ring.stores,
      service: ring.service,
      // Self-hosted phones register for rings with the relay, never here (404).
      pushRegistration: selfhost === undefined,
      ...(threads && { threads: threads.service }),
      ...(env.FILES_ENABLED && files && { files: files.service }),
      startCall,
      connectorRatePerMinute: ring.connectorRatePerMinute,
      writeRatePerMinute: ring.writeRatePerMinute,
      ...(agents?.readRatePerMinute !== undefined && {
        readRatePerMinute: agents.readRatePerMinute,
      }),
      ...(userFor !== undefined && { userFor }),
    });
  }
  if (voiceSamples !== undefined)
    registerVoiceSampleRoutes(app, {
      onError,
      ...voiceSamples,
      ...(userFor !== undefined && { userFor }),
    });
  if (usage !== undefined) {
    registerUsageRoutes(app, { ...(userFor !== undefined && { userFor }), ...usage });
  }
  if (selfhost !== undefined) {
    // Removing a person shuts their computers, ring phones, calls and phone socket out at once
    // (as Delete my data does).
    const removalStores = agentStores;
    selfhost.remover.attach({
      revokeAccess: async (personId) => {
        if (connectors !== undefined && removalStores !== undefined) {
          await revokeAllConnectors(
            removalStores,
            connectors.hub,
            connectors.pairings,
            personId,
            links,
          );
        }
        await ring?.stores.devices.deleteAllForUser(personId);
        // Like Delete my data: their live calls end and their phone socket closes now.
        await liveCalls?.endCallsForUser(personId);
        phoneHub?.closeUser(personId);
      },
      ...(purgePerson !== undefined && { purge: purgePerson }),
    });
    // A computer link opened from another address: always logged (connector_replaced) in
    // selfhost, and with chats on the owner also hears it in that computer's chat.
    if (connectors !== undefined) {
      const threadService = threads?.service;
      const notifyReplaced =
        threadService !== undefined && removalStores !== undefined
          ? connectorReplacedNotifier({
              deliver: async (userId, connectorId, text) => {
                const agent = (await removalStores.agents.list(userId)).find(
                  (a) => parseConnectorEndpoint(a.endpoint_url)?.connectorId === connectorId,
                );
                if (agent === undefined) return;
                await threadService.deliverResult(userId, agent.id, {
                  text,
                  origin: 'agent',
                  idempotencyKey: `connector-replaced-${connectorId}-${Date.now()}`,
                  target: { connectorId, agentName: agent.name },
                });
              },
            })
          : undefined;
      connectors.hub.setReplacedListener((identity) => void notifyReplaced?.(identity));
    }
    registerSelfhostRoutes(app, { ...selfhost, userFor: userFor ?? devUserResolver });
  }
  if (publicPages !== undefined) registerPublicPages(app, publicPages);
  // The beta waitlist is hosted Twring's; a self-hosted server never mounts it.
  if (waitlist !== undefined && selfhost === undefined) registerWaitlistRoutes(app, waitlist);
  if (auth !== undefined && inviteService !== undefined)
    registerInviteRoutes(app, {
      service: inviteService,
      profileFor: auth.profileFor,
      userFor: auth.userFor,
      ...(waitlist && { waitlist }),
    });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody('not_found', 'No such endpoint.', request.id)),
  );

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number(error.statusCode)
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      if (statusCode === 413 && request.routeOptions.url === '/v1/agents/:agentId/files')
        return reply
          .code(413)
          .send(errorBody('file_too_large', 'The file is too large.', request.id));
      if (statusCode === 413 && request.routeOptions.url === '/v1/agents/:agentId/messages')
        return reply
          .code(400)
          .send(errorBody('bad_request', 'The message is too large.', request.id));
      return reply
        .code(statusCode)
        .send(errorBody('bad_request', 'The request was not valid.', request.id));
    }
    // Sanitize at the boundary so no sink (logger, Sentry, custom onError) sees raw error text.
    const safeError = toSafeError(error);
    request.log.error({ err: safeError }, 'unhandled error');
    onError(safeError, { requestId: request.id });
    return reply
      .code(500)
      .send(errorBody('internal_error', 'Something went wrong on our side.', request.id));
  });

  return app;
}
