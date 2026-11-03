import { z } from 'zod';

import {
  VoiceProviderError,
  closeError,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type VoiceError,
} from './types';
import { isKeyRefusal } from './key-refusal';
import { waitForOpen, wsSocketFactory, type ProviderSocket, type SocketFactory } from './socket';

/** Flux needs 16 kHz linear16; ~80 ms chunks are its recommended latency/efficiency balance. */
export const STT_SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = (STT_SAMPLE_RATE * 80) / 1000;

const turnInfoSchema = z.object({
  type: z.literal('TurnInfo'),
  event: z.enum(['StartOfTurn', 'Update', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn']),
  turn_index: z.number().int().nonnegative(),
  transcript: z.string().max(20_000),
});
const errorSchema = z.object({ type: z.literal('Error') });

export interface DeepgramSttOptions {
  apiKey: string;
  model: string;
  /** `flux-general-multi` only: bias recognition toward these languages. */
  languageHints?: readonly string[];
  /** Words or phrases to favour (names, places). */
  keyterms?: readonly string[];
  /** Flux `eot_threshold` (0.5–1.0): end-of-turn confidence; unset keeps Flux's default. */
  eotThreshold?: number;
  /** Flux `eot_timeout_ms`: silence before a forced end of turn; unset keeps Flux's default. */
  eotTimeoutMs?: number;
  socketFactory?: SocketFactory;
  /** Override for tests; production always uses Deepgram's v2 endpoint. */
  baseUrl?: string;
}

/** Handshake failures surface as errors like "Unexpected server response: 401". */
export function connectError(error: unknown): VoiceError {
  const message = error instanceof Error ? error.message : '';
  const status = /\b(40[123])\b/.exec(message)?.[1];
  if (status !== undefined && isKeyRefusal(Number(status)))
    return { code: 'auth_failed', recoverable: false };
  return { code: 'connection_lost', recoverable: true };
}

/**
 * Deepgram Flux conversational STT (`/v2/listen`). Flux decides turn boundaries itself, so
 * `EndOfTurn` maps straight to a Twring `turn_ended`. Only confirmed end-of-turn text is final;
 * everything else is display-only partial text.
 */
export function createDeepgramStt(options: DeepgramSttOptions): SttProvider {
  const connect = options.socketFactory ?? wsSocketFactory;
  const base = options.baseUrl ?? 'wss://api.deepgram.com/v2/listen';
  return {
    name: 'deepgram-flux',
    async open(onEvent, signal) {
      const url = new URL(base);
      url.searchParams.set('model', options.model);
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', String(STT_SAMPLE_RATE));
      for (const hint of options.languageHints ?? [])
        url.searchParams.append('language_hint', hint);
      for (const term of options.keyterms ?? []) url.searchParams.append('keyterm', term);
      if (options.eotThreshold !== undefined)
        url.searchParams.set('eot_threshold', String(options.eotThreshold));
      if (options.eotTimeoutMs !== undefined)
        url.searchParams.set('eot_timeout_ms', String(options.eotTimeoutMs));
      const socket = connect(url.toString(), { Authorization: `Token ${options.apiKey}` });
      try {
        await waitForOpen(socket, signal);
      } catch (error) {
        throw new VoiceProviderError(connectError(error));
      }
      return new DeepgramSttSession(socket, onEvent);
    },
  };
}

class DeepgramSttSession implements SttSession {
  private buffer = new Int16Array(CHUNK_SAMPLES);
  private buffered = 0;
  private closing = false;
  private lastPartial = '';

  constructor(
    private readonly socket: ProviderSocket,
    private readonly onEvent: (event: SttEvent) => void,
  ) {
    socket.onMessage((data) => {
      if (typeof data === 'string') this.handleMessage(data);
    });
    socket.onClose((code) => {
      if (!this.closing) this.onEvent({ type: 'error', error: closeError(code) });
    });
    socket.onError(() => {
      // A close event always follows; it carries the classification.
    });
  }

  sendAudio(samples: Int16Array): void {
    if (this.closing || !this.socket.isOpen) return;
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, CHUNK_SAMPLES - this.buffered);
      this.buffer.set(samples.subarray(offset, offset + take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === CHUNK_SAMPLES) {
        this.socket.send(new Uint8Array(this.buffer.buffer.slice(0)));
        this.buffered = 0;
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;
    if (this.socket.isOpen) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket.close(1000);
    }
    return Promise.resolve();
  }

  private handleMessage(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.onEvent({ type: 'error', error: { code: 'protocol_error', recoverable: true } });
      return;
    }
    if (errorSchema.safeParse(json).success) {
      this.onEvent({ type: 'error', error: { code: 'provider_error', recoverable: true } });
      return;
    }
    const turn = turnInfoSchema.safeParse(json);
    if (!turn.success) return; // Connected, metadata, and future message types are ignored.
    const { event, turn_index: turnIndex, transcript } = turn.data;
    switch (event) {
      case 'StartOfTurn':
        this.lastPartial = '';
        this.onEvent({ type: 'speech_started', turnIndex });
        if (transcript !== '') this.emitPartial(turnIndex, transcript);
        return;
      case 'Update':
      case 'EagerEndOfTurn':
      case 'TurnResumed':
        if (transcript !== '') this.emitPartial(turnIndex, transcript);
        return;
      case 'EndOfTurn':
        this.lastPartial = '';
        this.onEvent(
          transcript.trim() === ''
            ? { type: 'speech_discarded', turnIndex }
            : { type: 'turn_ended', turnIndex, text: transcript },
        );
        return;
    }
  }

  /** Flux repeats unchanged transcripts every ~250 ms; only changes are worth forwarding. */
  private emitPartial(turnIndex: number, text: string): void {
    if (text === this.lastPartial) return;
    this.lastPartial = text;
    this.onEvent({ type: 'partial', turnIndex, text });
  }
}
