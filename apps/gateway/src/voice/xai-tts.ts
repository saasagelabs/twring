import { z } from 'zod';

import { SAMPLE_RATE } from '../audio/pcm';

import { BASE64, MAX_GENERATION_CHARS } from './cartesia-tts';
import { waitForOpen, wsSocketFactory, type ProviderSocket, type SocketFactory } from './socket';
import {
  VoiceProviderError,
  closeError,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';
import { isXaiKeyProblem, xaiConnectError } from './xai-errors';

/**
 * xAI streaming TTS (`wss://api.x.ai/v1/tts`), from
 * https://docs.x.ai/developers/model-capabilities/audio/text-to-speech: the client sends
 * `text.delta`, `text.done` (end of utterance) and `text.clear` (abandon it); the server sends
 * base64 `audio.delta`, `audio.done`, `audio.clear` (acknowledges a clear) and `error`.
 *
 * xAI names no utterance on its messages, so a Twring generation is the one utterance in flight.
 * xAI answers each `text.clear` with exactly one `audio.clear`, so clears are counted: while any
 * is unacknowledged, every `audio.delta` and `audio.done` belongs to an abandoned utterance and is
 * dropped; cancelled audio is never delivered (VOICE_ARCHITECTURE §14). A clear left
 * unacknowledged for 2 s fails the session so the pipeline reopens a clean socket.
 */
export type XaiVoice = 'eve' | 'ara' | 'rex' | 'sal' | 'leo';

export interface XaiTtsOptions {
  apiKey: string;
  voice: XaiVoice;
  /** xAI's `optimize_streaming_latency` (0 to 2); unset leaves xAI's default. */
  optimizeStreamingLatency?: number;
  socketFactory?: SocketFactory;
  /** Override for tests; production always uses xAI's endpoint. */
  baseUrl?: string;
  /** Injectable timer for the clear acknowledgement wait; returns a cancel function. */
  setTimeout?: (callback: () => void, ms: number) => () => void;
}

type Timer = (callback: () => void, ms: number) => () => void;

const realTimer: Timer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

/** How long xAI may take to acknowledge a `text.clear` before the socket is presumed stuck. */
export const XAI_CLEAR_TIMEOUT_MS = 2000;
/** Refusal wording that does not name the key (checked after `isXaiKeyProblem`). */
const REFUSAL_WORDING = /forbidden|unauthori[sz]ed|permission/i;
/** Recently ended generation ids remembered so late text for them is ignored. */
const ENDED_MEMORY = 16;

const serverMessageSchema = z.object({
  type: z.string(),
  delta: z.string().optional().catch(undefined),
  message: z.unknown().optional(),
});

export function createXaiTts(options: XaiTtsOptions): TtsProvider {
  const connect = options.socketFactory ?? wsSocketFactory;
  const base = options.baseUrl ?? 'wss://api.x.ai/v1/tts';
  return {
    name: 'xai-tts',
    async open(onEvent, signal) {
      const url = new URL(base);
      url.searchParams.set('language', 'en');
      url.searchParams.set('voice', options.voice);
      url.searchParams.set('codec', 'pcm');
      url.searchParams.set('sample_rate', String(SAMPLE_RATE));
      if (options.optimizeStreamingLatency !== undefined)
        url.searchParams.set(
          'optimize_streaming_latency',
          String(options.optimizeStreamingLatency),
        );
      const socket = connect(url.toString(), { Authorization: `Bearer ${options.apiKey}` });
      try {
        await waitForOpen(socket, signal);
      } catch (error) {
        throw new VoiceProviderError(xaiConnectError(error));
      }
      const session = new XaiTtsSession(socket, onEvent, options.setTimeout ?? realTimer);
      signal.addEventListener('abort', () => void session.close(), { once: true });
      return session;
    },
  };
}

interface Generation {
  generationId: string;
  chars: number;
  flushed: boolean;
  /** A PCM16 byte left over from an odd-length chunk, prepended to the next one. */
  carry: number | undefined;
}

class XaiTtsSession implements TtsSession {
  private active: Generation | undefined;
  /** `text.clear`s sent and not yet acknowledged; audio is dropped while any is pending. */
  private pendingClears = 0;
  private cancelClearTimer: (() => void) | undefined;
  /** The last few generations that ended (cancelled, failed, done); later text is ignored. */
  private ended: string[] = [];
  private closing = false;

  constructor(
    private readonly socket: ProviderSocket,
    private readonly onEvent: (event: TtsEvent) => void,
    private readonly timer: Timer,
  ) {
    socket.onMessage((data) => {
      if (this.closing) return;
      if (typeof data !== 'string') return this.fail({ code: 'protocol_error', recoverable: true });
      this.handleMessage(data);
    });
    socket.onClose((code) => {
      if (this.closing) return;
      this.closing = true;
      this.stopClearTimer();
      const generationId = this.active?.generationId;
      this.active = undefined;
      this.onEvent({ type: 'error', generationId, error: closeError(code) });
    });
    socket.onError(() => {
      // A close event always follows; it carries the classification.
    });
  }

  speak(generationId: string, text: string): void {
    if (this.closing || text === '' || this.ended.includes(generationId)) return;
    if (this.active !== undefined && this.active.generationId !== generationId) {
      this.cancel(this.active.generationId);
    }
    if (this.active === undefined) {
      this.active = { generationId, chars: 0, flushed: false, carry: undefined };
    }
    const generation = this.active;
    if (generation.flushed) return;
    const room = MAX_GENERATION_CHARS - generation.chars;
    if (room <= 0) return;
    let chunk = text.length > room ? text.slice(0, room) : text;
    if (chunk.length < text.length && /[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
    if (chunk === '') return;
    generation.chars += chunk.length;
    this.send({ type: 'text.delta', delta: chunk });
  }

  /**
   * Ends the utterance with `text.done`. A generation that sent no text completes locally: an
   * empty utterance has no audio to wait for, and xAI is never asked to synthesize nothing.
   */
  flush(generationId: string): void {
    if (this.closing || this.ended.includes(generationId)) return;
    const generation = this.active;
    if (generation === undefined) {
      this.end(generationId);
      this.onEvent({ type: 'done', generationId });
      return;
    }
    if (generation.generationId !== generationId || generation.flushed) return;
    generation.flushed = true;
    this.send({ type: 'text.done' });
  }

  cancel(generationId: string): void {
    if (this.closing) return;
    this.end(generationId);
    const generation = this.active;
    if (generation?.generationId !== generationId) return;
    this.abandon();
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;
    this.stopClearTimer();
    this.active = undefined;
    if (this.socket.isOpen) this.socket.close(1000);
    return Promise.resolve();
  }

  private end(generationId: string): void {
    if (this.ended.includes(generationId)) return;
    this.ended.push(generationId);
    if (this.ended.length > ENDED_MEMORY) this.ended.shift();
  }

  /** Drops the active utterance and asks xAI to clear it; its audio drains unheard. */
  private abandon(): void {
    this.active = undefined;
    this.pendingClears += 1;
    this.send({ type: 'text.clear' });
    this.cancelClearTimer ??= this.startClearTimer();
  }

  /** One timer guards the oldest unacknowledged clear; each acknowledgement restarts it. */
  private startClearTimer(): () => void {
    return this.timer(() => {
      this.cancelClearTimer = undefined;
      // Never re-accept audio on a guess: a fresh socket is the only clean state.
      this.fail({ code: 'connection_lost', recoverable: true });
    }, XAI_CLEAR_TIMEOUT_MS);
  }

  private stopClearTimer(): void {
    this.cancelClearTimer?.();
    this.cancelClearTimer = undefined;
  }

  private send(message: object): void {
    if (this.socket.isOpen) this.socket.send(JSON.stringify(message));
  }

  private handleMessage(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.fail({ code: 'protocol_error', recoverable: true });
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return this.fail({ code: 'protocol_error', recoverable: true });
    const message = parsed.data;
    switch (message.type) {
      case 'audio.delta':
        return this.audio(message.delta);
      case 'audio.done': {
        if (this.pendingClears > 0) return;
        const generation = this.active;
        if (generation === undefined || !generation.flushed) return;
        this.active = undefined;
        this.end(generation.generationId);
        this.onEvent({ type: 'done', generationId: generation.generationId });
        return;
      }
      case 'audio.clear':
        if (this.pendingClears === 0) return;
        this.pendingClears -= 1;
        this.stopClearTimer();
        if (this.pendingClears > 0) this.cancelClearTimer = this.startClearTimer();
        return;
      case 'error': {
        if (typeof message.message === 'string' && isXaiKeyProblem(message.message)) {
          return this.fail({ code: 'auth_failed', recoverable: false });
        }
        // Refusal wording without the key ("Forbidden", a content policy refusal) may or may not
        // mean the key: end the session so the pipeline's reconnect handshake decides.
        if (typeof message.message === 'string' && REFUSAL_WORDING.test(message.message)) {
          return this.fail({ code: 'connection_lost', recoverable: true });
        }
        const generation = this.active;
        if (generation === undefined) return;
        this.end(generation.generationId);
        this.abandon();
        this.onEvent({
          type: 'generation_error',
          generationId: generation.generationId,
          error: { code: 'provider_error', recoverable: true },
        });
        return;
      }
      default:
        return; // Future message types are ignored.
    }
  }

  private audio(data: string | undefined): void {
    const generation = this.active;
    if (this.pendingClears > 0 || generation === undefined || data === undefined) return;
    // Buffer.from skips characters that are not base64: garbage would play as noise.
    if (!BASE64.test(data)) return this.fail({ code: 'protocol_error', recoverable: true });
    const decoded = Buffer.from(data, 'base64');
    const carried = generation.carry === undefined ? 0 : 1;
    const total = decoded.byteLength + carried;
    const usable = total - (total % 2);
    const bytes = new Uint8Array(usable);
    if (usable > 0) {
      if (generation.carry !== undefined) bytes[0] = generation.carry;
      bytes.set(decoded.subarray(0, usable - carried), carried);
    }
    generation.carry =
      total % 2 === 1
        ? total === 1 && carried === 1
          ? generation.carry
          : decoded[decoded.byteLength - 1]
        : undefined;
    if (usable === 0) return;
    this.onEvent({ type: 'audio', generationId: generation.generationId, bytes });
  }

  private fail(error: VoiceError): void {
    if (this.closing) return;
    const generationId = this.active?.generationId;
    this.closing = true;
    this.stopClearTimer();
    this.active = undefined;
    if (this.socket.isOpen) this.socket.close(1011);
    this.onEvent({ type: 'error', generationId, error });
  }
}
