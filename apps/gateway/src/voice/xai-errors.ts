import { connectError } from './deepgram-stt';
import type { VoiceError } from './types';

/** Error wording that means the key itself was refused. "quota" alone is a rate limit, not this. */
const KEY_WORDING = /unauthor|api key/i;
/** "Forbidden" alone may be a content policy refusal; it counts only alongside the word key. */
const FORBIDDEN_KEY_WORDING = /forbidden[\s\S]*\bkey\b|\bkey\b[\s\S]*forbidden/i;
/** "API key rate limit" is a rate limit, not a refused key ("generate" is not "rate"). */
const NOT_KEY_WORDING = /\brate\b|rate[\s_-]?limit/i;
const BILLING_WORDING = /payment required|insufficient (credit|balance|fund)/i;

/** True when an xAI `error` message's text means the key was refused (bad, revoked or unpaid). */
export function isXaiKeyProblem(message: string): boolean {
  return (
    ((KEY_WORDING.test(message) || FORBIDDEN_KEY_WORDING.test(message)) &&
      !NOT_KEY_WORDING.test(message)) ||
    BILLING_WORDING.test(message)
  );
}

/** Handshake failures: 401/402/403 refuse the key, 400/404 are a bad request, else retryable. */
export function xaiConnectError(error: unknown): VoiceError {
  const message = error instanceof Error ? error.message : '';
  if (/\b40[04]\b/.test(message)) return { code: 'provider_error', recoverable: false };
  return connectError(error);
}
