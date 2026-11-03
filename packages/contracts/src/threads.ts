import { z } from 'zod';

import { agentIdSchema } from './agents';
import { MAX_ACTIVITY_LABEL_CHARS } from './agent';
import { attachmentSchema, fileIdSchema, MAX_ATTACHMENTS_PER_MESSAGE } from './files';

export const MAX_USER_MESSAGE_CHARS = 4_000;
export const MAX_STORED_AGENT_MESSAGE_CHARS = 20_000;
export const MAX_MESSAGES_PER_THREAD = 2_000;
export const MAX_QUEUED_PER_THREAD = 5;
export const QUEUED_MESSAGE_TTL_MS = 24 * 60 * 60_000;
export const APPROVAL_HOLD_MS = 10 * 60_000;

export const threadMessageIdSchema = z.string().regex(/^msg_[a-z2-7]{20}$/);
export const userMessageStatusSchema = z.enum([
  'queued',
  'sent',
  'working',
  'answered',
  'failed',
  'stopped',
  'interrupted',
  'expired',
]);
export type UserMessageStatus = z.infer<typeof userMessageStatusSchema>;

const common = {
  id: threadMessageIdSchema,
  agent_id: agentIdSchema,
  seq: z.number().int().min(1),
  rev: z.number().int().min(1),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
};
const attachments = z.array(attachmentSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE).optional();
/** Text may be empty only on a message that carries files (a photo without a caption). */
const textOrFiles = (message: { text: string; attachments?: unknown[] | undefined }) =>
  message.text.length > 0 || (message.attachments?.length ?? 0) > 0;
const textOrFilesError = { message: 'text or attachments required', path: ['text'] };

export const threadMessageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('user_text'),
      text: z.string().max(MAX_USER_MESSAGE_CHARS),
      status: userMessageStatusSchema,
      client_id: z.uuid(),
      voice: z.object({ duration_s: z.number().int().min(1).max(120) }).optional(),
      attachments,
      turn_id: z.string().max(128).optional(),
      error_code: z.string().max(64).optional(),
    })
    .refine(textOrFiles, textOrFilesError),
  z
    .object({
      ...common,
      kind: z.literal('agent_text'),
      client_id: z.string().max(128).optional(),
      text: z.string().max(MAX_STORED_AGENT_MESSAGE_CHARS),
      attachments,
      turn_id: z.string().max(128).optional(),
      cut: z.boolean(),
      partial: z.boolean(),
    })
    .refine(textOrFiles, textOrFilesError),
  z.object({
    ...common,
    kind: z.literal('call'),
    call_id: z.string().max(64),
    duration_s: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'failed', 'missed']),
    end_reason: z.string().max(64).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal('ring'),
    invite_id: z.string().regex(/^inv_[a-z2-7]{26}$/),
    reason: z.string().max(140),
    outcome: z.enum(['answered', 'declined', 'missed', 'cancelled']),
    note: z.string().max(60).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal('approval'),
    approval_id: z.string().max(128),
    title: z.string().max(140),
    description: z.string().max(500).optional(),
    status: z.enum(['pending', 'allowed', 'denied', 'expired']),
    expires_at: z.iso.datetime(),
  }),
  z.object({ ...common, kind: z.literal('notice'), code: z.literal('new_session') }),
]);
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

export const threadSocketFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message.upserted'), message: threadMessageSchema }),
  z.object({
    type: z.literal('turn.progress'),
    agent_id: agentIdSchema,
    message_id: threadMessageIdSchema,
    text: z.string().max(MAX_STORED_AGENT_MESSAGE_CHARS),
    activity: z.string().max(MAX_ACTIVITY_LABEL_CHARS).optional(),
  }),
  z.object({ type: z.literal('thread.cleared'), agent_id: agentIdSchema }),
]);
export type ThreadSocketFrame = z.infer<typeof threadSocketFrameSchema>;

export const phoneSocketFrameSchema = z
  .object({ type: z.literal('focus'), agent_id: agentIdSchema.nullable() })
  .strict();
export type PhoneSocketFrame = z.infer<typeof phoneSocketFrameSchema>;

export const threadSummarySchema = z.object({
  agent_id: agentIdSchema,
  last_message: threadMessageSchema.nullable(),
  unread: z.number().int().nonnegative(),
  last_message_at: z.iso.datetime().nullable(),
  read_seq: z.number().int().nonnegative(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export const threadListResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
  /** True when this server stores files in chats (`FILES_ENABLED`); the app shows the paperclip. */
  files: z.boolean().optional(),
});
export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const sendMessageRequestSchema = z
  .object({
    client_id: z.uuid(),
    text: z
      .string()
      .trim()
      .max(MAX_USER_MESSAGE_CHARS)
      .refine(
        // eslint-disable-next-line no-control-regex -- reject control characters except newline and tab
        (text) => !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text),
      ),
    /** Files uploaded first with `POST /v1/agents/:agentId/files`, in display order. */
    attachment_ids: z.array(fileIdSchema).min(1).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .strict()
  .refine((request) => request.text.length > 0 || request.attachment_ids !== undefined, {
    message: 'text or attachment_ids required',
    path: ['text'],
  })
  .refine(
    (request) =>
      new Set(request.attachment_ids ?? []).size === (request.attachment_ids?.length ?? 0),
    { message: 'attachment_ids must be distinct', path: ['attachment_ids'] },
  );
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export const voiceNoteQuerySchema = z
  .object({
    client_id: z.uuid(),
    duration_ms: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe()),
  })
  .strict();
export const approvalDecisionRequestSchema = z
  .object({ decision: z.enum(['approve', 'deny']) })
  .strict();
export const messagePageResponseSchema = z.object({
  messages: z.array(threadMessageSchema),
  has_more: z.boolean(),
});
export type MessagePageResponse = z.infer<typeof messagePageResponseSchema>;
export const readMarkerRequestSchema = z.object({ seq: z.number().int().nonnegative() }).strict();
export type ReadMarkerRequest = z.infer<typeof readMarkerRequestSchema>;
