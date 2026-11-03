import { connectError } from './deepgram-stt';
import { HandshakeRefusedError } from './socket';
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

/**
 * xAI answers a wrong, revoked or unknown key with 400 "Incorrect API key provided", where the
 * other providers say 401. True for that answer only, so it can join the shared refusal rule.
 */
function isXaiKeyRefusal(status: number, body: string): boolean {
  return status === 400 && isXaiKeyProblem(body);
}

/** An HTTP answer's status, with xAI's wrong-key 400 reported as 401. Reads the body only then. */
export async function xaiStatus(response: Response): Promise<number> {
  if (response.status !== 400) return response.status;
  const body = await response.text().catch(() => '');
  return isXaiKeyRefusal(400, body.slice(0, 1024)) ? 401 : 400;
}

/**
 * Handshake failures: 401/402/403 (and xAI's wrong-key 400) refuse the key, other 400s and 404
 * are a bad request, else retryable.
 */
export function xaiConnectError(error: unknown): VoiceError {
  if (error instanceof HandshakeRefusedError && isXaiKeyRefusal(error.status, error.body))
    return { code: 'auth_failed', recoverable: false };
  const message = error instanceof Error ? error.message : '';
  if (/\b40[04]\b/.test(message)) return { code: 'provider_error', recoverable: false };
  return connectError(error);
}
