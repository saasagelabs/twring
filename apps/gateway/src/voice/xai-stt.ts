import { z } from 'zod';

import { waitForOpen, wsSocketFactory, type ProviderSocket, type SocketFactory } from './socket';
import { isXaiKeyProblem, xaiConnectError } from './xai-errors';
import {
  VoiceProviderError,
  closeError,
  type SttEvent,
  type SttProvider,
  type SttSession,
} from './types';

const SAMPLE_RATE = 16_000;
/** Audio held while waiting for `transcript.created`; older samples are dropped beyond this. */
const MAX_PENDING_SAMPLES = SAMPLE_RATE * 2;
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;
const DEFAULT_ENDPOINTING_MS = 400;
const CLOSE_TIMEOUT_MS = 1000;
/** A session that never says `transcript.created` is deaf: report it so the pipeline reconnects. */
const READY_TIMEOUT_MS = 5000;
/** ~100 ms of 16 kHz PCM16 per binary frame (3200 bytes). */
const FRAME_SAMPLES = SAMPLE_RATE / 10;
const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transcript.created') }),
  z.object({
    type: z.literal('transcript.partial'),
    text: z.string().max(20_000),
    is_final: z.boolean().optional(),
    speech_final: z.boolean().optional(),
  }),
  z.object({ type: z.literal('transcript.done') }),
  z.object({ type: z.literal('error'), message: z.unknown().optional() }),
]);

export interface XaiSttOptions {
  apiKey: string;
  /** Words or phrases to favour; cleaned to at most 100 terms of 50 characters. */
  keyterms?: readonly string[];
  /** Silence (ms) before xAI ends an utterance; defaults to 400. */
  endpointingMs?: number;
  /** `smart_turn` threshold (0..1); unset leaves it off. */
  smartTurn?: number;
  smartTurnTimeoutMs?: number;
  socketFactory?: SocketFactory;
  /** Override for tests; production always uses xAI's endpoint. */
  baseUrl?: string;
  /** Injectable timer for the ready and close waits; returns a cancel function. */
  setTimeout?: (callback: () => void, ms: number) => () => void;
}

type Timer = (callback: () => void, ms: number) => () => void;

const realTimer: Timer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

export function cleanKeyterms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const term = Array.from(raw.trim()).slice(0, MAX_KEYTERM_LENGTH).join('').trim();
    if (term === '' || out.some((t) => t.toLowerCase() === term.toLowerCase())) continue;
    out.push(term);
    if (out.length === MAX_KEYTERMS) break;
  }
  return out;
}

/**
 * xAI streaming STT (`/v1/stt`). Chunk finals (`is_final`) accumulate into the current turn;
 * `speech_final` closes it as a Twring `turn_ended`.
 */
export function createXaiStt(options: XaiSttOptions): SttProvider {
  const connect = options.socketFactory ?? wsSocketFactory;
  const base = options.baseUrl ?? 'wss://api.x.ai/v1/stt';
  return {
    name: 'xai-stt',
    async open(onEvent, signal) {
      const url = new URL(base);
      url.searchParams.set('model', 'grok-voice-transcribe-2.0');
      url.searchParams.set('sample_rate', String(SAMPLE_RATE));
      url.searchParams.set('encoding', 'pcm');
      url.searchParams.set('language', 'en');
      url.searchParams.set('interim_results', 'true');
      url.searchParams.set('endpointing', String(options.endpointingMs ?? DEFAULT_ENDPOINTING_MS));
      if (options.smartTurn !== undefined)
        url.searchParams.set('smart_turn', String(options.smartTurn));
      if (options.smartTurnTimeoutMs !== undefined)
        url.searchParams.set('smart_turn_timeout', String(options.smartTurnTimeoutMs));
      for (const term of cleanKeyterms(options.keyterms ?? []))
        url.searchParams.append('keyterm', term);
      const socket = connect(url.toString(), { Authorization: `Bearer ${options.apiKey}` });
      try {
        await waitForOpen(socket, signal);
      } catch (error) {
        throw new VoiceProviderError(xaiConnectError(error));
      }
      return new XaiSttSession(socket, onEvent, options.setTimeout ?? realTimer);
    },
  };
}

class XaiSttSession implements SttSession {
  private started = false;
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  /** Samples dropped before the stream started (kept for debugging, never logged). */
  droppedSamples = 0;
  private closing: Promise<void> | undefined;
  private errored = false;
  private turnIndex = 0;
  private inTurn = false;
  private committed = '';
  private lastPartial = '';
  private finished: (() => void) | undefined;
  private frame = new Int16Array(FRAME_SAMPLES);
  private framed = 0;
  private cancelReady: () => void;

  constructor(
    private readonly socket: ProviderSocket,
    private readonly onEvent: (event: SttEvent) => void,
    private readonly timer: Timer,
  ) {
    this.cancelReady = timer(() => this.notReady(), READY_TIMEOUT_MS);
    socket.onMessage((data) => {
      if (typeof data === 'string') this.handleMessage(data);
    });
    socket.onClose((code) => {
      this.cancelReady();
      this.finished?.();
      if (this.closing === undefined && !this.errored) {
        this.errored = true;
        this.onEvent({ type: 'error', error: closeError(code) });
      }
    });
    socket.onError(() => {
      // A close event always follows; it carries the classification.
    });
  }

