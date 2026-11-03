import { z } from 'zod';

import { turnAttachmentsSchema } from './files';

import { agentEventSchema } from './agent';

/**
 * `cord-agent/1`: the Twring Native WebSocket wire protocol (ADAPTERS §3, AGENT_ADAPTER_SPEC §20).
 * Every frame is one JSON text message. Twring speaks first (`session.hello`); the agent answers
 * `session.ready` before any turn is sent. Additive fields are ignored; breaking changes need a new
 * major version.
 */
export const NATIVE_PROTOCOL = 'cord-agent/1';
/** Largest single frame either side may send. Bigger frames are protocol violations. */
export const MAX_NATIVE_MESSAGE_BYTES = 65_536;

/** Accepts `cord-agent/1` and any `cord-agent/1.x` minor revision. */
export function isSupportedNativeProtocol(protocol: string): boolean {
  return /^cord-agent\/1(\.\d+)?$/.test(protocol);
}

const id = z.string().min(1).max(128);

export const nativeCapabilityNameSchema = z.enum([
  'streaming_text',
  'cancel',
  'activity',
  'tools',
  'approvals',
  'resume',
]);
export type NativeCapabilityName = z.infer<typeof nativeCapabilityNameSchema>;

// Twring → agent

export const nativeSessionHelloSchema = z.object({
  type: z.literal('session.hello'),
  protocol: z.string().max(32),
  session_id: id,
  call_id: id,
  capabilities_requested: z.array(nativeCapabilityNameSchema),
});
export const nativeUserTurnSchema = z.object({
  type: z.literal('user.turn'),
  session_id: id,
  turn_id: id,
  text: z.string().max(8192),
  surface: z.enum(['call', 'text']).optional(),
  /** Files the owner attached, as signed links; agents that predate it ignore it (AGENT_ADAPTER_SPEC §20–22). */
  attachments: turnAttachmentsSchema.optional(),
  started_at: z.string().max(64),
  committed_at: z.string().max(64),
});
export const nativeTurnCancelSchema = z.object({
  type: z.literal('turn.cancel'),
  turn_id: id,
  reason: z.enum(['superseded', 'barge_in', 'call_ended', 'timeout']),
});
export const nativePingSchema = z.object({ type: z.literal('ping'), id });
export const nativeApprovalDecisionSchema = z.object({
  type: z.literal('approval.decision'),
  turn_id: id,
  approval_id: id,
  decision: z.enum(['approve', 'deny']),
});

export const nativeClientMessageSchema = z.discriminatedUnion('type', [
  nativeSessionHelloSchema,
  nativeUserTurnSchema,
  nativeTurnCancelSchema,
  nativePingSchema,
  nativeApprovalDecisionSchema,
]);
export type NativeClientMessage = z.infer<typeof nativeClientMessageSchema>;

// Agent → Twring

export const nativeSessionReadySchema = z.object({
  type: z.literal('session.ready'),
  protocol: z.string().max(32),
  capabilities: z.object({
    streaming_text: z.boolean().optional(),
    cancel: z.boolean().optional(),
    activity: z.boolean().optional(),
    tools: z.boolean().optional(),
    approvals: z.boolean().optional(),
    resume: z.boolean().optional(),
  }),
});
export const nativeSessionErrorSchema = z.object({
  type: z.literal('session.error'),
  code: z.string().min(1).max(64),
  /** Agent-provided text; never shown to users or logged verbatim. */
  message: z.string().max(512).optional(),
});
export const nativePongSchema = z.object({ type: z.literal('pong'), id });

/** Control frames; anything else from the agent must be an `AgentEvent`. */
export const nativeControlMessageSchema = z.discriminatedUnion('type', [
  nativeSessionReadySchema,
  nativeSessionErrorSchema,
  nativePongSchema,
]);
export const nativeServerMessageSchema = z.union([nativeControlMessageSchema, agentEventSchema]);
export type NativeServerMessage = z.infer<typeof nativeServerMessageSchema>;
export type NativeSessionReady = z.infer<typeof nativeSessionReadySchema>;

/** Stable adapter failure codes (AGENT_ADAPTER_SPEC §20). */
export const adapterErrorCodeSchema = z.enum([
  'auth_failed',
  'timeout',
  'protocol_unsupported',
  'protocol_violation',
  'connection_failed',
  'connection_lost',
  'endpoint_rejected',
  'not_connected',
  'agent_error',
  /** A `cord-connector` agent's computer is not connected to Twring right now (ADR-023). */
  'agent_offline',
  /** The user's computer is connected but no longer offers this agent (ADR-023). */
  'agent_not_on_computer',
]);
export type AdapterErrorCode = z.infer<typeof adapterErrorCodeSchema>;
