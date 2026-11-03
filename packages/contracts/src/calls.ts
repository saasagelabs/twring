import { z } from 'zod';

/** Opaque server-minted identifiers. Clients never construct them. */
export const callIdSchema = z.string().regex(/^call_[a-z0-9]{20}$/);
export type CallId = z.infer<typeof callIdSchema>;

export const sessionIdSchema = z.string().regex(/^sess_[a-z0-9]{20}$/);
export type SessionId = z.infer<typeof sessionIdSchema>;

/**
 * `POST /v1/calls`. With `agent_id`, the call talks to that saved agent in its voice. Without it,
 * the gateway's configured development audio mode is used.
 */
export const createCallRequestSchema = z
  .object({
    agent_id: z
      .string()
      .regex(/^agt_[a-z0-9]{20}$/)
      .optional(),
  })
  .strict();
export type CreateCallRequest = z.infer<typeof createCallRequestSchema>;

export const createCallResponseSchema = z.object({
  call_id: callIdSchema,
  session_id: sessionIdSchema,
  livekit: z.object({
    url: z.url({ protocol: /^wss?$/ }),
    /** Short-lived, room-scoped caller token. Never logged. */
    token: z.string().min(1),
    room: z.string().min(1),
  }),
  expires_at: z.iso.datetime(),
});
export type CreateCallResponse = z.infer<typeof createCallResponseSchema>;

/** Durable call states (BACKEND_SPEC §9). Transient voice states are not persisted. */
export const callRecordStatusSchema = z.enum([
  'created',
  'connecting',
  'active',
  'ending',
  'ended',
  'failed',
]);
export type CallRecordStatus = z.infer<typeof callRecordStatusSchema>;

/** `GET /v1/calls/:callId` and `POST /v1/calls/:callId/end`. Safe metadata only. */
export const callSummarySchema = z.object({
  call_id: callIdSchema,
  status: callRecordStatusSchema,
  created_at: z.iso.datetime(),
  ended_at: z.iso.datetime().optional(),
});
export type CallSummary = z.infer<typeof callSummarySchema>;

export const callFeedbackIssueSchema = z.enum(['cut_off', 'misheard', 'slow']);
export const callFeedbackRequestSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    issues: z.array(callFeedbackIssueSchema).max(3).default([]),
    note: z.string().trim().max(280).optional(),
  })
  .refine(({ issues }) => new Set(issues).size === issues.length);
export type CallFeedbackRequest = z.input<typeof callFeedbackRequestSchema>;
export const callFeedbackResponseSchema = z.object({ ok: z.literal(true) });

/** Longest note a person can send from Settings (Send feedback). */
export const MAX_APP_FEEDBACK_CHARS = 1000;
/** `POST /v1/me/feedback`: a note from Settings, at any time (not tied to a call). */
export const appFeedbackRequestSchema = z.object({
  note: z.string().trim().min(1).max(MAX_APP_FEEDBACK_CHARS),
});
export type AppFeedbackRequest = z.infer<typeof appFeedbackRequestSchema>;
export const appFeedbackResponseSchema = z.object({ ok: z.literal(true) });
