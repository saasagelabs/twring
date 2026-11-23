import { isKeyRefusal } from './key-refusal';
import type { VoiceError } from './types';

/**
 * The one-shot retry of a failed answer (#91), shared by the pipeline, which retries, and the
 * failover voice, which takes over an answer only once the pipeline will not retry it.
 */
const RETRY_SUFFIX = '_retry';

/** A generation error worth one retry: not a missing voice, a refused key or used-up quota. */
export function retryable(error: VoiceError): boolean {
  const status = error.providerStatus;
  if (error.code === 'auth_failed' || status === 404 || status === 429) return false;
  return !isKeyRefusal(status);
}

/** The voice id a retried answer is spoken under (the failed one may be closed for good). */
export function retryTtsId(generationId: string): string {
  return `${generationId}${RETRY_SUFFIX}`;
}

/** The answer a retry id was retried from, or undefined for a first attempt. */
export function retriedFrom(generationId: string): string | undefined {
  return generationId.endsWith(RETRY_SUFFIX)
    ? generationId.slice(0, -RETRY_SUFFIX.length)
    : undefined;
}

/** Whether the pipeline will speak this failed answer again itself. */
export function pipelineRetries(generationId: string, error: VoiceError): boolean {
  return retryable(error) && retriedFrom(generationId) === undefined;
}
