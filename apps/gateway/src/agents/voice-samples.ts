import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ErrorCode, ErrorResponse } from '@twring/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SAMPLE_RATE } from '../audio/pcm';
import { devUserResolver, type UserResolver } from '../auth';
import { FixedWindowLimiter } from '../rate-limit';
import { toSafeError } from '../redact';
import { StoreCorruptError } from '../store/collection';
import {
  SpeechKeyRefusedError,
  speechKeyRefusal,
  type SpeechResolver,
} from '../voice/speech-resolver';
import { VoiceProviderError, type TtsProvider, type VoiceErrorCode } from '../voice/types';

import type { TtsRouter } from './tts-router';
import { VOICES, cartesiaVoice, isAllowedVoice, xaiVoice } from './voices';

/** Sample synthesis must finish within this, or the request fails (and nothing is cached). */
export const SAMPLE_SYNTHESIS_TIMEOUT_MS = 15_000;
/** A sample is a few seconds; anything past this is a runaway stream and is refused. */
export const MAX_SAMPLE_BYTES = SAMPLE_RATE * 2 * 12;
/** Sample requests per client per minute (cached answers are cheap; synthesis is not). */
export const SAMPLE_RATE_PER_MINUTE = 20;

export function sampleText(label: string): string {
  const name = label.split('·')[0]!.trim();
  return `Hi, I'm ${name}. This is how I'll sound on your calls.`;
}

/** Wraps 16-bit mono PCM in a WAV header so any phone player can play it. */
export function wav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** A WAV as `wav()` writes it: header sizes that match the file, and at least some audio. */
export function isCompleteWav(file: Buffer): boolean {
  return (
    file.byteLength > 44 &&
    file.toString('ascii', 0, 4) === 'RIFF' &&
    file.toString('ascii', 8, 12) === 'WAVE' &&
    file.toString('ascii', 36, 40) === 'data' &&
    file.readUInt32LE(4) === file.byteLength - 8 &&
    file.readUInt32LE(40) === file.byteLength - 44
  );
}

/** Why a sample could not be made; `code` is the provider's normalized code when it gave one. */
export class SampleSynthesisError extends Error {
  constructor(
    readonly code: VoiceErrorCode | 'timeout' | 'too_long' | 'no_audio',
    message: string,
  ) {
    super(message);
    this.name = 'SampleSynthesisError';
  }
}

/** One Flux TTS turn, collected into PCM. Rejects on provider error, timeout, or oversize. */
export async function synthesizeSample(
  tts: TtsProvider,
  text: string,
  timeoutMs = SAMPLE_SYNTHESIS_TIMEOUT_MS,
): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(timeoutMs);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const done = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  // Observed below; this only stops a failure during open() being reported as unhandled.
  done.catch(() => undefined);
  const onAbort = () =>
    settle.reject(new SampleSynthesisError('timeout', 'sample synthesis timed out'));
  signal.addEventListener('abort', onAbort, { once: true });
  const session = await tts
    .open((event) => {
      switch (event.type) {
        case 'audio':
          bytes += event.bytes.byteLength;
          if (bytes > MAX_SAMPLE_BYTES)
            settle.reject(new SampleSynthesisError('too_long', 'sample too long'));
          else chunks.push(event.bytes);
          return;
        case 'done':
          settle.resolve();
          return;
        case 'error':
        case 'generation_error':
          settle.reject(
            new SampleSynthesisError(
              event.error.code,
              `sample synthesis failed: ${event.error.code}`,
            ),
          );
          return;
      }
    }, signal)
    .catch((error: unknown) => {
      if (error instanceof VoiceProviderError)
        throw new SampleSynthesisError(
          error.error.code,
          `sample synthesis failed: ${error.error.code}`,
        );
      throw error;
    });
  try {
    session.speak('sample', text);
    session.flush('sample');
    await done;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await session.close();
  }
  if (bytes === 0) throw new SampleSynthesisError('no_audio', 'sample synthesis produced no audio');
  return Buffer.concat(chunks);
}

