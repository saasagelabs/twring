import {
  agentListResponseSchema,
  accessResponseSchema,
  inviteRedeemRequestSchema,
  agentSchema,
  createAgentResponseSchema,
  createCallResponseSchema,
  connectedAppListResponseSchema,
  ringAnswerResponseSchema,
  type ConnectedApp,
  callFeedbackRequestSchema,
  callFeedbackResponseSchema,
  appFeedbackRequestSchema,
  appFeedbackResponseSchema,
  type CallFeedbackRequest,
  connectionTestResponseSchema,
  connectorListResponseSchema,
  deleteMyDataResponseSchema,
  pairingResponseSchema,
  pairingStatusResponseSchema,
  linkApproveResponseSchema,
  linkRequestDetailsSchema,
  errorResponseSchema,
  speechKeyListResponseSchema,
  type SpeechKeyListResponse,
  type SpeechProvider,
  type ListeningProvider,
  gatewayEndReasonSchema,
  listeningProviderSchema,
  speechProviderSchema,
  voiceIdSchema,
  meUsageResponseSchema,
  memberCodeResponseSchema,
  peopleListResponseSchema,
  serverInfoSchema,
  voiceListResponseSchema,
  threadListResponseSchema,
  messagePageResponseSchema,
  threadMessageSchema,
  newConversationResponseSchema,
  fileUploadResponseSchema,
  type Attachment,
  type Agent,
  type CallHistoryItem,
  type CreateCallResponse,
  type ConnectionTestResponse,
  type Connector,
  type PairingResponse,
  type PairingStatusResponse,
  type LinkApproveResponse,
  type LinkRequestDetails,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type DeleteMyDataResponse,
  type ErrorCode,
  type MeUsageResponse,
  type ServerInfo,
  type UpdateAgentRequest,
  type VoiceListResponse,
  type ThreadSummary,
  type ThreadMessage,
} from '@twring/contracts';
import { z } from 'zod';

import { withAuth, type ApiAuth } from '../auth/controller';
import {
  historyResponseSchema,
  inviteListResponseSchema,
  inviteSchema,
  ringSettingsSchema,
  type DeclineRequest,
  type HistoryEntry,
  type Invite,
  type RegisterDeviceRequest,
  type RingSettings,
} from '../ring/protocol';

/**
 * Why a Twring API request failed. Carries only the stable code and request id, never server text:
 * user copy comes from `apiErrorCopy`.
 */
/** Longest server sentence shown to a person. */
export const SERVER_MESSAGE_MAX = 200;

