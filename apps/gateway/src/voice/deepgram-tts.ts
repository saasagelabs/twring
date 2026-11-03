import { z } from 'zod';

import { SAMPLE_RATE } from '../audio/pcm';

import { connectError } from './deepgram-stt';
import { waitForOpen, wsSocketFactory, type ProviderSocket, type SocketFactory } from './socket';
import {
  VoiceProviderError,
  closeError,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
} from './types';

/** Flux TTS drops sessions idle for 60 s; a WebSocket ping well inside that keeps the voice warm. */
const KEEPALIVE_MS = 20_000;
/** An Interrupt Flux has not acknowledged by now is lost: the session is dropped and reopened. */
export const INTERRUPT_ACK_TIMEOUT_MS = 2_000;
/** How many started turns are remembered by `speech_id`, so their late messages are recognised. */
const STARTED_TURNS_KEPT = 8;

const speechIdSchema = z.string().optional().catch(undefined);

const serverMessageSchema = z.object({
  type: z.string(),
  code: z.string().optional(),
  /** Flux's ID for one synthesis turn; an unexpected shape is treated as absent. */
  speech_id: speechIdSchema,
  /** SpeechInterrupted nests the cut turn's `speech_id` here. */
  metadata: z.object({ speech_id: speechIdSchema }).optional().catch(undefined),
});

export interface DeepgramTtsOptions {
  apiKey: string;
  model: string;
  socketFactory?: SocketFactory;
  baseUrl?: string;
  setInterval?: (callback: () => void, ms: number) => () => void;
  setTimeout?: (callback: () => void, ms: number) => () => void;
}

/**
 * Deepgram Flux TTS (`/v2/speak`) streaming raw 48 kHz linear16, the rate LiveKit publishes, so
 * audio goes out without resampling. A Flux "turn" maps one-to-one to a Twring speech generation.
 */
export function createDeepgramTts(options: DeepgramTtsOptions): TtsProvider {
  const connect = options.socketFactory ?? wsSocketFactory;
  const base = options.baseUrl ?? 'wss://api.deepgram.com/v2/speak';
  const every =
    options.setInterval ??
    ((callback: () => void, ms: number) => {
      const handle = setInterval(callback, ms);
      return () => clearInterval(handle);
    });
  const after =
    options.setTimeout ??
    ((callback: () => void, ms: number) => {
      const handle = setTimeout(callback, ms);
      return () => clearTimeout(handle);
    });
  return {
    name: 'deepgram-flux-tts',
    async open(onEvent, signal) {
      const url = new URL(base);
      url.searchParams.set('model', options.model);
      url.searchParams.set('encoding', 'linear16');
      url.searchParams.set('sample_rate', String(SAMPLE_RATE));
      const socket = connect(url.toString(), { Authorization: `Token ${options.apiKey}` });
      try {
        await waitForOpen(socket, signal);
      } catch (error) {
        throw new VoiceProviderError(connectError(error));
      }
      return new DeepgramTtsSession(
        socket,
        onEvent,
        every(() => socket.ping(), KEEPALIVE_MS),
        after,
      );
    },
  };
}

/** One Twring generation as a Flux turn: the text sent between two boundaries. */
interface Turn {
  generationId: string;
  /** Order in which the turn sent its first Speak; Flux starts turns in this order. */
  seq: number;
  speechId: string | undefined;
  flushed: boolean;
}

/** An Interrupt sent for the turn `cutSeq`, awaiting Flux's acknowledgement. */
interface PendingInterrupt {
  cutSeq: number;
}

/**
 * Routing follows the order Flux was observed to keep (ADR-015): every turn gets exactly one
 * SpeechStarted, in the order turns were started, and audio after it belongs to that turn until the
 * next SpeechStarted. Audio is delivered only while that turn is the active, uncancelled generation.
 */
class DeepgramTtsSession implements TtsSession {
  /** The generation Twring is speaking now: uncancelled and not yet done. */
  private active: Turn | undefined;
  /** Turns that sent a Speak but whose SpeechStarted has not arrived, oldest first. */
  private readonly unstarted: Turn[] = [];
  /** The turn whose audio is arriving: the one the last SpeechStarted named. */
  private current: Turn | undefined;
  /** Recently started turns, for messages that name a turn by `speech_id`. */
  private readonly started: Turn[] = [];
  private nextSeq = 0;
  /** Interrupts sent but not yet confirmed, oldest first; only the ack timer depends on them. */
  private readonly pendingInterrupts: PendingInterrupt[] = [];
  private stopAckTimer: (() => void) | undefined;
  /** Closed by Twring, failed, or the socket died: nothing more is emitted and no timer is armed. */
  private closing = false;

  constructor(
    private readonly socket: ProviderSocket,
    private readonly onEvent: (event: TtsEvent) => void,
    private readonly stopKeepalive: () => void,
    private readonly after: (callback: () => void, ms: number) => () => void,
  ) {
    socket.onMessage((data) => {
      if (this.closing) return;
      if (typeof data === 'string') this.handleMessage(data);
      else this.handleAudio(data);
    });
    socket.onClose((code) => {
      this.stopKeepalive();
      this.clearAckTimer();
      if (this.closing) return;
      this.closing = true;
      const generationId = this.active?.generationId;
      this.active = undefined;
      this.onEvent({ type: 'error', generationId, error: closeError(code) });
    });
    socket.onError(() => {
      // A close event always follows; it carries the classification.
    });
  }

