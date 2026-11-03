import { z } from 'zod';

import {
  fileIdSchema,
  fileMimeTypeSchema,
  MAX_FILE_NAME_CHARS,
  type TurnAttachment,
} from './files';

/**
 * Twring-normalized agent events (AGENT_ADAPTER_SPEC §7). Every adapter translates its agent's wire
 * format into these before anything else in Twring sees it. Approval events are part of this union.
 */

/** Longest single text delta accepted from an agent; larger deltas are protocol violations. */
export const MAX_AGENT_DELTA_CHARS = 4096;
/** Longest activity/tool label shown in the call UI. */
export const MAX_ACTIVITY_LABEL_CHARS = 80;
export const TEXT_TURN_TAG = '[Twring message]';

const id = z.string().min(1).max(128);
const base = {
  event_id: id,
  turn_id: id,
  seq: z.number().int().nonnegative().optional(),
};

export const approvalActionSchema = z.enum([
  'edit_files',
  'delete_files',
  'run_command',
  'read_files',
  'fetch_web',
  'other',
]);
export type ApprovalAction = z.infer<typeof approvalActionSchema>;
export const approvalTitleSchema = z
  .string()
  .min(1)
  .refine((title) => Array.from(title).length <= 80);

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), ...base, new_session: z.literal(true).optional() }),
  z.object({ type: z.literal('text.start'), ...base, message_id: id }),
  z.object({
    type: z.literal('text.delta'),
    ...base,
    message_id: id,
    delta: z.string().max(MAX_AGENT_DELTA_CHARS),
  }),
  z.object({ type: z.literal('text.end'), ...base, message_id: id }),
  z.object({
    type: z.literal('activity'),
    ...base,
    label: z.string().min(1).max(MAX_ACTIVITY_LABEL_CHARS),
    kind: z.enum(['working', 'searching', 'waiting']).optional(),
  }),
  z.object({
    type: z.literal('tool.start'),
    ...base,
    tool_call_id: id,
    /** Diagnostics only; never shown in the primary call UI (UX_UI_SPEC §12). */
    tool_name: z.string().max(128),
    display_label: z.string().min(1).max(MAX_ACTIVITY_LABEL_CHARS).optional(),
  }),
  z.object({
    type: z.literal('tool.end'),
    ...base,
    tool_call_id: id,
    status: z.enum(['success', 'error', 'cancelled']),
  }),
  z.object({
    type: z.literal('approval.required'),
    ...base,
    approval_id: id,
    action: approvalActionSchema,
    title: approvalTitleSchema,
    description: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal('approval.resolved'),
    ...base,
    approval_id: id,
    decision: z.enum(['approve', 'deny']),
    by: z.enum(['owner', 'timeout', 'cancelled']),
  }),
  z.object({
    type: z.literal('error'),
    ...base,
    code: z.string().max(64),
    retryable: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('done'),
    ...base,
    status: z.enum(['completed', 'cancelled', 'failed']),
  }),
  /**
   * A file for the owner, attached to this turn's reply. A server agent gives an
   * https `url` that Twring fetches once (SSRF guard, 10 MB, no redirects); the connector uploads
   * first and gives `file_id`. Exactly one of the two. Calls ignore it.
   */
  z
    .object({
      type: z.literal('file'),
      ...base,
      name: z.string().min(1).max(MAX_FILE_NAME_CHARS),
      mime_type: fileMimeTypeSchema,
      url: z
        .url({ protocol: /^https$/ })
        .max(2048)
        .optional(),
      file_id: fileIdSchema.optional(),
    })
    .refine((event) => (event.url === undefined) !== (event.file_id === undefined), {
      message: 'exactly one of url or file_id',
      path: ['url'],
    }),
]);
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventType = AgentEvent['type'];

/** A committed user turn, sent to the agent exactly once (AGENT_ADAPTER_SPEC §6). */
export interface UserTurn {
  callId: string;
  sessionId: string;
  turnId: string;
  role: 'user';
  text: string;
  /** Absent means a spoken call turn. */
  surface?: 'call' | 'text';
  /** Files the owner attached (typed turns only), as signed links. */
  attachments?: TurnAttachment[];
  /** ISO 8601. */
  startedAt: string;
  committedAt: string;
}

/** What an adapter really supports; the UI degrades to match and never pretends (§4). */
export interface AdapterCapabilities {
  streamingText: boolean;
  cancellation: boolean;
  resumableStream: boolean;
  activityEvents: boolean;
  toolEvents: boolean;
  approvals: boolean;
  conversationResume: boolean;
  serverInitiatedCalls: boolean;
}

export type TurnCancelReason = 'superseded' | 'barge_in' | 'call_ended' | 'timeout';