  sendAudio(samples: Int16Array): void {
    if (this.closing !== undefined || this.errored || !this.socket.isOpen) return;
    if (this.started) {
      this.send(samples);
      return;
    }
    this.pending.push(samples.slice());
    this.pendingSamples += samples.length;
    while (this.pendingSamples > MAX_PENDING_SAMPLES) {
      const head = this.pending[0]!;
      const excess = this.pendingSamples - MAX_PENDING_SAMPLES;
      if (head.length <= excess) {
        this.pending.shift();
        this.pendingSamples -= head.length;
        this.droppedSamples += head.length;
      } else {
        this.pending[0] = head.subarray(excess);
        this.pendingSamples -= excess;
        this.droppedSamples += excess;
      }
    }
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.cancelReady();
    if (!this.socket.isOpen) {
      this.pending = [];
      this.closing = Promise.resolve();
      return this.closing;
    }
    this.pending = [];
    if (!this.started) {
      // Never send audio (or audio.done) before xAI says it is ready. `closing` is set first so a
      // synchronous close callback is not reported as a lost connection.
      this.closing = Promise.resolve();
      this.socket.close(1000);
      return this.closing;
    }
    if (this.framed > 0) this.sendFrame(this.frame.subarray(0, this.framed));
    this.framed = 0;
    this.socket.send(JSON.stringify({ type: 'audio.done' }));
    this.closing = new Promise<void>((resolve) => {
      const cancel = this.timer(() => this.finished?.(), CLOSE_TIMEOUT_MS);
      this.finished = () => {
        this.finished = undefined;
        cancel();
        if (this.socket.isOpen) this.socket.close(1000);
        resolve();
      };
    });
    return this.closing;
  }

  private notReady(): void {
    if (this.started || this.errored || this.closing !== undefined) return;
    this.errored = true;
    this.onEvent({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    this.pending = [];
    if (this.socket.isOpen) this.socket.close(1000);
  }

  /** Batches into ~100 ms frames. */
  private send(samples: Int16Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, FRAME_SAMPLES - this.framed);
      this.frame.set(samples.subarray(offset, offset + take), this.framed);
      this.framed += take;
      offset += take;
      if (this.framed === FRAME_SAMPLES) {
        this.sendFrame(this.frame);
        this.framed = 0;
      }
    }
  }

  private sendFrame(samples: Int16Array): void {
    this.socket.send(
      new Uint8Array(
        samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
      ),
    );
  }

  private handleMessage(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.onEvent({ type: 'error', error: { code: 'protocol_error', recoverable: true } });
      return;
    }
    const parsed = messageSchema.safeParse(json);
    if (!parsed.success) return; // Future message types are ignored.
    const message = parsed.data;
    switch (message.type) {
      case 'transcript.created':
        if (this.started) return;
        this.started = true;
        this.cancelReady();
        for (const chunk of this.pending) this.send(chunk);
        this.pending = [];
        this.pendingSamples = 0;
        return;
      case 'transcript.partial':
        this.handlePartial(message.text, message.is_final === true, message.speech_final === true);
        return;
      case 'transcript.done':
        this.finished?.();
        return;
      case 'error': {
        if (this.errored || this.closing !== undefined) return;
        this.errored = true;
        const auth = typeof message.message === 'string' && isXaiKeyProblem(message.message);
        this.onEvent({
          type: 'error',
          error: auth
            ? { code: 'auth_failed', recoverable: false }
            : { code: 'connection_lost', recoverable: true },
        });
        return;
      }
    }
  }

  private handlePartial(text: string, isFinal: boolean, speechFinal: boolean): void {
    const piece = text.trim();
    if (speechFinal) {
      // speech_final is xAI's stitched utterance: it wins; committed only fills an empty one.
      const full = piece !== '' ? piece : this.committed;
      if (full !== '') {
        if (!this.inTurn) this.onEvent({ type: 'speech_started', turnIndex: this.turnIndex });
        this.onEvent({ type: 'turn_ended', turnIndex: this.turnIndex, text: full });
        this.turnIndex += 1;
      } else if (this.inTurn) {
        this.onEvent({ type: 'speech_discarded', turnIndex: this.turnIndex });
        this.turnIndex += 1;
      }
      this.inTurn = false;
      this.committed = '';
      this.lastPartial = '';
      return;
    }
    if (piece === '' && !this.inTurn) return;
    const shown = extend(this.committed, piece);
    if (isFinal) this.committed = shown;
    if (shown === '') return;
    if (!this.inTurn) {
      this.inTurn = true;
      this.onEvent({ type: 'speech_started', turnIndex: this.turnIndex });
    }
    if (shown === this.lastPartial) return;
    this.lastPartial = shown;
    this.onEvent({ type: 'partial', turnIndex: this.turnIndex, text: shown });
  }
}

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * Interims and chunk finals may be cumulative or per chunk. Text whose first words equal all the
 * committed words (ignoring case and punctuation) replaces it; anything else continues it.
 */
function extend(committed: string, piece: string): string {
  if (committed === '' || piece === '') return join(committed, piece);
  const before = words(committed);
  const after = words(piece);
  const cumulative = after.length >= before.length && before.every((w, i) => after[i] === w);
  return cumulative ? piece : join(committed, piece);
}

function join(a: string, b: string): string {
  return a === '' ? b : b === '' ? a : `${a} ${b}`;
}