/**
 * Voice samples cached on disk: each allowed voice is synthesized once, then served from
 * `<dir>/<voice id>.wav`. Concurrent first requests share one synthesis.
 */
export class VoiceSampleCache {
  private readonly inFlight = new Map<string, Promise<Buffer>>();
  /** Samples that could not be written to disk. */
  private readonly memory = new Map<string, Buffer>();

  constructor(
    private readonly dir: string,
    private readonly synthesize: (voiceId: string, text: string) => Promise<Uint8Array>,
  ) {}

  /** Only for ids on the allow-list; the caller validates first, this re-checks. */
  get(voiceId: string): Promise<Buffer> {
    if (!isAllowedVoice(voiceId)) return Promise.reject(new Error('voice not allowed'));
    const pending = this.inFlight.get(voiceId);
    if (pending !== undefined) return pending;
    const work = this.load(voiceId).finally(() => this.inFlight.delete(voiceId));
    this.inFlight.set(voiceId, work);
    return work;
  }

  private async load(voiceId: string): Promise<Buffer> {
    const kept = this.memory.get(voiceId);
    if (kept !== undefined) return kept;
    const file = join(this.dir, `${voiceId}.wav`);
    try {
      const cached = await readFile(file);
      // A power loss after rename can still leave an empty or short file: never serve that.
      if (isCompleteWav(cached)) return cached;
    } catch {
      // Not cached yet.
    }
    const label = VOICES.find((voice) => voice.id === voiceId)!.label;
    const audio = wav(await this.synthesize(voiceId, sampleText(label)));
    // Write then rename, so a crash never leaves a half-written sample to be served forever.
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(temporary, audio);
      await rename(temporary, file);
    } catch {
      // The data directory is missing or read-only: still answer, and keep the sample in memory
      // (a few hundred KB per allowed voice at most) so it is not synthesized on every request.
      await rm(temporary, { force: true }).catch(() => undefined);
      this.memory.set(voiceId, audio);
    }
    return audio;
  }
}

/** A sample cache's synthesis on the server's keys: exactly that voice, or a rejection. */
export function sampleSynthesizer(
  router: Pick<TtsRouter, 'forSample'>,
): (voiceId: string, text: string) => Promise<Uint8Array> {
  return (voiceId, text) => {
    const provider = router.forSample(voiceId);
    if (provider === undefined) return Promise.reject(new Error('voice not configured'));
    return synthesizeSample(provider, text);
  };
}

/**
 * BYOK samples: a voice spoken with the person's own key, or undefined when they have none for
 * it. A provider refusing their key becomes `SpeechKeyRefusedError`.
 */
export function createOwnKeySample(
  resolver: SpeechResolver,
  router: Pick<TtsRouter, 'forSample'>,
): (userId: string, voiceId: string, text: string) => Promise<Uint8Array | undefined> {
  return async (userId, voiceId, text) => {
    const speech = await resolver.resolve(userId);
    const provider =
      xaiVoice(voiceId) !== undefined
        ? 'xai'
        : cartesiaVoice(voiceId) !== undefined
          ? 'cartesia'
          : 'deepgram';
    if (speech[provider]?.source !== 'own') return undefined;
    const tts = router.forSample(voiceId, speech);
    if (tts === undefined) return undefined;
    try {
      return await synthesizeSample(tts, text);
    } catch (error) {
      if (error instanceof SampleSynthesisError && error.code === 'auth_failed')
        throw new SpeechKeyRefusedError(provider);
      throw error;
    }
  };
}