  speak(generationId: string, text: string): void {
    if (this.closing || text === '') return;
    if (this.active !== undefined && this.active.generationId !== generationId) {
      this.cancel(this.active.generationId);
    }
    if (this.active === undefined) {
      this.active = { generationId, seq: this.nextSeq++, speechId: undefined, flushed: false };
      this.unstarted.push(this.active);
    }
    this.send({ type: 'Speak', text });
  }

  flush(generationId: string): void {
    const turn = this.active;
    if (this.closing || turn?.generationId !== generationId || turn.flushed) return;
    turn.flushed = true;
    this.send({ type: 'Flush' });
  }

  cancel(generationId: string): void {
    const turn = this.active;
    if (this.closing || turn?.generationId !== generationId) return;
    this.active = undefined;
    this.pendingInterrupts.push({ cutSeq: turn.seq });
    this.restartAckTimer();
    this.send({ type: 'Interrupt' });
  }

  close(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.closing = true;
    this.stopKeepalive();
    this.clearAckTimer();
    this.active = undefined;
    if (this.socket.isOpen) this.socket.close(1000);
    return Promise.resolve();
  }

  private send(message: object): void {
    if (this.socket.isOpen) this.socket.send(JSON.stringify(message));
  }

  private handleAudio(bytes: Uint8Array): void {
    if (this.current === undefined || this.current !== this.active) return;
    this.onEvent({ type: 'audio', generationId: this.current.generationId, bytes });
  }

  private handleMessage(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.fail('protocol_error');
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success) return this.fail('protocol_error');
    const speechId = parsed.data.speech_id;
    switch (parsed.data.type) {
      case 'SpeechStarted':
        return this.startTurn(speechId);
      case 'SpeechInterrupted':
        return this.interrupted(parsed.data.metadata?.speech_id ?? speechId);
      case 'SpeechMetadata': {
        // Sent after the last audio of a completed turn (never for a cut one).
        const turn = speechId !== undefined ? this.byId(speechId) : this.current;
        if (turn === undefined || turn !== this.active || !turn.flushed) return;
        this.active = undefined;
        this.onEvent({ type: 'done', generationId: turn.generationId });
        return;
      }
      case 'Warning':
        // Routing does not depend on warnings; only a refused Interrupt settles one.
        if (parsed.data.code === 'NOTHING_TO_INTERRUPT') this.settle(1);
        return;
      case 'Error':
        return this.fail('provider_error');
      default:
        // Connected, Flushed (whichever turn it names), SessionMetadata, Configure*.
        return;
    }
  }

  /** Flux started its next turn: the oldest one Twring started and Flux had not. */
  private startTurn(speechId: string | undefined): void {
    const turn = this.unstarted.shift();
    this.current = turn;
    if (turn === undefined) return;
    turn.speechId = speechId;
    this.started.push(turn);
    if (this.started.length > STARTED_TURNS_KEPT) this.started.shift();
    // Flux handles messages in order: every Interrupt sent before this turn began is done with.
    let count = 0;
    while (
      count < this.pendingInterrupts.length &&
      this.pendingInterrupts[count]!.cutSeq < turn.seq
    ) {
      count += 1;
    }
    this.settle(count);
  }

  /** Flux confirmed an Interrupt: the one for the turn it names, else the oldest outstanding. */
  private interrupted(speechId: string | undefined): void {
    const named = speechId !== undefined ? this.byId(speechId) : undefined;
    let count = 1;
    if (named !== undefined) {
      count = 0;
      while (
        count < this.pendingInterrupts.length &&
        this.pendingInterrupts[count]!.cutSeq <= named.seq
      ) {
        count += 1;
      }
    }
    const cutSeq = count > 0 ? this.pendingInterrupts[count - 1]?.cutSeq : undefined;
    this.settle(count);
    // A cut turn whose SpeechStarted never came will not get one now: it is not the next turn.
    if (cutSeq === undefined) return;
    while (this.unstarted[0] !== undefined && this.unstarted[0].seq <= cutSeq) {
      this.unstarted.shift();
    }
  }

  private byId(speechId: string): Turn | undefined {
    return this.started.find((turn) => turn.speechId === speechId);
  }

  /** Settles the `count` oldest outstanding Interrupts. */
  private settle(count: number): void {
    if (count <= 0 || this.pendingInterrupts.length === 0) return;
    this.pendingInterrupts.splice(0, count);
    this.restartAckTimer();
  }

  /** Each outstanding Interrupt must be confirmed in time, or the session is dropped. */
  private restartAckTimer(): void {
    this.clearAckTimer();
    if (this.closing || this.pendingInterrupts.length === 0) return;
    this.stopAckTimer = this.after(() => {
      this.stopAckTimer = undefined;
      this.fail('provider_error');
    }, INTERRUPT_ACK_TIMEOUT_MS);
  }

  private clearAckTimer(): void {
    this.stopAckTimer?.();
    this.stopAckTimer = undefined;
  }

  private fail(code: 'protocol_error' | 'provider_error'): void {
    if (this.closing) return;
    const generationId = this.active?.generationId;
    this.closing = true;
    this.active = undefined;
    this.stopKeepalive();
    this.clearAckTimer();
    if (this.socket.isOpen) this.socket.close(1011);
    this.onEvent({ type: 'error', generationId, error: { code, recoverable: true } });
  }
}
