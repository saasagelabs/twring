import { z } from 'zod';

import { MAX_ACTIVITY_LABEL_CHARS, approvalActionSchema, approvalTitleSchema } from './agent';

/**
 * Media-plane signals between the gateway participant and the phone (ARCHITECTURE §6). They are
 * presentation hints tied to the live call, never durable state.
 */

/** LiveKit identity the gateway joins with. The phone treats only this participant as Twring. */
export const GATEWAY_IDENTITY = 'cord-gateway';

/**
 * Participant attribute the gateway sets on itself. Attributes are replayed to late joiners and
 * after reconnects, so readiness survives a transport blip; a one-shot data packet would not.
 */
export const GATEWAY_STATE_ATTRIBUTE = 'cord.gateway_state';

export const gatewayStateSchema = z.enum(['joining', 'ready', 'ending']);
export type GatewayState = z.infer<typeof gatewayStateSchema>;

/**
 * Participant attribute the gateway sets alongside `ending`: why it is leaving, so the phone can
 * tell the caller what happened (e.g. their agent could not be reached) instead of a generic error.
 */
export const GATEWAY_END_REASON_ATTRIBUTE = 'cord.end_reason';

export const gatewayEndReasonSchema = z.enum([
  'hangup',
  'caller_left',
  'max_duration',
  'shutdown',
  'gateway_failed',
  'voice_unavailable',
  'voice_failed',
  'agent_unavailable',
  /** The caller's calling allowance for the UTC day ran out during the call. */
  'daily_limit',
  /** The agent runs on the user's computer, and that computer is not connected (ADR-023). */
  'agent_offline',
  /** The user's computer is connected but no longer offers this agent (ADR-023). */
  'agent_not_on_computer',
  /** The agent ended the call with its hang-up marker and the owner stayed quiet (ADR-024). */
  'agent_hangup',
  /** The caller's own Deepgram key was refused during the call. */
  'deepgram_key_refused',
  /** The caller's own Cartesia key was refused during the call. */
  'cartesia_key_refused',
  /** The caller's own xAI key was refused during the call. */
  'xai_key_refused',
]);
export type GatewayEndReason = z.infer<typeof gatewayEndReasonSchema>;

/** Data-packet topic for gateway → phone status messages. */
export const STATUS_TOPIC = 'cord.status';

/**
 * Upper bound for a status packet; anything larger is dropped before parsing. Sized for a full
 * caption (1500 characters, up to 3 bytes each in UTF-8) plus envelope.
 */
export const MAX_STATUS_MESSAGE_BYTES = 6144;

/**
 * Proof that gateway ingress hears the caller: sent about once per second while the caller's
 * microphone track is subscribed. `peak_dbfs` is the loudest 20 ms frame in the window.
 */
export const audioStatsMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('audio_stats'),
  call_id: z.string(),
  window_ms: z.number().int().positive(),
  frames_received: z.number().int().nonnegative(),
  peak_dbfs: z.number().min(-200).max(0),
});
export type AudioStatsMessage = z.infer<typeof audioStatsMessageSchema>;

/**
 * Live caption of what the caller is saying. `final` marks the committed user turn; earlier
 * captions for the same `turn_index` are display-only and may change.
 */
export const captionMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('caption'),
  call_id: z.string(),
  turn_index: z.number().int().nonnegative(),
  text: z.string().max(1500),
  final: z.boolean(),
});
export type CaptionMessage = z.infer<typeof captionMessageSchema>;

/**
 * The gateway's conversational floor, sent on every change. It is the whole state, not a delta, so
 * a receiver only needs the highest `seq` it has seen (ADR-014). `turn_id` is set while the agent
 * has the floor; `activity` is a short safe label from the agent's own activity events.
 */
export const floorMessageSchema = z
  .object({
    v: z.literal(1),
    type: z.literal('floor'),
    call_id: z.string(),
    seq: z.number().int().nonnegative(),
    floor: z.enum(['listening', 'user_speaking', 'agent_working', 'agent_speaking']),
    turn_id: z.string().max(64).optional(),
    activity: z.string().max(MAX_ACTIVITY_LABEL_CHARS).optional(),
  })
  .refine(
    (message) =>
      message.turn_id !== undefined ||
      message.floor === 'listening' ||
      message.floor === 'user_speaking',
    { message: 'agent floors need turn_id' },
  );
export type FloorMessage = z.infer<typeof floorMessageSchema>;

/**
 * What the agent is saying for `turn_id`, as visible text: the whole reply so far (tail-clipped to
 * the display limit), not a delta. `final` once the agent finished the turn.
 */
export const agentTextMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('agent_text'),
  call_id: z.string(),
  turn_id: z.string().max(64),
  text: z.string().max(1500),
  final: z.boolean(),
});
export type AgentTextMessage = z.infer<typeof agentTextMessageSchema>;

/** Something the caller should know that isn't a call failure, e.g. the agent didn't answer. */
export const noticeMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('notice'),
  call_id: z.string(),
  code: z.enum(['agent_failed', 'agent_timeout', 'agent_not_streaming', 'agent_unreachable']),
});
export type NoticeMessage = z.infer<typeof noticeMessageSchema>;

export const approvalMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('approval'),
  call_id: z.string(),
  approval_id: z.string().min(1).max(128),
  agent_name: z.string(),
  action: approvalActionSchema,
  title: approvalTitleSchema,
  description: z.string().max(200).optional(),
  expires_at: z.iso.datetime(),
});
export const approvalResolvedMessageSchema = z.object({
  v: z.literal(1),
  type: z.literal('approval_resolved'),
  call_id: z.string(),
  approval_id: z.string().min(1).max(128),
  decision: z.enum(['approve', 'deny']),
  by: z.enum(['voice', 'tap', 'timeout', 'call_end', 'stop']),
});

export const statusMessageSchema = z.discriminatedUnion('type', [
  audioStatsMessageSchema,
  captionMessageSchema,
  floorMessageSchema,
  agentTextMessageSchema,
  noticeMessageSchema,
  approvalMessageSchema,
  approvalResolvedMessageSchema,
]);
export type StatusMessage = z.infer<typeof statusMessageSchema>;

/**
 * Parses an untrusted, already-decoded status packet. Callers drop payloads larger than
 * MAX_STATUS_MESSAGE_BYTES before decoding; this re-checks the decoded length as a backstop.
 * Returns undefined for anything oversized or malformed.
 */
export function parseStatusMessage(text: string): StatusMessage | undefined {
  if (text.length > MAX_STATUS_MESSAGE_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = statusMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}