export interface VoiceSampleRoutesOptions {
  samples: VoiceSampleCache;
  ratePerMinute?: number;
  /** Kill switch: false answers every preview with 503 `voice_samples_disabled`. */
  enabled?: boolean;
  /**
   * The voices this server offers (GET /v1/voices). Any other id is 404, like an unknown voice:
   * a Cartesia voice without CARTESIA_API_KEY can never be synthesized, so "try again" (503) would
   * mislead. Defaults to every allowed voice.
   */
  offered?: (voiceId: string) => boolean;
  /**
   * BYOK: a voice this server cannot make, spoken with the person's own key. Undefined when they
   * have no key for it. Never cached: the audio is theirs, made on their account.
   */
  ownKeySample?: (userId: string, voiceId: string, text: string) => Promise<Uint8Array | undefined>;
  userFor?: UserResolver;
  /** Operator alert for a speech key store that cannot be read. */
  onError?: (error: Error, context: { requestId: string }) => void;
}

function sendError(reply: FastifyReply, status: number, code: ErrorCode, message: string) {
  const body: ErrorResponse = { error: { code, message, request_id: reply.request.id } };
  return reply.code(status).send(body);
}

/** GET /v1/voices/:id/sample: a short WAV of the voice, for the voice picker's preview. */
export function registerVoiceSampleRoutes(
  app: FastifyInstance,
  options: VoiceSampleRoutesOptions,
): void {
  const limiter = new FixedWindowLimiter(options.ratePerMinute ?? SAMPLE_RATE_PER_MINUTE, 60_000);
  app.get<{ Params: { id: string } }>('/v1/voices/:id/sample', async (request, reply) => {
    const { id } = request.params;
    if (options.enabled === false) {
      return sendError(
        reply,
        503,
        'voice_samples_disabled',
        'Voice previews are turned off right now. You can still choose a voice.',
      );
    }
    const offered = options.offered?.(id) !== false;
    if (!isAllowedVoice(id) || (!offered && options.ownKeySample === undefined)) {
      return sendError(reply, 404, 'not_found', 'No such voice.');
    }
    if (!limiter.tryAcquire(request.ip)) {
      return sendError(
        reply,
        429,
        'rate_limited',
        'Too many previews. Wait a minute and try again.',
      );
    }
    if (!offered) return ownKeySample(request, reply, id);
    let audio: Buffer;
    try {
      audio = await options.samples.get(id);
    } catch (error) {
      request.log.warn(
        { event: 'voice_sample_failed', err: toSafeError(error) },
        'no voice sample',
      );
      return sendError(
        reply,
        503,
        'service_unavailable',
        "This voice sample isn't available right now. Try again in a moment.",
      );
    }
    return reply
      .header('content-type', 'audio/wav')
      .header('cache-control', 'public, max-age=86400')
      .send(audio);
  });

  async function ownKeySample(
    request: FastifyRequest,
    reply: FastifyReply,
    voiceId: string,
  ): Promise<FastifyReply> {
    const userId = (options.userFor ?? devUserResolver)(request);
    let pcm: Uint8Array | undefined;
    try {
      const label = VOICES.find((voice) => voice.id === voiceId)!.label;
      pcm = await options.ownKeySample!(userId, voiceId, sampleText(label));
    } catch (error) {
      if (error instanceof StoreCorruptError) {
        // Fail closed, as calls do: nobody can tell whose key is their own. No path, no key.
        const safeError = new Error('speech key store unreadable');
        safeError.name = 'SpeechKeysUnavailable';
        request.log.error({ event: 'speech_keys_unavailable' }, 'speech key store unreadable');
        options.onError?.(safeError, { requestId: request.id });
        return sendError(
          reply,
          503,
          'service_unavailable',
          'Voice is briefly unavailable. Try again in a moment.',
        );
      }
      const refusal = speechKeyRefusal(error);
      if (refusal) return sendError(reply, refusal.status, refusal.code, refusal.message);
      request.log.warn(
        { event: 'voice_sample_failed', err: toSafeError(error) },
        'no voice sample',
      );
      return sendError(
        reply,
        503,
        'service_unavailable',
        "This voice sample isn't available right now. Try again in a moment.",
      );
    }
    if (pcm === undefined) return sendError(reply, 404, 'not_found', 'No such voice.');
    return reply
      .header('content-type', 'audio/wav')
      .header('cache-control', 'private, no-store')
      .send(wav(pcm));
  }
}
