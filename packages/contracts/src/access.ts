import { z } from 'zod';

export const accessResponseSchema = z.object({
  member: z.boolean(),
  email: z.string().optional(),
});

export const inviteRedeemRequestSchema = z.object({ code: z.string().max(32) }).strict();
