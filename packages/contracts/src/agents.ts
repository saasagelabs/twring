import { z } from 'zod';

import { callIdSchema } from './calls';
import { parseConnectorEndpoint } from './connectors';
import { mcpClientKindSchema } from './mcp-client';
import { gatewayEndReasonSchema } from './realtime';

/**
 * Saved agent profiles, voices, and call history (Milestone 7). These are API models, not storage
 * rows (DATA_MODEL §15): the credential is write-only and never appears in a response.
 */

/** Opaque server-minted agent identifier. */
export const agentIdSchema = z.string().regex(/^agt_[a-z0-9]{20}$/);
export type AgentId = z.infer<typeof agentIdSchema>;

/**
 * `cord-native` = `cord-agent/1` over WebSocket; `cord-rest` = `cord-rest/1` REST + SSE;
 * `cord-connector` = `cord-agent/1` relayed through the user's own `cord-connect` (ADR-023).
 * `mcp-app` = an inbound AI app contact that Twring never calls.
 */
export const agentProtocolSchema = z.enum([
  'cord-native',
  'cord-rest',
  'cord-connector',
  'mcp-app',
  'openai-chat',
]);
export type AgentProtocol = z.infer<typeof agentProtocolSchema>;

/**
 * A voice id: `flux-*` (Deepgram) or `cartesia-*` (Cartesia, ADR-020). The gateway accepts only
 * the ids `GET /v1/voices` lists.
 */
export const voiceIdSchema = z.string().regex(/^(flux|cartesia|xai)-[a-z]+-en$/);
export type VoiceId = z.infer<typeof voiceIdSchema>;

