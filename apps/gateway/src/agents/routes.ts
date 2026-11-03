import {
  agentIdSchema,
  createAgentRequestSchema,
  parseConnectorEndpoint,
  updateAgentRequestSchema,
  type Agent,
  type CreateAgentResponse,
  type AgentListResponse,
  type AgentProtocol,
  type CallHistoryResponse,
  type ConnectionTestResponse,
  type ErrorCode,
  type ErrorResponse,
  type VoiceListResponse,
} from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { DEV_USER_ID, devUserResolver, type UserResolver } from '../auth';
import { newAgentId } from '../calls/ids';
import type { SavedAgentCall, SavedAgentExtras } from '../calls/registry';
import { FixedWindowLimiter, rateKey } from '../rate-limit';
import { toSafeError } from '../redact';
import { revisionOf, type AgentPatch, type AgentRecord, type Stores } from '../store/repositories';

import {
  checkEndpoint,
  DEFAULT_TEST_BUDGET,
  ENDPOINT_REJECTED_MESSAGE,
  ENDPOINT_UNRESOLVABLE_MESSAGE,
  runConnectionTest,
  savedAgentFactory,
  type ConnectionTestBudget,
  type EndpointPolicy,
} from './service';
import { StoreCorruptError } from '../store/collection';
import type { SpeechResolver } from '../voice/speech-resolver';
import { DEEPGRAM_DEFAULT_VOICE_ID, defaultVoiceId, isAllowedVoice, voiceList } from './voices';
import { relinkConnectorContact } from './relink';
import type { AvatarStore } from './avatars';
import type { SharedAgents } from './shared';
import { callWords } from './words';

export { DEV_USER_ID };

export const HISTORY_LIMIT = 50;

/** Connection tests per client per minute when not configured. */
export const DEFAULT_TEST_RATE_PER_MINUTE = 6;

export interface AgentRoutesOptions {
  /** Undefined when saved agents are not configured (development without a key): 503. */
  stores: Stores | undefined;
  avatars?: AvatarStore;
  policy: EndpointPolicy;
  /** Resolves the acting user. Never taken from the request body. */
  userFor?: UserResolver;
  /** Agent creates, edits, and deletes per client per minute. */
  writeRatePerMinute: number;
  /** Connection tests (outbound requests) per client per minute. */
  testRatePerMinute?: number;
  /** Agent list and details, voices, and call history per client per minute. Unlimited if unset. */
  readRatePerMinute?: number;
  /** Kill switch: false answers connection tests with 503 `agent_tests_disabled`. */
  testsEnabled?: boolean;
  testBudget?: ConnectionTestBudget;
  now?: () => Date;
  /**
   * Live calls, so a delete or a connection edit stops the agent's calls from using the old
   * endpoint or credential (SECURITY §20). `buildApp` wires in the call registry.
   */
  liveCalls?: { endCallsForAgent(userId: string, agentId: string): Promise<void> };
  onAgentDeleted?: (userId: string, agentId: string) => Promise<void>;
  onMcpAppDeleted?: (userId: string, clientId: string, name: string) => Promise<void>;
  noteNewSession?: (userId: string, agentId: string) => Promise<void>;
  /** CARTESIA_API_KEY is set: GET /v1/voices lists the Cartesia voices too (ADR-020). */
  cartesiaVoices?: boolean;
  /** Self-hosted on the server's own xAI key (no Deepgram key): Grok voices, Eve by default. */
  serverXaiVoices?: boolean;
  /** A person's own Cartesia key (BYOK) lists the Cartesia voices for them too. */
  speech?: SpeechResolver;
  /** Operator alert for a speech key store that cannot be read. */
  onError?: (error: Error, context: { requestId: string }) => void;
  /** Self-hosted only: server agents shared with the space. Unset in hosted Twring. */
  shared?: SharedAgents;
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

const NOT_FOUND = 'No such agent.';

const BLANK_CREDENTIAL_MESSAGE =
  'The API key is empty. Paste the key again, or remove the saved key instead.';

/**
 * The request body with a string `credential` trimmed of surrounding whitespace (spaces, tabs,
 * newlines, no-break spaces), which pasted keys often carry. `blank` reports a credential that
 * was only whitespace; it is dropped from the body so the caller decides what that means.
 */
function trimCredential(body: unknown): { body: unknown; blank: boolean } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { body, blank: false };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.credential !== 'string') return { body, blank: false };
  const credential = record.credential.trim();
  if (credential !== '') return { body: { ...record, credential }, blank: false };
  const rest = { ...record };
  delete rest.credential;
  return { body: rest, blank: true };
}

