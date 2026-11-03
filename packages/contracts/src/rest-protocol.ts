import { z } from 'zod';

import { turnAttachmentsSchema } from './files';

/**
 * `cord-rest/1`: the REST + SSE agent protocol (ADAPTERS §4, AGENT_ADAPTER_SPEC §21). Twring sends
 * one `POST {url}` per committed turn; the agent answers with a `text/event-stream` of
 * `AgentEvent`s, or, if it can't stream, one final JSON body. Additive fields are ignored.
 *
 * Request headers: `Authorization: Bearer <token>`, `Content-Type: application/json`,
 * `Accept: text/event-stream, application/json`, `Idempotency-Key: <turn_id>`.
 *
 * SSE: `event:` is the AgentEvent `type`; `data:` is the event body as JSON. `turn_id`, `event_id`
 * and `seq` may be left out of `data`: Twring fills `turn_id` from the request and `event_id` from
 * the SSE `id:` field of that block, or else a per-response sequence.
 */
export const REST_PROTOCOL = 'cord-rest/1';
/** Largest single SSE event (its `data`) Twring accepts; bigger is a protocol violation. */
export const MAX_SSE_EVENT_BYTES = 65_536;
/** Largest whole response body (SSE stream or final JSON) Twring reads for one turn. */
export const MAX_REST_RESPONSE_BYTES = 1_048_576;

const id = z.string().min(1).max(128);

export const restTurnRequestSchema = z.object({
  protocol: z.literal(REST_PROTOCOL),
  session_id: id,
  call_id: id,
  turn_id: id,
  text: z.string().max(8192),
  surface: z.enum(['call', 'text']).optional(),
  /** Files the owner attached, as signed links; agents that predate it ignore it (AGENT_ADAPTER_SPEC §20–22). */
  attachments: turnAttachmentsSchema.optional(),
  started_at: z.string().max(64),
  committed_at: z.string().max(64),
});
export type RestTurnRequest = z.infer<typeof restTurnRequestSchema>;

/** A non-streaming agent's whole reply (`Content-Type: application/json`). */
export const restFinalResponseSchema = z.object({
  text: z.string(),
  status: z.enum(['completed', 'failed']).optional(),
});
export type RestFinalResponse = z.infer<typeof restFinalResponseSchema>;