export class ApiError extends Error {
  constructor(
    readonly kind: 'network' | 'timeout' | 'cancelled' | 'http' | 'invalid_response',
    readonly code?: ErrorCode,
    readonly requestId?: string,
    /** With `daily_limit_reached`: when today's allowance renews. */
    readonly resetsAt?: Date,
    /** HTTP status of an `http` failure; tells apart codes this build does not know yet. */
    readonly status?: number,
    readonly currentMessage?: ThreadMessage,
    /** The server's own sentence; only the speech key codes show it (it names the provider). */
    readonly serverMessage?: string,
  ) {
    super(`cord api ${kind}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
  }
}

export interface TwringApi {
  listConnectedApps(signal?: AbortSignal): Promise<ConnectedApp[]>;
  blockConnectedApp(clientId: string, signal?: AbortSignal): Promise<void>;
  allowConnectedApp(clientId: string, signal?: AbortSignal): Promise<void>;
  agentAvatarUrl(agentId: string): Promise<{ uri: string; headers: Record<string, string> }>;
  setAgentAvatar(agentId: string, fileUri: string, signal?: AbortSignal): Promise<Agent>;
  removeAgentAvatar(agentId: string, signal?: AbortSignal): Promise<Agent>;
  getAccess?(signal?: AbortSignal): Promise<{ member: boolean; email?: string }>;
  redeemInvite?(code: string, signal?: AbortSignal): Promise<{ member: boolean; email?: string }>;
  messageSpeechUrl(
    agentId: string,
    messageId: string,
  ): Promise<{ uri: string; headers: Record<string, string> }>;
  fileSource?(
    agentId: string,
    fileId: string,
  ): Promise<{ uri: string; headers: Record<string, string> }>;
  uploadFile?(
    agentId: string,
    file: { clientId: string; uri: string; name: string; mimeType: string },
    signal?: AbortSignal,
  ): Promise<Attachment>;
  listThreads(signal?: AbortSignal): Promise<{ threads: ThreadSummary[]; files: boolean }>;
  listMessages(
    agentId: string,
    options?: { beforeSeq?: number; afterRev?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ messages: ThreadMessage[]; hasMore: boolean }>;
  sendMessage(
    agentId: string,
    message: { clientId: string; text: string; attachmentIds?: string[] },
    signal?: AbortSignal,
  ): Promise<ThreadMessage>;
  sendVoiceNote(
    agentId: string,
    clientId: string,
    durationMs: number,
    fileUri: string,
    signal?: AbortSignal,
  ): Promise<ThreadMessage>;
  stopMessage(agentId: string, messageId: string, signal?: AbortSignal): Promise<ThreadMessage>;
  decideChatApproval(
    agentId: string,
    messageId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): Promise<ThreadMessage>;
  markRead(agentId: string, seq: number, signal?: AbortSignal): Promise<void>;
  clearChat(agentId: string, signal?: AbortSignal): Promise<{ deleted: number }>;
  newConversation(agentId: string, signal?: AbortSignal): Promise<{ ok: true }>;
  listVoices(signal?: AbortSignal): Promise<VoiceListResponse>;
  listAgents(signal?: AbortSignal): Promise<Agent[]>;
  getAgent(id: string, signal?: AbortSignal): Promise<Agent>;
  createAgent(request: CreateAgentRequest, signal?: AbortSignal): Promise<CreateAgentResponse>;
  updateAgent(id: string, request: UpdateAgentRequest, signal?: AbortSignal): Promise<Agent>;
  deleteAgent(id: string, signal?: AbortSignal): Promise<void>;
  testAgent(id: string, signal?: AbortSignal): Promise<ConnectionTestResponse>;
  /** Completed and failed calls only (what an agent's page lists). */
  callHistory(signal?: AbortSignal): Promise<CallHistoryItem[]>;
  sendCallFeedback(callId: string, body: CallFeedbackRequest, signal?: AbortSignal): Promise<void>;
  /** A note from Settings (Send feedback), at any time. */
  sendAppFeedback(note: string, signal?: AbortSignal): Promise<void>;
  /** Calls and missed rings, newest first. */
  history(signal?: AbortSignal): Promise<HistoryEntry[]>;
  /** Deletes every agent, saved key, and call summary of this user; ends their live calls. */
  deleteMyData(signal?: AbortSignal): Promise<DeleteMyDataResponse>;
  /** Ends Sign in with Apple before an Apple account is deleted, with a fresh code from Apple. */
  revokeAppleSignIn?(authorizationCode: string, signal?: AbortSignal): Promise<void>;
  /** Today's calling (UTC day) against the daily allowance. */
  usage(signal?: AbortSignal): Promise<MeUsageResponse>;
  /** Self-hosted: this server's name, audio and ring service state. */
  serverInfo(signal?: AbortSignal): Promise<ServerInfo>;
  /** Self-hosted: everyone on the server for an admin, only the caller for a member. */
  listPeople(signal?: AbortSignal): Promise<PeopleList>;
  /** Self-hosted, admins: a one-time code a teammate pairs with. */
  createMemberCode(signal?: AbortSignal): Promise<MemberCode>;
  /** Self-hosted, admins: removes a person (409 `last_admin` for the last admin). */
  removePerson(personId: string, signal?: AbortSignal): Promise<void>;
  /** A one-time code for pairing a computer with `cord-connect` (ADR-023). */
  createPairing(signal?: AbortSignal): Promise<PairingResponse>;
  getPairing(pairingId: string, signal?: AbortSignal): Promise<PairingStatusResponse>;
  /** A computer asking to be linked, by the code it shows (ADR-025). */
  getLinkRequest(code: string, signal?: AbortSignal): Promise<LinkRequestDetails>;
  approveLink(code: string, signal?: AbortSignal): Promise<LinkApproveResponse>;
  rejectLink(code: string, signal?: AbortSignal): Promise<void>;
  listConnectors(signal?: AbortSignal): Promise<Connector[]>;
  // Incoming agent calls
  registerDevice(
    deviceId: string,
    request: RegisterDeviceRequest,
    signal?: AbortSignal,
  ): Promise<void>;
  unregisterDevice(deviceId: string, signal?: AbortSignal): Promise<void>;
  /** Both providers, each with its saved key's last four characters or null. A 404 means off. */
  listSpeechKeys(signal?: AbortSignal): Promise<SpeechKeyListResponse['providers']>;
  saveSpeechKey(provider: SpeechProvider, key: string, signal?: AbortSignal): Promise<void>;
  removeSpeechKey(provider: SpeechProvider, signal?: AbortSignal): Promise<void>;
  /** The providers plus who listens and whether the person can choose (both keys saved). */
  speechKeyState(signal?: AbortSignal): Promise<SpeechKeyListResponse>;
  /** 400 if that provider has no saved key. */
  setListeningProvider(provider: ListeningProvider, signal?: AbortSignal): Promise<void>;
  ringSettings(signal?: AbortSignal): Promise<RingSettings>;
  updateRingSettings(settings: RingSettings, signal?: AbortSignal): Promise<RingSettings>;
  getInvite(inviteId: string, signal?: AbortSignal): Promise<Invite>;
  pendingInvites(signal?: AbortSignal): Promise<Invite[]>;
  /** Same body as `POST /v1/calls`: the call to join. */
  answerInvite(inviteId: string, signal?: AbortSignal): Promise<InviteAnswer>;
  declineInvite(inviteId: string, request: DeclineRequest, signal?: AbortSignal): Promise<void>;
  decideApproval(
    callId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
    signal?: AbortSignal,
  ): Promise<void>;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export type PeopleList = z.infer<typeof peopleListResponseSchema>['people'];
export type MemberCode = z.infer<typeof memberCodeResponseSchema>;

export type InviteAnswer =
  { mode: 'call'; session: CreateCallResponse } | { mode: 'chat'; agentId: string };

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TwringApiOptions {
  baseUrl: string;
  /** Sent as `x-app-version` ("0.1.0 (12) android"), so ratings and notes name their build. */
  appVersion?: string;
  fetch?: Fetch;
  timers?: TimerApi;
  /** Ordinary requests. */
  timeoutMs?: number;
  /** The connection test runs up to ~20 s on the server. */
  testTimeoutMs?: number;
  /** Signed-in token hooks (ADR-021); absent when sign-in is off (AUTH_MODE=dev gateway). */
  auth?: ApiAuth;
  /** An answered invite's LiveKit URL must be wss:// outside development (like `POST /v1/calls`). */
  requireSecureMedia?: boolean;
  /** A person's own server: requests carrying its token follow no redirect. */
  rejectRedirects?: boolean;
}

export const API_TIMEOUT_MS = 15_000;
export const TEST_TIMEOUT_MS = 30_000;

const systemTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An older server sends no listening fields: its Deepgram listens and there is no choice. A newer
 * server may list a provider, or a listener, this app does not know: drop that row, and read an
 * unknown listener as Deepgram with no choice, so the screen still works for the known ones.
 */
function withListeningDefaults(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const providers = Array.isArray(body.providers)
    ? body.providers.filter(
        (row: unknown) =>
          !isRecord(row) ||
          typeof row.provider !== 'string' ||
          speechProviderSchema.safeParse(row.provider).success,
      )
    : body.providers;
  const known =
    !('listening' in body) ||
    typeof body.listening !== 'string' ||
    listeningProviderSchema.safeParse(body.listening).success;
  return {
    listening: 'deepgram',
    listening_choice: false,
    ...body,
    providers,
    ...(known ? {} : { listening: 'deepgram', listening_choice: false }),
  };
}

/**
 * Stands in for a saved voice id with a prefix this app does not know (a newer server's voice). It
 * is never offered, so the agent shows "Default voice" and the picker asks for another.
 */
const UNKNOWN_VOICE_ID = 'flux-unavailable-en';

const unknownVoiceId = (id: unknown): boolean =>
  typeof id === 'string' && !voiceIdSchema.safeParse(id).success;

function withKnownVoice(agent: unknown): unknown {
  if (!isRecord(agent) || !unknownVoiceId(agent.voice_id)) return agent;
  return { ...agent, voice_id: UNKNOWN_VOICE_ID };
}

/** A newer server's voices this app cannot use are left out of the offered list. */
function withKnownVoices(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.voices)) return body;
  return {
    ...body,
    voices: body.voices.filter((voice: unknown) => !isRecord(voice) || !unknownVoiceId(voice.id)),
    ...(unknownVoiceId(body.default_voice_id) ? { default_voice_id: UNKNOWN_VOICE_ID } : {}),
  };
}

function withKnownAgentVoices(body: unknown): unknown {
  if (!isRecord(body) || !Array.isArray(body.agents)) return body;
  return { ...body, agents: body.agents.map(withKnownVoice) };
}

/**
 * A newer server can end calls for reasons this app has never heard of (a future voice account).
 * Drop such an `end_reason` so the row still shows, with the generic ended copy, instead of the
 * whole history failing to parse.
 */
function withoutUnknownEndReasons(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const calls = (body as { calls?: unknown }).calls;
  if (!Array.isArray(calls)) return body;
  return {
    ...body,
    calls: calls.map((call: unknown) => {
      if (typeof call !== 'object' || call === null || !('end_reason' in call)) return call;
      if (gatewayEndReasonSchema.safeParse(call.end_reason).success) return call;
      const rest: Record<string, unknown> = { ...call };
      delete rest.end_reason;
      return rest;
    }),
  };
}

/** The auth failure a request ended with, for the refresh-and-retry-once rule. */
/** Server text is kept for the speech key codes (it names the provider) and a self-hosted sign-out. */
function keepsServerMessage(code: string): boolean {
  return code.startsWith('speech_key_') || code === 'device_removed' || code === 'auth_required';
}

function authCodeOf(
  error: unknown,
): 'auth_invalid' | 'auth_required' | 'device_removed' | undefined {
  if (!(error instanceof ApiError) || error.kind !== 'http') return undefined;
  return error.code === 'auth_invalid' ||
    error.code === 'auth_required' ||
    error.code === 'device_removed'
    ? error.code
    : undefined;
}

let onNotInvited: (() => void) | undefined;
export function setNotInvitedHandler(handler: () => void): void {
  onNotInvited = handler;
}

export function createTwringApi(options: TwringApiOptions): TwringApi {
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const timers = options.timers ?? systemTimers;
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  const testTimeoutMs = options.testTimeoutMs ?? TEST_TIMEOUT_MS;
  const requireSecureMedia = options.requireSecureMedia ?? true;

  type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  type RequestInit = {
    body?: object;
    rawBody?: Blob;
    contentType?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  };

  function request(method: Method, path: string, init: RequestInit = {}): Promise<unknown> {
    return withAuth(options.auth, (headers) => send(method, path, init, headers), authCodeOf);
  }

  async function send(
    method: Method,
    path: string,
    init: RequestInit,
    authHeaders: Record<string, string>,
  ): Promise<unknown> {
    // One abort for both the caller's cancel and our own deadline, told apart afterwards.
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (init.signal?.aborted) throw new ApiError('cancelled');
    init.signal?.addEventListener('abort', onAbort);
    const timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, init.timeoutMs ?? timeoutMs);
    const failure = (): ApiError => new ApiError(timedOut ? 'timeout' : 'cancelled');

    try {
      let response: Response;
      try {
        response = await doFetch(`${base}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            ...(options.appVersion !== undefined && { 'x-app-version': options.appVersion }),
            ...authHeaders,
            ...(init.body !== undefined && { 'content-type': 'application/json' }),
            ...(init.contentType && { 'content-type': init.contentType }),
          },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
          ...(init.rawBody !== undefined && { body: init.rawBody }),
          ...(options.rejectRedirects === true && { redirect: 'error' as const }),
          signal: controller.signal,
        });
      } catch {
        throw controller.signal.aborted ? failure() : new ApiError('network');
      }
      if (response.status === 204) return undefined;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (controller.signal.aborted) throw failure();
        throw new ApiError(
          response.ok ? 'invalid_response' : 'http',
          undefined,
          undefined,
          undefined,
          response.ok ? undefined : response.status,
        );
      }
      if (!response.ok) {
        const parsed = errorResponseSchema.safeParse(body);
        if (parsed.success && parsed.data.error.code === 'not_invited') onNotInvited?.();
        throw new ApiError(
          'http',
          parsed.success ? parsed.data.error.code : undefined,
          parsed.success ? parsed.data.error.request_id : undefined,
          parsed.success && parsed.data.error.resets_at !== undefined
            ? new Date(parsed.data.error.resets_at)
            : undefined,
          response.status,
          response.status === 409
            ? z.object({ message: threadMessageSchema }).safeParse(body).data?.message
            : undefined,
          parsed.success && keepsServerMessage(parsed.data.error.code)
            ? parsed.data.error.message.slice(0, SERVER_MESSAGE_MAX)
            : undefined,
        );
      }
      return body;
    } finally {
      timers.clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError('invalid_response');
    return parsed.data;
  }

  const agentPath = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;
  const devicePath = (id: string) => `/v1/me/devices/${encodeURIComponent(id)}`;
  const invitePath = (id: string) => `/v1/invites/${encodeURIComponent(id)}`;
  const connectedAppPath = (id: string) => `/v1/me/connected-apps/${encodeURIComponent(id)}`;

  async function history(signal?: AbortSignal): Promise<HistoryEntry[]> {
    const body = await request('GET', '/v1/calls/history', { signal });
    return parse(historyResponseSchema, withoutUnknownEndReasons(body)).calls;
  }

  return {
    async listConnectedApps(signal) {
      return parse(
        connectedAppListResponseSchema,
        await request('GET', '/v1/me/connected-apps', { signal }),
      ).apps;
    },
    async blockConnectedApp(clientId, signal) {
      await request('POST', `${connectedAppPath(clientId)}/block`, { body: {}, signal });
    },
    async allowConnectedApp(clientId, signal) {
      await request('POST', `${connectedAppPath(clientId)}/allow`, { body: {}, signal });
    },
    agentAvatarUrl(agentId) {
      return withAuth(
        options.auth,
        (headers) => Promise.resolve({ uri: `${base}${agentPath(agentId)}/avatar`, headers }),
        authCodeOf,
      );
    },
    async setAgentAvatar(agentId, fileUri, signal) {
      let rawBody: Blob;
      try {
        const response = await doFetch(fileUri, { method: 'GET', signal });
        if (!response.ok) throw new ApiError('network');
        rawBody = new Blob([await response.blob()], { type: 'image/jpeg' });
      } catch {
        throw new ApiError(signal?.aborted ? 'cancelled' : 'network');
      }
      return parse(
        agentSchema,
        withKnownVoice(
          await request('PUT', `${agentPath(agentId)}/avatar`, {
            rawBody,
            contentType: 'image/jpeg',
            signal,
          }),
        ),
      );
    },
    async sendCallFeedback(callId, body, signal) {
      parse(
        callFeedbackResponseSchema,
        await request('POST', `/v1/calls/${encodeURIComponent(callId)}/feedback`, {
          body: callFeedbackRequestSchema.parse(body),
          signal,
        }),
      );
    },
    async sendAppFeedback(note, signal) {
      parse(
        appFeedbackResponseSchema,
        await request('POST', '/v1/me/feedback', {
          body: appFeedbackRequestSchema.parse({ note }),
          signal,
        }),
      );
    },
    async removeAgentAvatar(agentId, signal) {
      return parse(
        agentSchema,
        withKnownVoice(await request('DELETE', `${agentPath(agentId)}/avatar`, { signal })),
      );
    },
    async getAccess(signal) {
      try {
        return parse(accessResponseSchema, await request('GET', '/v1/me/access', { signal }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') {
          return { member: true };
        }
        throw error;
      }
    },
    async redeemInvite(code, signal) {
      const body = inviteRedeemRequestSchema.parse({ code });
      return parse(accessResponseSchema, await request('POST', '/v1/me/invite', { body, signal }));
    },
    messageSpeechUrl(agentId, messageId) {
      return withAuth(
        options.auth,
        (headers) =>
          Promise.resolve({
            uri: `${base}${agentPath(agentId)}/messages/${encodeURIComponent(messageId)}/speech`,
            headers,
          }),
        authCodeOf,
      );
    },
    fileSource(agentId, fileId) {
      return withAuth(
        options.auth,
        (headers) =>
          Promise.resolve({
            uri: `${base}${agentPath(agentId)}/files/${encodeURIComponent(fileId)}`,
            headers,
          }),
        authCodeOf,
      );
    },
    async uploadFile(agentId, file, signal) {
      let rawBody: Blob;
      try {
        const fileResponse = await doFetch(file.uri, { method: 'GET', signal });
        if (!fileResponse.ok) throw new ApiError('network');
        rawBody = new Blob([await fileResponse.blob()], { type: file.mimeType });
      } catch {
        throw new ApiError(signal?.aborted ? 'cancelled' : 'network');
      }
      const query = new URLSearchParams({ client_id: file.clientId, name: file.name });
      return parse(
        fileUploadResponseSchema,
        await request('POST', `${agentPath(agentId)}/files?${query}`, {
          rawBody,
          contentType: file.mimeType,
          signal,
          timeoutMs: 60_000,
        }),
      ).file;
    },
    async listThreads(signal) {
      const result = parse(
        threadListResponseSchema,
        await request('GET', '/v1/threads', { signal }),
      );
      return { threads: result.threads, files: result.files === true };
    },
    async listMessages(agentId, options = {}, signal) {
      const query = new URLSearchParams();
      if (options.beforeSeq !== undefined) query.set('before_seq', String(options.beforeSeq));
      if (options.afterRev !== undefined) query.set('after_rev', String(options.afterRev));
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size ? `?${query.toString()}` : '';
      const page = parse(
        messagePageResponseSchema,
        await request('GET', `${agentPath(agentId)}/messages${suffix}`, { signal }),
      );
      return { messages: page.messages, hasMore: page.has_more };
    },
    async sendMessage(agentId, message, signal) {
      return parse(
        z.object({ message: threadMessageSchema }),
        await request('POST', `${agentPath(agentId)}/messages`, {
          body: {
            client_id: message.clientId,
            text: message.text,
            ...(message.attachmentIds?.length && { attachment_ids: message.attachmentIds }),
          },
          signal,
        }),
      ).message;
    },
    async sendVoiceNote(agentId, clientId, durationMs, fileUri, signal) {
      let rawBody: Blob;
      try {
        const fileResponse = await doFetch(fileUri, { method: 'GET', signal });
        if (!fileResponse.ok) throw new ApiError('network');
        // Android sends a Blob with its own type and ignores the content-type header, so the
        // type goes on the Blob itself.
        rawBody = new Blob([await fileResponse.blob()], { type: 'audio/mp4' });
      } catch {
        throw new ApiError(signal?.aborted ? 'cancelled' : 'network');
      }
      const query = new URLSearchParams({ client_id: clientId, duration_ms: String(durationMs) });
      return parse(
        z.object({ message: threadMessageSchema }),
        await request('POST', `${agentPath(agentId)}/voice-notes?${query}`, {
          rawBody,
          contentType: 'audio/mp4',
          signal,
          timeoutMs: 45_000,
        }),
      ).message;
    },
    async stopMessage(agentId, messageId, signal) {
      return parse(
        z.object({ message: threadMessageSchema }),
        await request(
          'POST',
          `${agentPath(agentId)}/messages/${encodeURIComponent(messageId)}/stop`,
          { body: {}, signal },
        ),
      ).message;
    },
    async decideChatApproval(agentId, messageId, decision, signal) {
      return parse(
        z.object({ message: threadMessageSchema }),
        await request('POST', `${agentPath(agentId)}/approvals/${encodeURIComponent(messageId)}`, {
          body: { decision },
          signal,
        }),
      ).message;
    },
    async markRead(agentId, seq, signal) {
      await request('PUT', `${agentPath(agentId)}/read`, { body: { seq }, signal });
    },
    async clearChat(agentId, signal) {
      return parse(
        z.object({ deleted: z.number().int().nonnegative() }),
        await request('DELETE', `${agentPath(agentId)}/messages`, { signal }),
      );
    },
    async newConversation(agentId, signal) {
      return parse(
        newConversationResponseSchema,
        await request('POST', `${agentPath(agentId)}/new-conversation`, { signal }),
      );
    },
    async listVoices(signal) {
      return parse(
        voiceListResponseSchema,
        withKnownVoices(await request('GET', '/v1/voices', { signal })),
      );
    },
    async listAgents(signal) {
      return parse(
        agentListResponseSchema,
        withKnownAgentVoices(await request('GET', '/v1/agents', { signal })),
      ).agents;
    },
    async getAgent(id, signal) {
      return parse(agentSchema, withKnownVoice(await request('GET', agentPath(id), { signal })));
    },
    async createAgent(body, signal) {
      return parse(
        createAgentResponseSchema,
        await request('POST', '/v1/agents', { body, signal }),
      );
    },
    async updateAgent(id, body, signal) {
      return parse(
        agentSchema,
        withKnownVoice(await request('PATCH', agentPath(id), { body, signal })),
      );
    },
    async deleteAgent(id, signal) {
      await request('DELETE', agentPath(id), { signal });
    },
    async testAgent(id, signal) {
      return parse(
        connectionTestResponseSchema,
        await request('POST', `${agentPath(id)}/test`, {
          body: {},
          signal,
          timeoutMs: testTimeoutMs,
        }),
      );
    },
    async callHistory(signal) {
      const entries = await history(signal);
      return entries.flatMap((entry) => (entry.kind === 'missed_invite' ? [] : [entry]));
    },
    history,
    async createPairing(signal) {
      return parse(
        pairingResponseSchema,
        await request('POST', '/v1/connectors/pairings', { body: {}, signal }),
      );
    },
    async getPairing(pairingId, signal) {
      return parse(
        pairingStatusResponseSchema,
        await request('GET', `/v1/connectors/pairings/${encodeURIComponent(pairingId)}`, {
          signal,
        }),
      );
    },
    async getLinkRequest(code, signal) {
      return parse(
        linkRequestDetailsSchema,
        await request('GET', `/v1/link-requests/${encodeURIComponent(code)}`, { signal }),
      );
    },
    async approveLink(code, signal) {
      return parse(
        linkApproveResponseSchema,
        await request('POST', `/v1/link-requests/${encodeURIComponent(code)}/approve`, {
          body: {},
          signal,
        }),
      );
    },
    async rejectLink(code, signal) {
      await request('POST', `/v1/link-requests/${encodeURIComponent(code)}/reject`, {
        body: {},
        signal,
      });
    },
    async listConnectors(signal) {
      return parse(connectorListResponseSchema, await request('GET', '/v1/connectors', { signal }))
        .connectors;
    },
    async deleteMyData(signal) {
      return parse(deleteMyDataResponseSchema, await request('DELETE', '/v1/me/data', { signal }));
    },
    async revokeAppleSignIn(authorizationCode, signal) {
      await request('POST', '/v1/me/apple-revoke', {
        body: { authorization_code: authorizationCode },
        signal,
      });
    },
    async usage(signal) {
      return parse(meUsageResponseSchema, await request('GET', '/v1/me/usage', { signal }));
    },
    async serverInfo(signal) {
      return parse(serverInfoSchema, await request('GET', '/v1/server', { signal }));
    },
    async listPeople(signal) {
      return parse(peopleListResponseSchema, await request('GET', '/v1/people', { signal })).people;
    },
    async createMemberCode(signal) {
      return parse(
        memberCodeResponseSchema,
        await request('POST', '/v1/people/codes', { body: {}, signal }),
      );
    },
    async removePerson(personId, signal) {
      await request('DELETE', `/v1/people/${encodeURIComponent(personId)}`, { signal });
    },
    async registerDevice(deviceId, body, signal) {
      await request('PUT', devicePath(deviceId), { body, signal });
    },
    async unregisterDevice(deviceId, signal) {
      await request('DELETE', devicePath(deviceId), { signal });
    },
    async listSpeechKeys(signal) {
      return parse(
        speechKeyListResponseSchema,
        withListeningDefaults(await request('GET', '/v1/me/speech-keys', { signal })),
      ).providers;
    },
    async saveSpeechKey(provider, key, signal) {
      await request('PUT', `/v1/me/speech-keys/${provider}`, { body: { key }, signal });
    },
    async removeSpeechKey(provider, signal) {
      await request('DELETE', `/v1/me/speech-keys/${provider}`, { signal });
    },
    async speechKeyState(signal) {
      return parse(
        speechKeyListResponseSchema,
        withListeningDefaults(await request('GET', '/v1/me/speech-keys', { signal })),
      );
    },
    async setListeningProvider(provider, signal) {
      await request('PUT', '/v1/me/speech-keys/listening', { body: { provider }, signal });
    },
    async ringSettings(signal) {
      return parse(ringSettingsSchema, await request('GET', '/v1/me/ring-settings', { signal }));
    },
    async updateRingSettings(body, signal) {
      return parse(
        ringSettingsSchema,
        await request('PUT', '/v1/me/ring-settings', { body, signal }),
      );
    },
    async getInvite(inviteId, signal) {
      return parse(inviteSchema, await request('GET', invitePath(inviteId), { signal }));
    },
    async pendingInvites(signal) {
      return parse(
        inviteListResponseSchema,
        await request('GET', '/v1/invites?status=pending', { signal }),
      ).invites;
    },
    async answerInvite(inviteId, signal) {
      const session = parse(
        ringAnswerResponseSchema,
        await request('POST', `${invitePath(inviteId)}/answer`, { body: {}, signal }),
      );
      if (
        session.mode === 'call' &&
        requireSecureMedia &&
        !session.livekit.url.startsWith('wss://')
      ) {
        throw new ApiError('invalid_response');
      }
      if (session.mode === 'chat') return { mode: 'chat', agentId: session.agent_id };
      return { mode: 'call', session: createCallResponseSchema.parse(session) };
    },
    async declineInvite(inviteId, body, signal) {
      await request('POST', `${invitePath(inviteId)}/decline`, { body, signal });
    },
    async decideApproval(callId, approvalId, decision, signal) {
      await request(
        'POST',
        `/v1/calls/${encodeURIComponent(callId)}/approvals/${encodeURIComponent(approvalId)}`,
        { body: { decision }, signal },
      );
    },
  };
}
