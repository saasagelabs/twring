/**
 * Twring-normalized speech provider contracts (VOICE_ARCHITECTURE §18). Provider event shapes never
 * leave the adapter files; the runtime and UI only see these.
 */

/** Stable machine codes for provider failures. Provider text stays in server logs only. */
export type VoiceErrorCode =
  | 'auth_failed' // key rejected: not recoverable by retrying
  | 'connection_lost' // socket dropped or failed to open: retry
  | 'protocol_error' // unexpected or malformed provider message
  | 'provider_error'; // provider reported a failure

export interface VoiceError {
  code: VoiceErrorCode;
  recoverable: boolean;
}

export type SttEvent =
  /** The provider is confident a new user turn has begun (Flux StartOfTurn). */
  | { type: 'speech_started'; turnIndex: number }
  /** A started turn ended with no words (noise): nothing to commit. */
  | { type: 'speech_discarded'; turnIndex: number }
  /** Interim text for the current turn. Display only; never drives agent work. */
  | { type: 'partial'; turnIndex: number; text: string }
  /** The user has yielded the floor; `text` is final for this turn. */
  | { type: 'turn_ended'; turnIndex: number; text: string }
  | { type: 'error'; error: VoiceError };

export interface SttSession {
  /** One chunk of 16 kHz mono 16-bit audio. Chunks may be any length. */
  sendAudio(samples: Int16Array): void;
  /** Stops recognition and closes the connection. Idempotent. */
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: string;
  open(onEvent: (event: SttEvent) => void, signal: AbortSignal): Promise<SttSession>;
}

export type TtsEvent =
  /** 48 kHz mono linear16 bytes for `generationId`. */
  | { type: 'audio'; generationId: string; bytes: Uint8Array }
  /** Every byte of `generationId` has been delivered. */
  | { type: 'done'; generationId: string }
  /**
   * The session is broken (auth, socket close, protocol): the pipeline reopens it or ends the call.
   * The generation it names, if any, cannot complete either.
   */
  | { type: 'error'; generationId?: string; error: VoiceError }
  /**
   * Only `generationId` failed (e.g. a 429 or rejected request for that one answer); the session
   * is fine and keeps serving later generations (ADR-022).
   */
  | { type: 'generation_error'; generationId: string; error: VoiceError };

/**
 * One speech generation at a time: `speak` appends text to the active generation, `flush` ends it,
 * `cancel` abandons it. Audio for a cancelled generation is never delivered, even if it was
 * already in flight (VOICE_ARCHITECTURE §14).
 */
export interface TtsSession {
  speak(generationId: string, text: string): void;
  flush(generationId: string): void;
  cancel(generationId: string): void;
  close(): Promise<void>;
}

export interface TtsProvider {
  readonly name: string;
  open(onEvent: (event: TtsEvent) => void, signal: AbortSignal): Promise<TtsSession>;
}

/** Maps a WebSocket close to a Twring error. 1008/4001-4003 are auth/policy rejections. */
export function closeError(code: number): VoiceError {
  if (code === 1008 || (code >= 4001 && code <= 4003)) {
    return { code: 'auth_failed', recoverable: false };
  }
  return { code: 'connection_lost', recoverable: true };
}

/** Thrown by `open()` when a provider session cannot be established. */
export class VoiceProviderError extends Error {
  /** Which side failed, when the pipeline knows (set as `start` rejects). */
  side?: 'stt' | 'tts';
  constructor(readonly error: VoiceError) {
    super(`voice provider ${error.code}`);
    this.name = 'VoiceProviderError';
  }
}