/** Runs a cleanup step, ignoring its failure (sync or async). */
async function attempt(step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch {
    // Cleanup is best effort.
  }
}

/** C0/C1 controls and bidi overrides/isolates, which could disguise a name in lists and logs. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_NAME_MESSAGE = 'Agent names can only use ordinary letters, numbers, and symbols.';

/** Where a `cord-connector` agent's computer stands: connected now, and still paired. */
export interface ConnectorState {
  online: boolean;
  removed: boolean;
}

/**
 * The API model: the credential is reported only as present or absent. `connector` is set for
 * `cord-connector` agents: whether the user's computer is connected right now, and whether it
 * was removed from the account (then the agent cannot be called until it is paired again).
 */
export function toAgent(
  record: AgentRecord,
  hasCredential: boolean,
  connector?: ConnectorState,
  shared = false,
  canEdit = true,
): Agent {
  return {
    id: record.id,
    name: record.name,
    protocol: record.protocol,
    ...(record.protocol === 'mcp-app' &&
      record.mcp_client !== undefined && {
        mcp_client: record.mcp_client,
      }),
    endpoint_url: record.endpoint_url,
    ...(record.model !== undefined && { model: record.model }),
    voice_id: record.voice_id,
    keyterms: record.keyterms ?? [],
    has_credential: hasCredential,
    status: record.status,
    ...(record.avatar_version !== undefined && { avatar_version: record.avatar_version }),
    ...(record.protocol === 'cord-connector' && {
      connector_online: connector?.online ?? false,
      ...(connector?.removed === true && { connector_removed: true }),
    }),
    ...(shared && { shared: true }),
    ...(!canEdit && { can_edit: false }),
    ...(record.last_test && {
      last_tested_at: record.last_test.tested_at,
      last_test: record.last_test,
    }),
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function schemeFits(protocol: AgentProtocol, url: string): boolean {
  if (protocol === 'mcp-app') return /^mcp-app:\/\/[A-Za-z0-9._:-]{1,128}$/.test(url);
  const scheme = new URL(url).protocol;
  switch (protocol) {
    case 'cord-native':
      return scheme === 'ws:' || scheme === 'wss:';
    case 'cord-rest':
    case 'openai-chat':
      return scheme === 'http:' || scheme === 'https:';
    case 'cord-connector':
      return parseConnectorEndpoint(url) !== undefined;
  }
}

const CONNECTOR_UNKNOWN_MESSAGE =
  "That computer or agent isn't paired with your account. Pair it again from the app.";
const SHARED_EDIT_MESSAGE = 'Only the person who added this agent can change it.';
const CONNECTOR_CREDENTIAL_MESSAGE =
  "Agents on your computer don't use an API key here. Leave the key empty.";

/**
 * Saved agents, voices, and call history (BACKEND_SPEC §3). Every query is scoped to the acting
 * user; credentials are write-only and never echoed, logged, or returned.
 */
export function registerAgentRoutes(app: FastifyInstance, options: AgentRoutesOptions): void {
  const { stores, policy } = options;
  const userFor = options.userFor ?? devUserResolver;
  const now = options.now ?? (() => new Date());
  const hub = policy.connectors;
  const onlineFor = async (
    userId: string,
    record: AgentRecord,
  ): Promise<ConnectorState | undefined> => {
    const endpoint =
      record.protocol === 'cord-connector'
        ? parseConnectorEndpoint(record.endpoint_url)
        : undefined;
    if (endpoint === undefined || stores === undefined) return undefined;
    const paired = (await stores.connectors.get(userId, endpoint.connectorId)) !== undefined;
    return {
      online: paired && (hub?.isOnline(userId, endpoint.connectorId) ?? false),
      removed: !paired,
    };
  };
  const sharing = options.shared;
  /** The API model of any agent, as `viewer` sees it (a shared agent's computer is its owner's). */
  const present = async (all: Stores, record: AgentRecord, viewerId: string): Promise<Agent> => {
    const isShared = (await sharing?.isShared(record)) ?? false;
    return toAgent(
      record,
      await all.credentials.has(record.user_id, record.id),
      await onlineFor(record.user_id, record),
      isShared,
      // Only a shared agent can be someone else's to look at; its owner alone may change it.
      !isShared || record.user_id === viewerId,
    );
  };
  /**
   * The answer when `userId` has no agent `id` of their own: 403 when it is a shared agent they
   * may only use (only the owner changes it), otherwise 404 exactly as for an unknown agent.
   */
  const notOwn = async (userId: string, id: string, reply: FastifyReply): Promise<void> => {
    // Not returned: a Fastify reply is thenable, so it cannot pass through a resolved promise.
    if ((await sharing?.find(userId, id)) !== undefined) {
      sendError(reply, 403, 'forbidden', SHARED_EDIT_MESSAGE);
    } else sendError(reply, 404, 'not_found', NOT_FOUND);
  };
  const voiceOptions = {
    cartesia: options.cartesiaVoices ?? false,
    ...(options.serverXaiVoices && { xaiServer: true }),
  };
  const budget = options.testBudget ?? DEFAULT_TEST_BUDGET;
  const limiter = new FixedWindowLimiter(options.writeRatePerMinute, 60_000);
  const testLimiter = new FixedWindowLimiter(
    options.testRatePerMinute ?? DEFAULT_TEST_RATE_PER_MINUTE,
    60_000,
  );
  const readLimiter =
    options.readRatePerMinute === undefined
      ? undefined
      : new FixedWindowLimiter(options.readRatePerMinute, 60_000);

  const unavailable = (reply: FastifyReply) =>
    sendError(reply, 503, 'service_unavailable', 'Saved agents are not configured on this server.');
  const limited = (request: FastifyRequest, reply: FastifyReply) =>
    !limiter.tryAcquire(rateKey(request, userFor)) &&
    sendError(reply, 429, 'rate_limited', 'Too many changes. Wait a minute and try again.');
  const testLimited = (request: FastifyRequest, reply: FastifyReply) =>
    !testLimiter.tryAcquire(rateKey(request, userFor)) &&
    sendError(
      reply,
      429,
      'rate_limited',
      'Too many connection tests. Wait a minute and try again.',
    );
  const readLimited = (request: FastifyRequest, reply: FastifyReply) =>
    readLimiter !== undefined &&
    !readLimiter.tryAcquire(rateKey(request, userFor)) &&
    sendError(reply, 429, 'rate_limited', 'Too many requests. Wait a minute and try again.');
  /**
   * True when the endpoint may not be saved (the 400 is already sent). A boolean, not the reply:
   * a Fastify reply is thenable, so it cannot pass through a resolved promise intact.
   */
  const endpointRefused = async (url: string, reply: FastifyReply): Promise<boolean> => {
    const verdict = await checkEndpoint(url, policy);
    switch (verdict) {
      case 'allowed':
        return false;
      case 'unresolvable':
        sendError(reply, 400, 'endpoint_unresolvable', ENDPOINT_UNRESOLVABLE_MESSAGE);
        return true;
      case 'rejected':
        sendError(reply, 400, 'endpoint_rejected', ENDPOINT_REJECTED_MESSAGE);
        return true;
    }
  };
  /**
   * True when a `cord-connector` address does not name one of this user's own paired computers
   * and an agent it offers (the 400 is already sent). This is the relay's ownership check.
   */
  const connectorRefused = async (
    userId: string,
    url: string,
    reply: FastifyReply,
  ): Promise<boolean> => {
    const endpoint = parseConnectorEndpoint(url);
    const record =
      endpoint === undefined || stores === undefined
        ? undefined
        : await stores.connectors.get(userId, endpoint.connectorId);
    if (record?.agents.some((agent) => agent.id === endpoint?.localAgent) === true) return false;
    sendError(reply, 400, 'bad_request', CONNECTOR_UNKNOWN_MESSAGE);
    return true;
  };
  const relinkContact = (userId: string, url: string, voiceId: string | undefined) =>
    stores === undefined
      ? Promise.resolve(undefined)
      : relinkConnectorContact({ stores, hub, now, log: app.log }, userId, url, voiceId);
  const endLiveCalls = async (userId: string, agentId: string) => {
    try {
      await options.liveCalls?.endCallsForAgent(userId, agentId);
    } catch (error) {
      app.log.warn(
        { event: 'agent_calls_end_failed', err: toSafeError(error) },
        'could not end live calls',
      );
    }
  };

  app.get('/v1/voices', async (request, reply): Promise<VoiceListResponse | FastifyReply> => {
    const rateLimited = readLimited(request, reply);
    if (rateLimited) return rateLimited;
    if (options.speech === undefined) return voiceList(voiceOptions);
    try {
      const speech = await options.speech.resolve(userFor(request));
      return voiceList({
        ...voiceOptions,
        cartesia: voiceOptions.cartesia || speech.cartesia !== undefined,
        xai: speech.xai !== undefined,
        deepgram: speech.deepgram !== undefined,
      });
    } catch (error) {
      if (error instanceof StoreCorruptError) {
        // The list still answers; the operator hears about it. No path, no key.
        const safeError = new Error('speech key store unreadable');
        safeError.name = 'SpeechKeysUnavailable';
        request.log.error({ event: 'speech_keys_unavailable' }, 'speech key store unreadable');
        options.onError?.(safeError, { requestId: request.id });
      }
      // An unreadable key only hides the voices it would unlock; the call path reports it.
      return voiceList(voiceOptions);
    }
  });

  app.get('/v1/agents', async (request, reply): Promise<AgentListResponse | FastifyReply> => {
    if (stores === undefined) return unavailable(reply);
    const rateLimited = readLimited(request, reply);
    if (rateLimited) return rateLimited;
    const userId = userFor(request);
    // Their own agents, then the server agents shared with their space (self-hosted only).
    const records = [
      ...(await stores.agents.list(userId)),
      ...((await sharing?.listFor(userId)) ?? []),
    ];
    const agents = await Promise.all(records.map((r) => present(stores, r, userId)));
    return { agents };
  });

  app.post('/v1/agents', async (request, reply): Promise<CreateAgentResponse | FastifyReply> => {
    if (stores === undefined) return unavailable(reply);
    // A whitespace-only key on create means no key at all.
    const parsed = createAgentRequestSchema.safeParse(trimCredential(request.body).body);
    if (!parsed.success)
      return sendError(reply, 400, 'bad_request', 'The agent details are not valid.');
    const body = parsed.data;
    if (UNSAFE_NAME_CHARACTERS.test(body.name)) {
      return sendError(reply, 400, 'bad_request', UNSAFE_NAME_MESSAGE);
    }
    const voiceId = body.voice_id ?? defaultVoiceId(voiceOptions);
    if (!isAllowedVoice(voiceId))
      return sendError(reply, 400, 'bad_request', 'Choose one of the listed voices.');
    if (body.protocol === 'cord-connector' && body.credential !== undefined) {
      return sendError(reply, 400, 'bad_request', CONNECTOR_CREDENTIAL_MESSAGE);
    }
    const rateLimited = limited(request, reply);
    if (rateLimited) return rateLimited;
    const userId = userFor(request);
    if (body.protocol === 'cord-connector') {
      if (await connectorRefused(userId, body.endpoint_url, reply)) return reply;
    } else if (await endpointRefused(body.endpoint_url, reply)) return reply;
    // The same computer linked again: its contact moves over instead of being duplicated.
    if (body.protocol === 'cord-connector') {
      const reused = await relinkContact(userId, body.endpoint_url, body.voice_id);
      if (reused !== undefined) {
        const { contact } = reused;
        return {
          ...(await present(stores, contact, userId)),
          // Only a contact that moved over from a computer that is gone is a reconnection.
          ...(reused.moved && { relinked: true as const }),
        };
      }
    }
    const stamp = now().toISOString();
    const record: AgentRecord = {
      id: newAgentId(),
      user_id: userId,
      name: body.name,
      protocol: body.protocol,
      endpoint_url: body.endpoint_url,
      ...(body.model !== undefined && { model: body.model }),
      voice_id: voiceId,
      keyterms: body.keyterms ?? [],
      status: 'untested',
      created_at: stamp,
      updated_at: stamp,
      revision: 0,
    };
    // The profile exists before its secret, so a secret is never stored without its agent. A
    // failed seal removes the profile again rather than leave an agent missing its credential.
    await stores.agents.create(record);
    if (body.credential !== undefined) {
      try {
        await stores.credentials.put(userId, record.id, body.credential);
      } catch (error) {
        // Best effort, each step on its own: the original failure is what the caller sees.
        await attempt(() => stores.credentials.delete(userId, record.id));
        await attempt(() => stores.agents.delete(userId, record.id));
        throw error;
      }
      if ((await stores.agents.get(userId, record.id)) === undefined) {
        // Deleted while the secret was sealed (DELETE /v1/me/data): never a secret without its
        // agent, exactly as for an edit.
        await stores.credentials.delete(userId, record.id);
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
    }
    void reply.code(201);
    return present(stores, record, userId);
  });

  app.get<{ Params: { id: string } }>(
    '/v1/agents/:id',
    async (request, reply): Promise<Agent | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      const rateLimited = readLimited(request, reply);
      if (rateLimited) return rateLimited;
      const userId = userFor(request);
      const record = agentIdSchema.safeParse(request.params.id).success
        ? ((await stores.agents.get(userId, request.params.id)) ??
          (await sharing?.find(userId, request.params.id)))
        : undefined;
      if (record === undefined) return sendError(reply, 404, 'not_found', NOT_FOUND);
      return present(stores, record, userId);
    },
  );

  app.patch<{ Params: { id: string } }>(
    '/v1/agents/:id',
    async (request, reply): Promise<Agent | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (!agentIdSchema.safeParse(request.params.id).success) {
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      const trimmed = trimCredential(request.body);
      // On an edit a blank key is a mistake, not a removal: removing is an explicit null.
      if (trimmed.blank) return sendError(reply, 400, 'bad_request', BLANK_CREDENTIAL_MESSAGE);
      const parsed = updateAgentRequestSchema.safeParse(trimmed.body);
      if (!parsed.success)
        return sendError(reply, 400, 'bad_request', 'The agent details are not valid.');
      const body = parsed.data;
      if (body.name !== undefined && UNSAFE_NAME_CHARACTERS.test(body.name)) {
        return sendError(reply, 400, 'bad_request', UNSAFE_NAME_MESSAGE);
      }
      if (body.voice_id !== undefined && !isAllowedVoice(body.voice_id)) {
        return sendError(reply, 400, 'bad_request', 'Choose one of the listed voices.');
      }
      const userId = userFor(request);
      const existing = await stores.agents.get(userId, request.params.id);
      if (existing === undefined) {
        await notOwn(userId, request.params.id, reply);
        return reply;
      }
      if (
        existing.protocol === 'mcp-app' &&
        (body.protocol !== undefined ||
          body.endpoint_url !== undefined ||
          body.credential !== undefined)
      ) {
        return sendError(
          reply,
          400,
          'not_supported',
          'AI app connections are managed in Connected AI apps.',
        );
      }
      const protocol = body.protocol ?? existing.protocol;
      const url = body.endpoint_url ?? existing.endpoint_url;
      if (body.model != null && protocol !== 'openai-chat') {
        return sendError(
          reply,
          400,
          'bad_request',
          'Model is only supported for OpenAI-compatible agents.',
        );
      }
      if (!schemeFits(protocol, url)) {
        return sendError(
          reply,
          400,
          'bad_request',
          'The endpoint address does not match the protocol.',
        );
      }
      if (protocol === 'cord-connector' && typeof body.credential === 'string') {
        return sendError(reply, 400, 'bad_request', CONNECTOR_CREDENTIAL_MESSAGE);
      }
      const rateLimited = limited(request, reply);
      if (rateLimited) return rateLimited;
      if (protocol === 'cord-connector') {
        if (
          (body.endpoint_url !== undefined || body.protocol !== undefined) &&
          (await connectorRefused(userId, url, reply))
        ) {
          return reply;
        }
      } else if (body.endpoint_url !== undefined) {
        if (await endpointRefused(url, reply)) return reply;
      }
      const patch: AgentPatch = {
        ...(body.name !== undefined && {
          name: body.name,
          ...(existing.protocol === 'mcp-app' && { name_set_by_owner: true as const }),
        }),
        ...(body.protocol !== undefined && { protocol: body.protocol }),
        ...(body.endpoint_url !== undefined && { endpoint_url: body.endpoint_url }),
        ...(protocol !== 'openai-chat' && existing.model !== undefined
          ? { model: null }
          : body.model !== undefined && { model: body.model }),
        ...(body.voice_id !== undefined && { voice_id: body.voice_id }),
        ...(body.keyterms !== undefined && { keyterms: body.keyterms }),
      };
      const connectionChanged =
        (body.protocol !== undefined && body.protocol !== existing.protocol) ||
        (body.endpoint_url !== undefined && body.endpoint_url !== existing.endpoint_url) ||
        body.credential !== undefined ||
        (body.model !== undefined && body.model !== existing.model);
      if (connectionChanged) patch.status = 'untested';
      // Order matters for calls connecting meanwhile (see savedAgentFactory): the old secret goes
      // first, then the record changes (new revision), then the new secret is stored. No reader
      // can pair the old secret with the new endpoint, or the new secret with the old one.
      if (body.credential !== undefined) await stores.credentials.delete(userId, existing.id);
      const updated = await stores.agents.update(userId, existing.id, patch, now());
      if (updated === undefined) {
        // Deleted while this edit ran: do not leave a credential behind.
        await stores.credentials.delete(userId, existing.id);
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      if (typeof body.credential === 'string') {
        await stores.credentials.put(userId, existing.id, body.credential);
        if ((await stores.agents.get(userId, existing.id)) === undefined) {
          await stores.credentials.delete(userId, existing.id);
          return sendError(reply, 404, 'not_found', NOT_FOUND);
        }
      }
      if (connectionChanged) await endLiveCalls(userId, existing.id);
      return present(stores, updated, userId);
    },
  );

  const avatarPath = '/v1/agents/:id/avatar';
  const avatarAgent = async (userId: string, id: string) =>
    stores && agentIdSchema.safeParse(id).success ? stores.agents.get(userId, id) : undefined;

  app.get<{ Params: { id: string } }>(avatarPath, async (request, reply) => {
    if (stores === undefined || options.avatars === undefined) return unavailable(reply);
    const rateLimited = readLimited(request, reply);
    if (rateLimited) return rateLimited;
    const userId = userFor(request);
    // A shared agent's photo is its owner's, shown to everyone who may call it.
    const record =
      (await avatarAgent(userId, request.params.id)) ??
      (agentIdSchema.safeParse(request.params.id).success
        ? await sharing?.find(userId, request.params.id)
        : undefined);
    if (!record) return sendError(reply, 404, 'not_found', NOT_FOUND);
    if (!record.avatar_version) return sendError(reply, 404, 'not_found', 'No photo saved.');
    const etag = `"${record.avatar_version}"`;
    if (request.headers['if-none-match']?.split(',').some((tag) => tag.trim() === etag)) {
      return reply
        .code(304)
        .header('etag', etag)
        .header('cache-control', 'private, max-age=86400')
        .send();
    }
    const bytes = await options.avatars.get(record.user_id, record.id);
    if (!bytes) return sendError(reply, 404, 'not_found', 'No photo saved.');
    return reply
      .headers({
        'content-type': 'image/jpeg',
        'cache-control': 'private, max-age=86400',
        etag: etag,
        'x-content-type-options': 'nosniff',
      })
      .send(bytes);
  });

  app.delete<{ Params: { id: string } }>(avatarPath, async (request, reply) => {
    if (stores === undefined || options.avatars === undefined) return unavailable(reply);
    const rateLimited = limited(request, reply);
    if (rateLimited) return rateLimited;
    const userId = userFor(request);
    const record = await avatarAgent(userId, request.params.id);
    if (!record) {
      await notOwn(userId, request.params.id, reply);
      return reply;
    }
    await options.avatars.delete(userId, record.id);
    const updated = await stores.agents.update(
      userId,
      record.id,
      {
        avatar_version: null,
        ...(record.avatar_version !== undefined && { avatar_version_last: record.avatar_version }),
      },
      now(),
    );
    if (!updated) return sendError(reply, 404, 'not_found', NOT_FOUND);
    return present(stores, updated, userId);
  });

  app.register((avatarApp, _opts, done) => {
    avatarApp.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (_request, body, next) =>
      next(null, body),
    );
    avatarApp.put<{ Params: { id: string } }>(
      avatarPath,
      { bodyLimit: 300 * 1024 + 1 },
      async (request, reply) => {
        if (stores === undefined || options.avatars === undefined) return unavailable(reply);
        const rateLimited = limited(request, reply);
        if (rateLimited) return rateLimited;
        const userId = userFor(request);
        const record = await avatarAgent(userId, request.params.id);
        if (!record) {
          await notOwn(userId, request.params.id, reply);
          return reply;
        }
        const bytes = request.body;
        if (
          request.headers['content-type'] !== 'image/jpeg' ||
          !Buffer.isBuffer(bytes) ||
          bytes.length < 3 ||
          bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 ||
          bytes[2] !== 0xff
        ) {
          return sendError(reply, 400, 'invalid_request', 'The photo must be a JPEG.');
        }
        if (bytes.length > 300 * 1024)
          return sendError(reply, 413, 'file_too_large', 'The photo is too large.');
        await options.avatars.put(userId, record.id, bytes);
        const updated = await stores.agents.update(
          userId,
          record.id,
          {
            avatar_version: Math.max(
              Date.now(),
              Math.max(record.avatar_version_last ?? 0, record.avatar_version ?? 0) + 1,
            ),
          },
          now(),
        );
        if (!updated) {
          await options.avatars.delete(userId, record.id);
          return sendError(reply, 404, 'not_found', NOT_FOUND);
        }
        return present(stores, updated, userId);
      },
    );
    done();
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/agents/:id',
    async (request, reply): Promise<FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      if (!agentIdSchema.safeParse(request.params.id).success) {
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      const rateLimited = limited(request, reply);
      if (rateLimited) return rateLimited;
      const userId = userFor(request);
      const existing = await stores.agents.get(userId, request.params.id);
      if (existing === undefined) {
        await notOwn(userId, request.params.id, reply);
        return reply;
      }
      // Credential first: a failure after this point never leaves a secret without its agent.
      await stores.credentials.delete(userId, request.params.id);
      const deleted = await stores.agents.delete(userId, request.params.id);
      if (!deleted) return sendError(reply, 404, 'not_found', NOT_FOUND);
      await options.avatars?.delete(userId, request.params.id);
      await endLiveCalls(userId, request.params.id);
      await options.onAgentDeleted?.(userId, request.params.id);
      if (existing?.protocol === 'mcp-app')
        await options.onMcpAppDeleted?.(
          userId,
          existing.endpoint_url.slice('mcp-app://'.length),
          existing.name,
        );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/new-conversation',
    async (request, reply): Promise<{ ok: true } | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      const rateLimited = limited(request, reply);
      if (rateLimited) return rateLimited;
      const userId = userFor(request);
      const existing = agentIdSchema.safeParse(request.params.id).success
        ? await stores.agents.get(userId, request.params.id)
        : undefined;
      if (existing === undefined) {
        // A shared server agent: everyone starts over in their own session only.
        const sharedAgent = agentIdSchema.safeParse(request.params.id).success
          ? await sharing?.find(userId, request.params.id)
          : undefined;
        const caller = sharedAgent && sharing?.callerFor(userId, sharedAgent);
        if (sharedAgent === undefined || caller === undefined) {
          return sendError(reply, 404, 'not_found', NOT_FOUND);
        }
        if (
          !(await stores.agents.requestFreshSession(
            sharedAgent.user_id,
            sharedAgent.id,
            caller.scope,
          ))
        ) {
          return sendError(reply, 404, 'not_found', NOT_FOUND);
        }
        await options.noteNewSession?.(userId, sharedAgent.id);
        return { ok: true };
      }
      if (existing.protocol === 'mcp-app')
        return sendError(
          reply,
          400,
          'not_supported',
          `${existing.name} can't take calls. It reaches you with rings and messages.`,
        );
      if (existing.protocol !== 'cord-connector' && existing.protocol !== 'openai-chat') {
        return sendError(reply, 400, 'not_supported', "This agent can't start a new conversation.");
      }
      const changed =
        existing.protocol === 'openai-chat'
          ? (await stores.agents.ensureSessionKey(userId, existing.id, true)) !== undefined
          : await stores.agents.requestFreshSession(userId, existing.id);
      if (!changed) {
        return sendError(reply, 404, 'not_found', NOT_FOUND);
      }
      await options.noteNewSession?.(userId, existing.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/test',
    async (request, reply): Promise<ConnectionTestResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      const userId = userFor(request);
      const existing = agentIdSchema.safeParse(request.params.id).success
        ? await stores.agents.get(userId, request.params.id)
        : undefined;
      if (existing === undefined) {
        await notOwn(userId, request.params.id, reply);
        return reply;
      }
      if (existing.protocol === 'mcp-app')
        return sendError(
          reply,
          400,
          'not_supported',
          `${existing.name} can't take calls. It reaches you with rings and messages.`,
        );
      if (options.testsEnabled === false) {
        return sendError(
          reply,
          503,
          'agent_tests_disabled',
          'Connection tests are turned off right now. Try again later.',
        );
      }
      const rateLimited = testLimited(request, reply);
      if (rateLimited) return rateLimited;
      const token = await stores.credentials.get(userId, existing.id).catch(() => undefined);
      const hadCredential = await stores.credentials.has(userId, existing.id);
      if (hadCredential && token === undefined) {
        // The stored secret cannot be decrypted (key changed or data damaged): ask for it again.
        return sendError(
          reply,
          409,
          'credential_unreadable',
          'The saved credential can no longer be read. Enter it again.',
        );
      }
      const result = await runConnectionTest(
        {
          protocol: existing.protocol,
          url: existing.endpoint_url,
          userId,
          ...(existing.model !== undefined && { model: existing.model }),
          ...(existing.protocol === 'openai-chat' && {
            sessionKey: await stores.agents.ensureSessionKey(userId, existing.id),
          }),
          ...(token !== undefined && { token }),
        },
        policy,
        budget,
        now,
      );
      const current = await stores.agents.get(userId, existing.id);
      if (current === undefined) return sendError(reply, 404, 'not_found', NOT_FOUND);
      // Store the verdict only if the agent is still the revision that was tested. The check is
      // a compare-and-set under the store's lock, so an edit landing just before it wins.
      const record =
        (await stores.agents.update(
          userId,
          existing.id,
          {
            status: result.ok ? 'ready' : 'failing',
            last_test: result,
            ifRevision: revisionOf(existing),
          },
          now(),
        )) ?? current;
      return {
        agent: await present(stores, record, userId),
        result,
      };
    },
  );

  app.get(
    '/v1/calls/history',
    async (request, reply): Promise<CallHistoryResponse | FastifyReply> => {
      if (stores === undefined) return unavailable(reply);
      const rateLimited = readLimited(request, reply);
      if (rateLimited) return rateLimited;
      return { calls: await stores.history.list(userFor(request), HISTORY_LIMIT) };
    },
  );
}

/**
 * Resolves `POST /v1/calls` `agent_id` to the acting user's saved agent, or (self-hosted) a server
 * agent shared with their space, in its voice.
 */
export function savedAgentResolver(
  stores: Stores,
  policy: EndpointPolicy,
  userFor: UserResolver = devUserResolver,
  shared?: SharedAgents,
): (
  request: FastifyRequest,
  agentId: string,
  extras?: SavedAgentExtras,
) => Promise<SavedAgentCall | undefined> {
  return async (request, agentId, extras = {}) => {
    const userId = userFor(request);
    // A server agent shared with this person's space: the call is still theirs alone, in their
    // own session on the owner's computer.
    const record =
      (await stores.agents.get(userId, agentId)) ?? (await shared?.find(userId, agentId));
    if (record === undefined) return undefined;
    const ownerId = record.user_id;
    const caller = shared?.callerFor(userId, record);
    const parsed =
      record.protocol === 'cord-connector'
        ? parseConnectorEndpoint(record.endpoint_url)
        : undefined;
    const { resumeRef, openingTurn, openingLine } = extras;
    const connector =
      parsed === undefined || resumeRef === undefined ? parsed : { ...parsed, resumeRef };
    return {
      userId,
      agentId: record.id,
      agentName: record.name,
      protocol: record.protocol,
      // A voice later dropped from the list falls back to the default rather than failing the call.
      // Deepgram is always configured, so it is the safe fallback here.
      voiceId: isAllowedVoice(record.voice_id) ? record.voice_id : DEEPGRAM_DEFAULT_VOICE_ID,
      // A team member hears the owner's words plus the ones the agent learned with them.
      keyterms: callWords(record, userId),
      // The agent and its computer are the owner's.
      createAgent: savedAgentFactory(ownerId, record, stores, policy, connector?.resumeRef, caller),
      ...(ownerId !== userId && { agentOwnerId: ownerId }),
      ...(caller !== undefined && { sessionScope: caller.scope }),
      ...(connector !== undefined && { connector }),
      ...(openingTurn !== undefined && { openingTurn }),
      ...(openingLine !== undefined && { openingLine }),
    };
  };
}
