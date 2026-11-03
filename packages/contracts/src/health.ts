import { z } from 'zod';

export const twringEnvironmentSchema = z.enum(['development', 'staging', 'production']);
export type TwringEnvironment = z.infer<typeof twringEnvironmentSchema>;

/** `GET /health/live`: the process is up. Never includes account or secret details. */
export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
});
export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

export const readinessCheckStatusSchema = z.enum(['ok', 'failing']);
export type ReadinessCheckStatus = z.infer<typeof readinessCheckStatusSchema>;

/** `GET /health/ready`: dependencies are ready enough to accept new work. */
export const healthReadyResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  environment: twringEnvironmentSchema,
  release: z.string(),
  checks: z.record(z.string(), readinessCheckStatusSchema),
});
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;
