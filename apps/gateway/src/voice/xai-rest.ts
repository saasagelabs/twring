import { z } from 'zod';

import {
  PrerecordedTranscriptionError,
  TRANSCRIBE_RETRY_MS,
  withTranscribeRetry,
} from './deepgram-prerecorded';
import { xaiStatus } from './xai-errors';
import { cleanKeyterms } from './xai-stt';
import type { XaiVoice } from './xai-tts';

/**
 * xAI's one-shot REST endpoints on the fixed host `https://api.x.ai`, key in a header only:
 * - `POST /v1/stt` (multipart: `language`, repeated `keyterm`, `file` last) answers
 *   `{ text, language, duration }`; it accepts the app's AAC `.m4a` voice notes.
 * - `POST /v1/tts` (JSON: `text`, `voice_id`, `language`, `output_format.codec`) answers raw
 *   audio bytes, per https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
 *   (checked 2026-10-28; MP3 at 24 kHz, 128 kbps by default).
 */
const BASE_URL = 'https://api.x.ai';
const TRANSCRIBE_TIMEOUT_MS = 30_000;
const SYNTHESIZE_TIMEOUT_MS = 20_000;

const transcriptSchema = z.object({ text: z.string() });

export interface XaiRestOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Why one-shot synthesis failed; `status` is xAI's HTTP status when it answered with one. */
export class XaiSynthesisError extends Error {
  constructor(
    readonly code: 'timeout' | 'provider_failure' | 'empty',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'XaiSynthesisError';
  }
}

/** Runs one request with a timeout and the caller's signal; reports whether it timed out. */
async function withTimeout<T>(
  options: XaiRestOptions,
  defaultMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  onFailure: (timedOut: boolean, error: unknown) => Error,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? defaultMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    // Never rethrow a foreign error: its message could carry request details.
    throw onFailure(timedOut, error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Transcribes one audio file. A refused key (401/402/403, or xAI's wrong-key 400 reported as
 * 401) keeps its status, so the caller's key refusal rule applies; nothing is retried here.
 */
export function transcribeWithXai(
  apiKey: string,
  audio: Uint8Array,
  contentType: string,
  keyterms: readonly string[],
  options: XaiRestOptions = {},
): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  return withTimeout(
    options,
    TRANSCRIBE_TIMEOUT_MS,
    async (signal) => {
      const form = new FormData();
      form.append('language', 'en');
      for (const term of cleanKeyterms(keyterms)) form.append('keyterm', term);
      // xAI reads fields in order and wants the file last.
      form.append(
        'file',
        new Blob([Buffer.from(audio)], { type: contentType }),
        fileName(contentType),
      );
      const response = await doFetch(`${BASE_URL}/v1/stt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        redirect: 'error',
        signal,
      });
      if (!response.ok)
        throw new PrerecordedTranscriptionError('provider_failure', await xaiStatus(response));
      const parsed = transcriptSchema.safeParse(await response.json());
      if (!parsed.success) throw new PrerecordedTranscriptionError('provider_failure');
      const text = parsed.data.text.trim();
      if (!text) throw new PrerecordedTranscriptionError('empty');
      return text;
    },
    (timedOut, error) =>
      error instanceof PrerecordedTranscriptionError
        ? error
        : new PrerecordedTranscriptionError(timedOut ? 'timeout' : 'provider_failure'),
  );
}

/** A file name whose extension matches the audio, in case xAI reads the type from the name. */
export function fileName(contentType: string): string {
  switch (contentType.split(';')[0]!.trim().toLowerCase()) {
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'audio.m4a';
    case 'audio/mpeg':
      return 'audio.mp3';
    default:
      return 'audio';
  }
}

/**
 * Voice note transcription on the person's own xAI key, with the same retry policy as Deepgram
 * notes (a refused key is final; a refused word list goes again without it; a provider failure
 * goes again once after `retryMs`).
 */
export function createXaiTranscriber(
  doFetch: typeof fetch = fetch,
  retryMs = TRANSCRIBE_RETRY_MS,
  onKeytermsRefused?: (status: number) => void,
) {
  const run = withTranscribeRetry(
    (audio, contentType, signal, keyterms, key) =>
      transcribeWithXai(key, audio, contentType, keyterms, {
        fetch: doFetch,
        ...(signal && { signal }),
      }),
    '',
    retryMs,
    onKeytermsRefused,
  );
  return (
    apiKey: string,
    audio: Uint8Array,
    contentType: string,
    keyterms: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<string> => run(audio, contentType, signal, keyterms, apiKey);
}

/** Speaks `text` in one request and returns the MP3 bytes. */
export function synthesizeWithXai(
  apiKey: string,
  voice: XaiVoice,
  text: string,
  options: XaiRestOptions = {},
): Promise<Buffer> {
  const doFetch = options.fetch ?? fetch;
  return withTimeout(
    options,
    SYNTHESIZE_TIMEOUT_MS,
    async (signal) => {
      const response = await doFetch(`${BASE_URL}/v1/tts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice_id: voice,
          language: 'en',
          output_format: { codec: 'mp3' },
        }),
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new XaiSynthesisError('provider_failure', await xaiStatus(response));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new XaiSynthesisError('empty');
      return bytes;
    },
    (timedOut, error) =>
      error instanceof XaiSynthesisError
        ? error
        : new XaiSynthesisError(timedOut ? 'timeout' : 'provider_failure'),
  );
}
