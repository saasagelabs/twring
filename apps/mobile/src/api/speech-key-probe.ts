import { errorResponseSchema } from '@twring/contracts';

import { ApiError, SERVER_MESSAGE_MAX } from './client';

export { SERVER_MESSAGE_MAX };

type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A native audio player reports only that playback failed. Ask the same URL once more as plain
 * HTTP: when the server answered with a JSON error body, return it as an `ApiError` (carrying the
 * server's sentence for speech key codes), otherwise undefined and the caller keeps its generic copy.
 */
export async function probeSpeechKeyError(
  doFetch: ProbeFetch,
  uri: string,
  headers: Record<string, string>,
): Promise<ApiError | undefined> {
  const result = await probeSpeech(doFetch, uri, headers);
  return result === 'ok' ? undefined : result;
}

/**
 * Like `probeSpeechKeyError`, but tells a confirmed healthy answer ('ok') apart from an
 * inconclusive one (undefined: a network failure, or an error body that is not readable).
 */
export async function probeSpeech(
  doFetch: ProbeFetch,
  uri: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<'ok' | ApiError | undefined> {
  try {
    const response = await doFetch(uri, { method: 'GET', headers, ...(signal && { signal }) });
    if (response.ok) {
      // Healthy: stop reading so the server does not finish a second synthesis for nothing.
      void response.body?.cancel().catch(() => undefined);
      return 'ok';
    }
    const parsed = errorResponseSchema.safeParse(await response.json());
    if (!parsed.success) return undefined;
    const { code, message, request_id } = parsed.data.error;
    return new ApiError(
      'http',
      code,
      request_id,
      undefined,
      response.status,
      undefined,
      code.startsWith('speech_key_') ? message.slice(0, SERVER_MESSAGE_MAX) : undefined,
    );
  } catch {
    return undefined;
  }
}