export const agentStatusSchema = z.enum(['untested', 'ready', 'failing']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentNameSchema = z.string().trim().min(1).max(60);
export const agentModelSchema = z.string().trim().min(1).max(200);

/** Accepts a base API URL or the full chat completions URL. */
export function openAiChatEndpoint(raw: string): string {
  if (
    !agentEndpointUrlSchema.safeParse(raw).success ||
    !/^https?:\/\//i.test(raw) ||
    raw.includes('#')
  ) {
    throw new Error('Invalid endpoint URL');
  }
  const queryAt = raw.indexOf('?');
  const base = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const clean = base.replace(/\/+$/, '');
  return `${clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`}${queryAt < 0 ? '' : raw.slice(queryAt)}`;
}

/**
 * C0/C1 controls, every bidi control (overrides, isolates, and the LRM/RLM/ALM marks), and the
 * Unicode line/paragraph separators, which would break a one-line list row. ZWJ/ZWNJ stay allowed:
 * Indic scripts need them. Explicit ranges rather than `\p{...}`, which Hermes may not support.
 */
const UNSAFE_TEXT_CHARACTERS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}]/u;

export const MAX_AGENT_KEYTERMS = 40;
export const MAX_AGENT_KEYTERM_LENGTH = 50;

/** One word or short phrase speech recognition should listen for (a name, a place). */
export const agentKeytermSchema = z
  .string()
  .trim()
  // One canonical spelling, so "Café" typed two ways is one term (and dedupes as one).
  .normalize('NFC')
  .min(1)
  .max(MAX_AGENT_KEYTERM_LENGTH)
  .refine((term) => !UNSAFE_TEXT_CHARACTERS.test(term), {
    message: 'Use ordinary letters, numbers, and symbols.',
  });

/** Case-insensitive de-dup, keeping the first spelling. */
function dedupeKeyterms(terms: string[]): string[] {
  const seen = new Set<string>();
  return terms.filter((term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** An agent's speech-recognition hints: at most 40 terms, trimmed and de-duplicated. */
export const agentKeytermsSchema = z
  .array(agentKeytermSchema)
  .max(MAX_AGENT_KEYTERMS)
  .transform(dedupeKeyterms);

/**
 * Endpoint URLs: http(s) for `cord-rest`, ws(s) for `cord-native`, and
 * `cord-connector://<connector id>/<local agent id>` for `cord-connector`, and
 * `mcp-app://<client id>` for gateway-owned AI app contacts. The SSRF guard runs server-side
 * for network addresses; these private schemes name no network host.
 */
export const agentEndpointUrlSchema = z
  .string()
  .max(2048)
  .refine((url) => {
    if (url.startsWith('mcp-app:')) return /^mcp-app:\/\/[A-Za-z0-9._:-]{1,128}$/.test(url);
    return z.url({ protocol: /^(https?|wss?|cord-connector)$/ }).safeParse(url).success;
  });

/** A write-only bearer token for the agent. Never returned, never logged. */
export const agentCredentialSchema = z.string().min(1).max(4096);

/** One check the connection test actually performed (UX §7: only checks performed are shown). */
export const connectionCheckSchema = z.object({
  name: z.enum(['endpoint', 'authentication', 'response', 'streaming']),
  status: z.enum(['passed', 'failed']),
});
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;

/** Safe summary of a connection test: Twring's own message, never agent or secret text. */
export const connectionTestSummarySchema = z.object({
  ok: z.boolean(),
  checks: z.array(connectionCheckSchema),
  message: z.string(),
  latency_ms: z.number().int().nonnegative().optional(),
  tested_at: z.iso.datetime(),
});
export type ConnectionTestSummary = z.infer<typeof connectionTestSummarySchema>;

export const agentSchema = z.object({
  id: agentIdSchema,
  name: agentNameSchema,
  protocol: agentProtocolSchema,
  mcp_client: mcpClientKindSchema.optional(),
  endpoint_url: agentEndpointUrlSchema,
  model: agentModelSchema.optional(),
  voice_id: voiceIdSchema,
  /** Words to recognise: names and places STT should listen for. */
  keyterms: z.array(z.string()).default([]),
  has_credential: z.boolean(),
  status: agentStatusSchema,
  avatar_version: z.number().int().min(1).optional(),
  /** `cord-connector` agents only: whether the user's computer is connected right now. */
  connector_online: z.boolean().optional(),
  /**
   * `cord-connector` agents only: true when the computer the agent lives on was removed (revoked)
   * from the account. The agent cannot be called until that computer is paired again.
   */
  connector_removed: z.boolean().optional(),
  /**
   * Self-hosted servers only: a server agent everyone in the space can call; only its owner edits
   * or removes it. Absent means false.
   */
  shared: z.boolean().optional(),
  /** Absent means true; false for a shared server agent that someone else owns (view and call only). */
  can_edit: z.boolean().optional(),
  last_tested_at: z.iso.datetime().optional(),
  last_test: connectionTestSummarySchema.optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

/**
 * `POST /v1/agents`: the saved agent. `relinked` when a computer linked again took over its old
 * contact (chats and history kept) instead of creating a new one; older apps ignore it.
 */
export const createAgentResponseSchema = agentSchema.extend({
  relinked: z.literal(true).optional(),
});
export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;

function schemeMatchesProtocol(value: {
  protocol?: AgentProtocol;
  endpoint_url?: string;
}): boolean {
  if (value.protocol === undefined || value.endpoint_url === undefined) return true;
  const scheme = /^([a-z-]+):/i.exec(value.endpoint_url)?.[1]?.toLowerCase();
  switch (value.protocol) {
    case 'cord-native':
      return scheme === 'ws' || scheme === 'wss';
    case 'cord-rest':
    case 'openai-chat':
      return scheme === 'http' || scheme === 'https';
    case 'cord-connector':
      return parseConnectorEndpoint(value.endpoint_url) !== undefined;
    case 'mcp-app':
      return /^mcp-app:\/\/[A-Za-z0-9._:-]{1,128}$/.test(value.endpoint_url);
  }
}

const SCHEME_MESSAGE = {
  message:
    'cord-native endpoints use ws:// or wss://; cord-rest and openai-chat endpoints use http:// or https://; cord-connector endpoints use cord-connector://',
  path: ['endpoint_url'],
};

/** `POST /v1/agents`. `voice_id` defaults to the server's default voice. */
export const createAgentRequestSchema = z
  .object({
    name: agentNameSchema,
    protocol: agentProtocolSchema,
    endpoint_url: agentEndpointUrlSchema,
    model: agentModelSchema.optional(),
    voice_id: voiceIdSchema.optional(),
    keyterms: agentKeytermsSchema.optional(),
    credential: agentCredentialSchema.optional(),
  })
  .strict()
  .refine(schemeMatchesProtocol, SCHEME_MESSAGE)
  .refine((value) => value.protocol !== 'mcp-app', {
    message: 'AI app contacts are created by Twring',
    path: ['protocol'],
  })
  .refine((value) => value.model === undefined || value.protocol === 'openai-chat', {
    message: 'model is only supported for openai-chat',
    path: ['model'],
  });
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;

/**
 * `PATCH /v1/agents/:id`. Omitted fields are unchanged; `credential: null` removes the saved
 * credential. Changing protocol, endpoint, or credential resets the status to `untested`. When only
 * one of protocol/endpoint changes, the server checks the pair against the saved value.
 */
export const updateAgentRequestSchema = z
  .object({
    name: agentNameSchema.optional(),
    protocol: agentProtocolSchema.optional(),
    endpoint_url: agentEndpointUrlSchema.optional(),
    model: agentModelSchema.nullable().optional(),
    voice_id: voiceIdSchema.optional(),
    keyterms: agentKeytermsSchema.optional(),
    credential: agentCredentialSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' })
  .refine(schemeMatchesProtocol, SCHEME_MESSAGE)
  .refine((value) => value.protocol !== 'mcp-app' && !value.endpoint_url?.startsWith('mcp-app:'), {
    message: 'AI app connections are managed by Twring',
    path: ['protocol'],
  });
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

/** `GET /v1/agents`, newest first. */
export const agentListResponseSchema = z.object({ agents: z.array(agentSchema) });
export type AgentListResponse = z.infer<typeof agentListResponseSchema>;

/** `POST /v1/agents/:id/test`: the updated agent plus the result of this test. */
export const connectionTestResponseSchema = z.object({
  agent: agentSchema,
  result: connectionTestSummarySchema,
});
export type ConnectionTestResponse = z.infer<typeof connectionTestResponseSchema>;

export const voiceSchema = z.object({
  id: voiceIdSchema,
  label: z.string(),
  /** Optional URL of a short audio sample. */
  sample: z.url().optional(),
});
export type Voice = z.infer<typeof voiceSchema>;

/** `GET /v1/voices`: the server-owned list of voices an agent may use. */
export const voiceListResponseSchema = z.object({
  voices: z.array(voiceSchema),
  default_voice_id: voiceIdSchema,
});
export type VoiceListResponse = z.infer<typeof voiceListResponseSchema>;

/**
 * Usage of one call, measured by the gateway (OBSERVABILITY_AND_SLOS §16). Counts and durations
 * only: never transcript text. `estimated_cost_usd` is present only when cost rates are configured.
 */
export const callUsageSchema = z.object({
  /** Caller audio streamed to STT (incl. keepalive silence), seconds. */
  stt_audio_s: z.number().nonnegative(),
  /** Time an STT session was open, seconds. */
  stt_connected_s: z.number().nonnegative(),
  /** Characters of agent text sent to TTS. */
  tts_chars: z.number().int().nonnegative(),
  /** Synthesized audio received from TTS, seconds. */
  tts_audio_s: z.number().nonnegative(),
  agent_turns: z.number().int().nonnegative(),
  agent_turns_completed: z.number().int().nonnegative(),
  agent_turns_failed: z.number().int().nonnegative(),
  barge_ins: z.number().int().nonnegative(),
  /** Gateway participant time in the room (room/participant minutes estimate), seconds. */
  gateway_connected_s: z.number().nonnegative(),
  stt_reconnects: z.number().int().nonnegative(),
  tts_reconnects: z.number().int().nonnegative(),
  estimated_cost_usd: z.number().nonnegative().optional(),
});
export type CallUsage = z.infer<typeof callUsageSchema>;

/** One finished call. No transcript and no audio are kept. */
export const callHistoryItemSchema = z.object({
  /** A call id, or for `missed_invite` the invite id (`inv_…`). */
  call_id: z.union([callIdSchema, z.string().regex(/^inv_[a-z2-7]{26}$/)]),
  /** Absent (a call) on items recorded before rings existed (ADR-024). */
  kind: z.enum(['call', 'missed_invite']).optional(),
  /** `missed_invite`: why the agent rang. Plain text, never rendered as HTML. */
  reason: z.string().max(140).optional(),
  agent_id: agentIdSchema,
  agent_name: z.string(),
  started_at: z.iso.datetime(),
  duration_s: z.number().int().nonnegative(),
  outcome: z.enum(['completed', 'failed', 'missed']),
  /** Absent on `missed_invite` items (no call took place). */
  end_reason: gatewayEndReasonSchema.optional(),
  /** Absent on calls recorded before usage telemetry, or that never reached the room. */
  usage: callUsageSchema.optional(),
  /** Whose speech key each provider used: the person's own or Twring's. Never the key itself. */
  speech_source: z
    .object({
      deepgram: z.enum(['own', 'twring']).optional(),
      cartesia: z.enum(['own', 'twring']).optional(),
      xai: z.enum(['own', 'twring']).optional(),
    })
    .optional(),
});
export type CallHistoryItem = z.infer<typeof callHistoryItemSchema>;

/** `GET /v1/calls/history`: the most recent calls (up to 50), newest first. */
export const callHistoryResponseSchema = z.object({ calls: z.array(callHistoryItemSchema) });
export type CallHistoryResponse = z.infer<typeof callHistoryResponseSchema>;

/**
 * `DELETE /v1/me/data`: everything Twring stored for the calling user is gone. Counts are what was
 * removed; `live_calls_ended` counts calls that were still running and were hung up first.
 */
export const deleteMyDataResponseSchema = z.object({
  deleted: z.object({
    agents: z.number().int().nonnegative(),
    credentials: z.number().int().nonnegative(),
    call_history: z.number().int().nonnegative(),
    /** Paired computers revoked (ADR-023); absent from servers without connectors. */
    connectors: z.number().int().nonnegative().optional(),
    /** Push-registered phones removed (ADR-024); absent from servers without rings. */
    devices: z.number().int().nonnegative().optional(),
    /** Ring invites removed (ADR-024). */
    ring_invites: z.number().int().nonnegative().optional(),
    /** Text messages removed with the user's threads. */
    messages: z.number().int().nonnegative().optional(),
    /** Saved voice account keys removed. */
    speech_keys: z.number().int().nonnegative().optional(),
  }),
  live_calls_ended: z.number().int().nonnegative(),
});
export type DeleteMyDataResponse = z.infer<typeof deleteMyDataResponseSchema>;

/**
 * `POST /v1/me/apple-revoke`: before an account made with
 * Sign in with Apple is deleted, the phone gets a fresh authorization code from Apple and the
 * gateway uses it to end Twring's Apple sign-in. 204 when done.
 */
export const appleRevokeRequestSchema = z
  .object({ authorization_code: z.string().min(1).max(2048) })
  .strict();
export type AppleRevokeRequest = z.infer<typeof appleRevokeRequestSchema>;

/**
 * `GET /v1/me/usage`: today's calling (UTC day) against the allowance. An allowance of `null`
 * means unlimited.
 */
export const meUsageResponseSchema = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Next UTC midnight, when the counts start again. */
  resets_at: z.iso.datetime(),
  call_seconds_used: z.number().int().nonnegative(),
  call_seconds_allowed: z.number().int().positive().nullable(),
  calls_used: z.number().int().nonnegative(),
  calls_allowed: z.number().int().positive().nullable(),
});
export type MeUsageResponse = z.infer<typeof meUsageResponseSchema>;
