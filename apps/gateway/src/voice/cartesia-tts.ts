import { z } from 'zod';

import { SAMPLE_RATE } from '../audio/pcm';

import { connectError } from './deepgram-stt';
import { isKeyRefusal } from './key-refusal';
import { waitForOpen, wsSocketFactory, type ProviderSocket, type SocketFactory } from './socket';
import {
  VoiceProviderError,
  closeError,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';

/**
 * Cartesia Sonic TTS over its WebSocket (ADR-020). Protocol facts, from the official docs:
 * - https://docs.cartesia.ai/api-reference/tts/websocket: `wss://api.cartesia.ai/tts/websocket`,
 *   `X-API-Key` header, `cartesia_version` query; requests carry model_id, transcript,
 *   voice {mode:'id', id}, output_format {container:'raw', encoding, sample_rate}, context_id and
 *   `continue`; `{context_id, cancel:true}` cancels; responses are `chunk` (base64 `data`), `done`,
 *   `flush_done`, `timestamps` and `error` (with `status_code`), each naming its `context_id`.
 * - https://docs.cartesia.ai/build-with-cartesia/capability-guides/stream-inputs-using-continuations
 *   A context ends with `continue:false`, and an empty transcript is allowed for that; cancel only
 *   halts work that has not started, so a generating context keeps sending chunks. Late chunks of a
 *   cancelled context are therefore dropped here (VOICE_ARCHITECTURE §14).
 *
 * Idle sockets are closed by Cartesia after 5 minutes. Cartesia documents no application-level
 * keepalive message (none in the WebSocket reference above), so while no generation is active the
 * session sends a WebSocket ping control frame (RFC 6455 §5.5.2,
 * https://www.rfc-editor.org/rfc/rfc6455#section-5.5.2), which every compliant server answers and
 * which carries no billable text. If an idle close still happens, the pipeline reopens the socket.
 */
export const CARTESIA_API_VERSION = '2026-08-14';

/** Most text one generation may carry; a runaway agent reply is cut here, not buffered upstream. */
export const MAX_GENERATION_CHARS = 20_000;

/** Ping interval while idle: well inside Cartesia's 5-minute idle close (ADR-022). */
export const CARTESIA_KEEPALIVE_MS = 90_000;

/** Standard base64, padding optional (a length of 1 mod 4 is never valid). */
export const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

const serverMessageSchema = z.object({
  type: z.string(),
  context_id: z.string().optional().catch(undefined),
  data: z.string().optional().catch(undefined),
  status_code: z.number().optional().catch(undefined),
});

/** A Cartesia voice as Twring sends it: the provider's voice UUID and the locale it speaks. */
export interface CartesiaVoice {
  voiceUuid: string;
  /** Regional locale (`locale` needs sonic-3.6 or newer), e.g. `en-IN` for an Indian accent. */
  locale: string;
}

export interface CartesiaTtsOptions {
  apiKey: string;
  model: string;
  voice: CartesiaVoice;
  /** Speaking pace, 0.6–1.5 (`generation_config.speed`); 1 or unset sends nothing extra. */
  speed?: number;
  socketFactory?: SocketFactory;
  baseUrl?: string;
  /** Timer seam for the idle keepalive; returns a cancel function. */
  setInterval?: (callback: () => void, ms: number) => () => void;
}

export function createCartesiaTts(options: CartesiaTtsOptions): TtsProvider {
  const connect = options.socketFactory ?? wsSocketFactory;
  const base = options.baseUrl ?? 'wss://api.cartesia.ai/tts/websocket';
  const every =
    options.setInterval ??
    ((callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    });
  return {
    name: 'cartesia-sonic-tts',
    async open(onEvent, signal) {
      const url = new URL(base);
      url.searchParams.set('cartesia_version', CARTESIA_API_VERSION);
      const socket = connect(url.toString(), { 'X-API-Key': options.apiKey });
      try {
        await waitForOpen(socket, signal);
      } catch (error) {
        throw new VoiceProviderError(connectError(error));
      }
      const session = new CartesiaTtsSession(socket, onEvent, options);
      session.startKeepalive(every);
      signal.addEventListener('abort', () => void session.close(), { once: true });
      return session;
    },
  };
}

/** One Twring generation as one Cartesia context. */
interface Context {
  generationId: string;
  contextId: string;
  chars: number;
  flushed: boolean;
}

/**
 * Cartesia names the context on every message, so routing is by id: audio is delivered only for
 * the active, uncancelled generation's context. Anything else (a cancelled context still finishing,
 * an unknown id) is dropped.
 */
class CartesiaTtsSession implements TtsSession {
  private active: Context | undefined;
  private nextContext = 0;
  private closing = false;
  private stopKeepalive: (() => void) | undefined;
  /** Distinguishes this session's context ids from any other on the same key. */
  private readonly prefix = `cord-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    private readonly socket: ProviderSocket,
    private readonly onEvent: (event: TtsEvent) => void,
    private readonly options: CartesiaTtsOptions,
  ) {
    socket.onMessage((data) => {
      if (this.closing) return;
      // Cartesia sends JSON text frames only; binary is unexpected.
      if (typeof data !== 'string') return this.fail({ code: 'protocol_error', recoverable: true });
      this.handleMessage(data);
    });
    socket.onClose((code) => {
      if (this.closing) return;
      this.closing = true;
      this.stopTimers();
      const generationId = this.active?.generationId;
      this.active = undefined;
      this.onEvent({ type: 'error', generationId, error: closeError(code) });
    });
    socket.onError(() => {
      // A close event always follows; it carries the classification.
    });
  }

  /** Pings the socket on each tick that finds no generation active (a live one keeps it busy). */
  startKeepalive(every: (callback: () => void, ms: number) => () => void): void {
    if (this.closing) return;
    this.stopKeepalive = every(() => {
      if (!this.closing && this.active === undefined && this.socket.isOpen) this.socket.ping();
    }, CARTESIA_KEEPALIVE_MS);
  }

  speak(generationId: string, text: string): void {
    if (this.closing || text === '') return;
    if (this.active !== undefined && this.active.generationId !== generationId) {
      this.cancel(this.active.generationId);
    }
    if (this.active === undefined) {
      this.active = {
        generationId,
        contextId: `${this.prefix}-${this.nextContext++}`,
        chars: 0,
        flushed: false,
      };
    }
    const context = this.active;
    if (context.flushed) return;
    const room = MAX_GENERATION_CHARS - context.chars;
    if (room <= 0) return;
    let chunk = text.length > room ? text.slice(0, room) : text;
    // Never end on half a surrogate pair: a lone surrogate is invalid text the provider rejects.
    if (chunk.length < text.length && /[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
    if (chunk === '') return;
    context.chars += chunk.length;
    this.send(this.request(context, chunk, true));
  }

  flush(generationId: string): void {
    const context = this.active;
    if (this.closing || context?.generationId !== generationId || context.flushed) return;
    context.flushed = true;
    this.send(this.request(context, '', false));
  }

  cancel(generationId: string): void {
    const context = this.active;
    if (this.closing || context?.generationId !== generationId) return;
    // Dropping `active` is what guarantees silence: chunks still arriving for it are ignored.
    this.active = undefined;
    this.send({ context_id: context.contextId, cancel: true });
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;
    this.stopTimers();
    this.active = undefined;
    if (this.socket.isOpen) this.socket.close(1000);
    return Promise.resolve();
  }

  private stopTimers(): void {
    this.stopKeepalive?.();
    this.stopKeepalive = undefined;
  }

  private request(context: Context, transcript: string, more: boolean): object {
    return {
      model_id: this.options.model,
      transcript,
      voice: { mode: 'id', id: this.options.voice.voiceUuid },
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE },
      locale: this.options.voice.locale,
      ...(this.options.speed !== undefined &&
        this.options.speed !== 1 && { generation_config: { speed: this.options.speed } }),
      context_id: context.contextId,
      continue: more,
    };
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
    const context = this.active;
    const isActive = context !== undefined && message.context_id === context.contextId;
    switch (message.type) {
      case 'chunk': {
        if (!isActive || message.data === undefined) return;
        // Buffer.from skips characters that are not base64: garbage would play as noise.
        if (!BASE64.test(message.data))
          return this.fail({ code: 'protocol_error', recoverable: true });
        const bytes = Buffer.from(message.data, 'base64');
        if (bytes.byteLength === 0) return;
        this.onEvent({
          type: 'audio',
          generationId: context.generationId,
          bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        });
        return;
      }
      case 'done':
        if (!isActive) return;
        this.active = undefined;
        this.onEvent({ type: 'done', generationId: context.generationId });
        return;
      case 'error':
        return this.providerError(message.status_code, message.context_id);
      default:
        // flush_done, timestamps, phoneme_timestamps: nothing Twring routes on.
        return;
    }
  }

  /**
   * An error naming the active context fails only that generation; one naming another context is
   * stale; one naming none (or auth) ends the session.
   */
  private providerError(status: number | undefined, contextId: string | undefined): void {
    if (isKeyRefusal(status)) {
      return this.fail({ code: 'auth_failed', recoverable: false });
    }
    if (contextId === undefined) return this.fail({ code: 'provider_error', recoverable: true });
    const context = this.active;
    if (context === undefined || context.contextId !== contextId) return;
    this.active = undefined;
    this.onEvent({
      type: 'generation_error',
      generationId: context.generationId,
      error: { code: 'provider_error', recoverable: true },
    });
  }

  private fail(error: VoiceError): void {
    if (this.closing) return;
    const generationId = this.active?.generationId;
    this.closing = true;
    this.stopTimers();
    this.active = undefined;
    if (this.socket.isOpen) this.socket.close(1011);
    this.onEvent({ type: 'error', generationId, error });
  }
}
