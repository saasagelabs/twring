import { z } from 'zod';

export const waitlistRequestSchema = z.object({
  email: z.string().trim().max(254).email(),
  /** Where the email was left: the landing page, or the beta download page (twring.com/beta). */
  source: z.enum(['landing', 'beta', 'app']).optional(),
});
export type WaitlistRequest = z.infer<typeof waitlistRequestSchema>;

export const WAITLIST_MAX_ENTRIES = 50_000;
