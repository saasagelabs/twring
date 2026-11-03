import { z } from 'zod';
import { agentIdSchema, agentKeytermSchema, MAX_AGENT_KEYTERMS } from './agents';

export { callableOnComputer, mcpClientKindSchema, type McpClientKind } from './mcp-client';

export const mcpClientIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const ringMeInputSchema = z.object({ reason: z.string().trim().min(1).max(140) }).strict();
/** Words this app's calls should hear right, added after the owner's own (up to the list's limit). */
export const addWordsInputSchema = z
  .object({ words: z.array(agentKeytermSchema).min(1).max(MAX_AGENT_KEYTERMS) })
  .strict();
export const messageMeInputSchema = z
  .object({
    text: z.string().max(4000).optional(),
    files: z
      .array(
        z
          .object({ url: z.url({ protocol: /^https$/ }), name: z.string().max(120).optional() })
          .strict(),
      )
      .max(5)
      .optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.text?.trim() || value.files?.length),
    'A message or file is required.',
  );
export const checkRepliesInputSchema = z.object({ since: z.iso.datetime().optional() }).strict();
export const twringStatusInputSchema = z.object({}).strict();

/** One AI app in `GET /v1/me/connected-apps`. A blocked app has no contact (`agent_id`). */
export const connectedAppSchema = z.object({
  agent_id: agentIdSchema.optional(),
  client_id: mcpClientIdSchema,
  name: z.string(),
  blocked: z.boolean(),
  last_used_at: z.iso.datetime().optional(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;
export const connectedAppListResponseSchema = z.object({ apps: z.array(connectedAppSchema) });
