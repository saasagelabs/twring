import { z } from 'zod';

const responseSchema = z.object({
  results: z.object({
    channels: z.array(z.object({ alternatives: z.array(z.object({ transcript: z.string() })) })),
  }),
});

export class PrerecordedTranscriptionError extends Error {
  constructor(
    readonly code: 'timeout' | 'provider_failure' | 'empty',
    /** The provider's HTTP status, when it answered with one. */
    readonly status?: number,
  ) {
    super(code);
    this.name = 'PrerecordedTranscriptionError';
  }
}

import { isKeyRefusal } from './key-refusal';

export { isKeyRefusal };

/** A brief provider failure (5xx, a dropped connection) is retried once after this long. */
export const TRANSCRIBE_RETRY_MS = 500;

export function createPrerecordedTranscriber(
  apiKey: string,
  doFetch: typeof fetch = fetch,
  retryMs = TRANSCRIBE_RETRY_MS,
  /** The provider refused the word list (a 4xx): the note went again without it. */
  onKeytermsRefused?: (status: number) => void,
) {
  const attempt = async (
    audio: Uint8Array,
    contentType: string,
    signal: AbortSignal | undefined,
    keyterms: readonly string[],
    key: string,
  ): Promise<string> => {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30_000);
    try {
      const query = new URLSearchParams({ model: 'nova-3', smart_format: 'true', language: 'en' });
      for (const term of keyterms) query.append('keyterm', term);
      const response = await doFetch(`https://api.deepgram.com/v1/listen?${query.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Token ${key}`, 'Content-Type': contentType },
        body: Buffer.from(audio),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new PrerecordedTranscriptionError('provider_failure', response.status);
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) throw new PrerecordedTranscriptionError('provider_failure');
      const transcript = parsed.data.results.channels[0]?.alternatives[0]?.transcript.trim() ?? '';
      if (!transcript) throw new PrerecordedTranscriptionError('empty');
      return transcript;
    } catch (error) {
      if (error instanceof PrerecordedTranscriptionError) throw error;
      throw new PrerecordedTranscriptionError(timedOut ? 'timeout' : 'provider_failure');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  return withTranscribeRetry(attempt, apiKey, retryMs, onKeytermsRefused);
}

/** One transcription attempt: no retry inside. */
export type TranscribeAttempt = (
  audio: Uint8Array,
  contentType: string,
  signal: AbortSignal | undefined,
  keyterms: readonly string[],
  key: string,
) => Promise<string>;

/**
 * The voice note retry policy, whichever provider hears the note: a refused key is final; a
 * refused word list goes again at once without it; a provider failure goes again once.
 */
export function withTranscribeRetry(
  attempt: TranscribeAttempt,
  apiKey: string,
  retryMs = TRANSCRIBE_RETRY_MS,
  onKeytermsRefused?: (status: number) => void,
) {
  return async function transcribeVoiceNote(
    audio: Uint8Array,
    contentType: string,
    signal?: AbortSignal,
    /** Words to listen for (the agent's list and names), as on its calls. */
    keyterms: readonly string[] = [],
    /** This note's key (a person's own); the server key when absent. */
    key: string = apiKey,
  ): Promise<string> {
    try {
      return await attempt(audio, contentType, signal, keyterms, key);
    } catch (error) {
      // A refused key (401/403) is final: going again would only be refused again.
      if (error instanceof PrerecordedTranscriptionError && isKeyRefusal(error.status)) throw error;
      // A word list the provider refuses must never cost the note: go again at once without it.
      if (
        keyterms.length > 0 &&
        error instanceof PrerecordedTranscriptionError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        !signal?.aborted
      ) {
        onKeytermsRefused?.(error.status);
        return transcribeVoiceNote(audio, contentType, signal, [], key);
      }
      // Only a provider failure is retried: an empty note stays empty, and a 30 s timeout has
      // already used the owner's patience.
      const retryable =
        error instanceof PrerecordedTranscriptionError && error.code === 'provider_failure';
      if (!retryable || signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      if (signal?.aborted) throw error;
      return attempt(audio, contentType, signal, keyterms, key);
    }
  };
}
