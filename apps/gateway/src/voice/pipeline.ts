import { FRAME_MS, SAMPLES_PER_FRAME, peakDbfs } from '../audio/pcm';
import { Downsampler48To16, FrameAssembler } from '../audio/resample';
import type { CallLogger } from '../calls/runtime';
import type { Scheduler } from '../calls/scheduler';

import {
  VoiceProviderError,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';

/** Longest caption sent to the phone; status packets are size-capped. */
export const MAX_CAPTION_CHARS = 1500;

/** Reconnect delays after a recoverable provider drop; then the call is reported as failed. */
const RECONNECT_DELAYS_MS = [250, 1000, 3000] as const;
/**
 * A reconnected session counts as healthy (its retry budget is restored) only after staying up
 * this long, so a provider that accepts and then drops at once cannot reconnect-storm forever.
 */
export const RECONNECT_STABLE_MS = 10_000;

/** A caller frame peaking above this while the agent speaks counts as the caller's voice onset. */
export const VOICE_ONSET_DBFS = -35;
/** The onset is forgotten once the caller has stayed below the threshold this long. */
const VOICE_ONSET_RESET_MS = 300;

/** Playout bookkeeping is kept for this many recent generations (echo window lookups). */
const PLAYOUT_HISTORY = 8;

/**
 * STT providers close a stream that receives no audio for about 10 s (Deepgram's documented idle
 * timeout). Caller frames stop while the phone is muted or away (rejoin grace), so after this long
 * without audio the pipeline sends a short run of silence: plain audio, which every Flux model
 * accepts, and which can never start a turn.
 */
export const STT_IDLE_KEEPALIVE_MS = 4_000;
/** 100 ms of 16 kHz silence per keepalive. */
const STT_KEEPALIVE_SAMPLES = 1600;
const STT_SAMPLE_RATE = 16_000;
/** TTS delivers 48 kHz mono linear16: 96 000 bytes per second. */
const TTS_BYTES_PER_SECOND = 96_000;

/** Provider usage of one pipeline, for the call's usage summary. */
export interface VoiceUsage {
  sttAudioMs: number;
  sttConnectedMs: number;
  ttsChars: number;
  ttsAudioMs: number;
  sttReconnects: number;
  ttsReconnects: number;
}

/** Why a speech generation was cancelled, for telemetry. */
export type SpeechCancelReason = 'barge_in' | 'superseded' | 'call_ended' | 'replaced' | 'failed';

export interface VoicePipelineOptions {
  callId: string;
  stt: SttProvider;
  tts: TtsProvider;
  scheduler: Scheduler;
  logger: CallLogger;
  /** STT is confident the caller started a turn. */
  onUserSpeechStarted: () => void;
  /** A turn started but ended without any words (noise, a cough): nothing to commit. */
  onUserSpeechDiscarded: () => void;
  /** Live, uncommitted words of the caller's turn (echo rejection confirms barge-in on these). */
  onUserPartial?: (text: string) => void;
  /** The caller yielded the floor; `text` is the committed turn. */
  onUserTurn: (text: string) => void;
  /** Live caption for the phone. `final` marks a committed user turn. */
  onCaption: (caption: { turnIndex: number; text: string; final: boolean }) => void;
  /**
   * A speech generation's audio: `playing` when its first frame is published, `finished` after its
   * last, `failed` when the provider lost it. A cancelled generation reports nothing further.
   */
  onSpeech: (speech: { generationId: string; state: 'playing' | 'finished' | 'failed' }) => void;
  /**
   * Queue 20 ms, 48 kHz frames for publication. `onFirstPublished` runs when the first frame is
   * handed off, `onLastPublished` when the last of these frames is; `onDone` runs once everything
   * queued so far (including these frames) has been.
   */
  playFrames: (
    frames: Int16Array[],
    callbacks: {
      onFirstPublished?: () => void;
      onLastPublished?: () => void;
      onDone?: () => void;
    },
  ) => void;
  /** Drops all queued speech audio; returns how many 20 ms frames were dropped. */
  stopPlayback: () => number;
  /** Development diagnostics: sees exactly what STT receives, and each committed turn. */
  capture?: { write(samples: Int16Array): void; caption(turnIndex: number, text: string): void };
  /** Voice can no longer work for this call (e.g. rejected key, reconnects exhausted). */
  onFatal: (error: VoiceError, which: 'stt' | 'tts') => void;
}

/**
 * Speech in, speech out for one call: caller audio → STT → committed turns out; streamed text in →
 * TTS → frames to play. Owns both provider sessions, their reconnects, and one speech generation at
 * a time. What to say is decided elsewhere (the conversation controller).
 */
export class VoicePipeline {
  private readonly controller = new AbortController();
  private readonly downsampler = new Downsampler48To16();
  private readonly assembler = new FrameAssembler();
  private stt: SttSession | undefined;
  private tts: TtsSession | undefined;
  private reconnecting = { stt: false, tts: false };
  private attempts = { stt: 0, tts: 0 };
  private generation = 0;
  /** Scheduler time the caller's voice first rose over the active speech (barge-in latency origin). */
  private onsetAt: number | undefined;
  private quietFrames = 0;
  /** STT reported the caller started a turn it has not yet committed or discarded. */
  private callerSpeaking = false;
  /** When the caller's current turn started, and when its words last changed (turn timing). */
  private turnStartedAt: number | undefined;
  private wordsChangedAt: number | undefined;
  private active:
    | {
        id: string;
        /** When the user turn this speech answers was committed (latency origin). */
        committedAt: number;
        textSent: boolean;
        /** When the first text reached TTS (the "first useful agent text → audio" SLO origin). */
        firstTextAt: number;
        ended: boolean;
        /** TTS delivered every byte; audio may still be queued for playout. */
        providerDone: boolean;
        cancelled: boolean;
        firstAudioLogged: boolean;
        playingSent: boolean;
        firstPublishedLogged: boolean;
      }
    | undefined;
  /** Per generation: frames played out, and frames in total once TTS delivered them all. */
  private readonly playout = new Map<
    string,
    { playedFrames: number; queuedFrames?: number; totalFrames?: number }
  >();
  private closed = false;
  /** Bumped when a provider session is dropped: events from an older session are ignored. */
  private readonly sessionSeq = { stt: 0, tts: 0 };
  /**
   * Highest turn index the current STT session ended (committed or discarded). Flux numbers turns
   * per connection, so this resets with each session; a repeated EndOfTurn is ignored.
   */
  private lastEndedTurn: number | undefined;
  private readonly cancelTimers = new Set<() => void>();
  private lastSttAudioAt = 0;
  private sttSamplesSent = 0;
  private sttOpenedAt: number | undefined;
  private sttConnectedMs = 0;
  private ttsChars = 0;
  private ttsBytes = 0;
  private readonly reconnects = { stt: 0, tts: 0 };
  /** Scheduler time of each provider's last successful reconnect. */
  private readonly reconnectedAt: { stt: number | undefined; tts: number | undefined } = {
    stt: undefined,
    tts: undefined,
  };

  constructor(private readonly options: VoicePipelineOptions) {}

  /** Opens both providers. Rejects with VoiceProviderError when either cannot connect. */
  async start(): Promise<void> {
    const seqAtStart = { ...this.sessionSeq };
    const [stt, tts] = await Promise.allSettled([
      this.openInitially('stt', () => this.openStt()),
      this.openInitially('tts', () => this.openTts()),
    ]);
    if (this.closed) {
      await Promise.all([
        stt.status === 'fulfilled' ? stt.value.close() : undefined,
        tts.status === 'fulfilled' ? tts.value.close() : undefined,
      ]);
      return;
    }
    if (stt.status === 'fulfilled' && tts.status === 'fulfilled') {
      // A session that failed while the other side was still retrying was already dropped and its
      // reconnect scheduled; keeping it here would overwrite (or outlive) the replacement.
      if (this.sessionSeq.stt === seqAtStart.stt) this.setStt(stt.value);
      else void stt.value.close().catch(() => undefined);
      if (this.sessionSeq.tts === seqAtStart.tts) this.tts = tts.value;
      else void tts.value.close().catch(() => undefined);
      const cancelKeepalive = this.options.scheduler.setInterval(
        () => this.keepSttAlive(),
        STT_IDLE_KEEPALIVE_MS / 2,
      );
      this.cancelTimers.add(cancelKeepalive);
      return;
    }
    // One side failed: close whichever side did connect so no provider socket is left open.
    await Promise.all([
      stt.status === 'fulfilled' ? stt.value.close() : undefined,
      tts.status === 'fulfilled' ? tts.value.close() : undefined,
    ]);
    const which = stt.status === 'rejected' ? 'stt' : 'tts';
    const reason: unknown =
      stt.status === 'rejected' ? stt.reason : (tts as PromiseRejectedResult).reason;
    if (reason instanceof VoiceProviderError) reason.side = which;
    throw reason;
  }

  private async openInitially<T>(which: 'stt' | 'tts', open: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await open();
      } catch (error) {
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (
          this.closed ||
          !(error instanceof VoiceProviderError) ||
          !error.error.recoverable ||
          delay === undefined
        )
          throw error;
        this.log(`${which}_connect_retry`, { attempt: attempt + 1 });
        await new Promise<void>((resolve) => {
          const cancel = this.options.scheduler.setTimeout(() => {
            this.cancelTimers.delete(cancel);
            this.controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, delay);
          const onAbort = () => {
            cancel();
            this.cancelTimers.delete(cancel);
            resolve();
          };
          this.cancelTimers.add(cancel);
          this.controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        if (this.closed) throw error;
      }
    }
  }

  /** One 20 ms, 48 kHz frame of caller audio. */
  pushCallerAudio(samples: Int16Array): void {
    if (this.closed || this.stt === undefined) return;
    this.trackOnset(samples);
    const downsampled = this.downsampler.process(samples);
    this.options.capture?.write(downsampled);
    this.sendStt(this.stt, downsampled);
  }

  /** Provider usage so far (session time counts up to now while a session is open). */
  usage(): VoiceUsage {
    const openMs =
      this.sttOpenedAt === undefined ? 0 : this.options.scheduler.now() - this.sttOpenedAt;
    return {
      sttAudioMs: (this.sttSamplesSent / STT_SAMPLE_RATE) * 1000,
      sttConnectedMs: this.sttConnectedMs + openMs,
      ttsChars: this.ttsChars,
      ttsAudioMs: (this.ttsBytes / TTS_BYTES_PER_SECOND) * 1000,
      sttReconnects: this.reconnects.stt,
      ttsReconnects: this.reconnects.tts,
    };
  }

  /** Test/diagnostic view of per-call state that must stay bounded however long the call runs. */
  retainedState(): { playout: number; timers: number } {
    return { playout: this.playout.size, timers: this.cancelTimers.size };
  }

  private sendStt(session: SttSession, samples: Int16Array): void {
    session.sendAudio(samples);
    this.sttSamplesSent += samples.length;
    this.lastSttAudioAt = this.options.scheduler.now();
  }

  /** Silence to an STT session that has had no caller audio for a while (STT_IDLE_KEEPALIVE_MS). */
  private keepSttAlive(): void {
    if (this.closed || this.stt === undefined) return;
    if (this.options.scheduler.now() - this.lastSttAudioAt < STT_IDLE_KEEPALIVE_MS) return;
    this.sendStt(this.stt, new Int16Array(STT_KEEPALIVE_SAMPLES));
  }

  private setStt(session: SttSession): void {
    this.stt = session;
    this.sttOpenedAt = this.options.scheduler.now();
    this.lastSttAudioAt = this.sttOpenedAt;
    this.lastEndedTurn = undefined;
  }

  /** The current STT session is gone: its open time is banked. */
  private dropStt(): void {
    if (this.sttOpenedAt !== undefined) {
      this.sttConnectedMs += this.options.scheduler.now() - this.sttOpenedAt;
      this.sttOpenedAt = undefined;
    }
    this.stt = undefined;
  }

  /**
   * Starts a new speech generation (cancelling any in progress) and returns its ID. `committedAt`
   * is the scheduler time the answered user turn was committed, for latency telemetry.
   */
  beginSpeech(committedAt: number): string {
    this.cancelSpeech('replaced');
    this.generation += 1;
    const id = `gen_${this.generation}`;
    this.active = {
      id,
      committedAt,
      textSent: false,
      firstTextAt: 0,
      ended: false,
      providerDone: false,
      cancelled: false,
      firstAudioLogged: false,
      playingSent: false,
      firstPublishedLogged: false,
    };
    this.assembler.clear();
    this.playout.set(id, { playedFrames: 0 });
    for (const old of this.playout.keys()) {
      if (this.playout.size <= PLAYOUT_HISTORY) break;
      this.playout.delete(old);
    }
    return id;
  }

  /** Audio of generation `id` played out so far, in ms (0 once forgotten). */
  playedMs(id: string): number {
    return (this.playout.get(id)?.playedFrames ?? 0) * FRAME_MS;
  }

  /** Generation `id`'s whole audio length, once TTS has delivered all of it. */
  totalAudioMs(id: string): number | undefined {
    const total = this.playout.get(id)?.totalFrames;
    return total === undefined ? undefined : total * FRAME_MS;
  }

  /** Streams more text into generation `id`. Ignored once it is no longer the active one. */
  appendSpeech(id: string, text: string): void {
    const active = this.active;
    if (active?.id !== id || active.ended || text === '') return;
    if (this.tts === undefined) {
      // TTS is reconnecting: this generation cannot complete; the caller moves on without it.
      this.failSpeech(active);
      return;
    }
    this.tts.speak(id, text);
    this.ttsChars += text.length;
    if (!active.textSent) {
      active.textSent = true;
      active.firstTextAt = this.options.scheduler.now();
      this.log('tts_first_text_enqueued', {
        generation_id: id,
        duration_ms: this.elapsed(active.committedAt),
      });
    }
  }

  /** No more text for generation `id`; it finishes once its audio has played out. */
  endSpeech(id: string): void {
    const active = this.active;
    if (active?.id !== id || active.ended) return;
    active.ended = true;
    if (!active.textSent) {
      this.active = undefined;
      this.options.onSpeech({ generationId: id, state: 'finished' });
      return;
    }
    this.tts?.flush(id);
  }

  /** Stops any speech in progress: generation cancelled, queued audio dropped. */
  cancelSpeech(reason: SpeechCancelReason): void {
    const active = this.active;
    if (active === undefined) return;
    this.active = undefined;
    this.resetOnset();
    active.cancelled = true;
    this.tts?.cancel(active.id);
    const partialSamples = this.assembler.pendingSamples;
    this.assembler.clear();
    const droppedFrames = this.options.stopPlayback();
    this.log('tts_cancelled', { generation_id: active.id, reason });
    if (reason === 'barge_in') {
      // How much synthesized speech the barge-in cut off before the caller heard it.
      const droppedMs = droppedFrames * FRAME_MS + (partialSamples / SAMPLES_PER_FRAME) * FRAME_MS;
      this.log('tts_stopped', { generation_id: active.id, dropped_ms: Math.round(droppedMs) });
    }
  }

  /**
   * Scheduler time the caller's voice first rose over the speech in progress, if it has and has not
   * gone quiet again since. Barge-in telemetry measures detection latency from here.
   */
  callerOnsetAt(): number | undefined {
    return this.onsetAt;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.active = undefined;
    for (const cancel of this.cancelTimers) cancel();
    this.cancelTimers.clear();
    const stt = this.stt;
    this.dropStt();
    await Promise.all([stt?.close(), this.tts?.close()]);
  }

  /** Frame-level voice onset, tracked only while speech is active (it is barge-in telemetry). */
  private trackOnset(samples: Int16Array): void {
    if (this.active === undefined) {
      this.resetOnset();
      return;
    }
    if (peakDbfs(samples) > VOICE_ONSET_DBFS) {
      this.onsetAt ??= this.options.scheduler.now();
      this.quietFrames = 0;
      return;
    }
    if (this.onsetAt === undefined) return;
    this.quietFrames += 1;
    if (this.quietFrames * FRAME_MS >= VOICE_ONSET_RESET_MS) this.resetOnset();
  }

  private resetOnset(): void {
    this.onsetAt = undefined;
    this.quietFrames = 0;
  }

  private openStt(): Promise<SttSession> {
    const seq = this.sessionSeq.stt;
    return this.options.stt.open((event) => {
      if (seq === this.sessionSeq.stt) this.onStt(event);
    }, this.controller.signal);
  }

  private openTts(): Promise<TtsSession> {
    const seq = this.sessionSeq.tts;
    return this.options.tts.open((event) => {
      if (seq === this.sessionSeq.tts) this.onTts(event);
    }, this.controller.signal);
  }

  private onStt(event: SttEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'speech_started':
        this.log('user_speech_started', { turn_index: event.turnIndex });
        this.turnStartedAt = this.options.scheduler.now();
        this.wordsChangedAt = undefined;
        this.callerSpeaking = true;
        this.options.onUserSpeechStarted();
        return;
      case 'speech_discarded':
        if (this.repeatedEnd(event.turnIndex)) return;
        this.log('user_speech_discarded', { turn_index: event.turnIndex });
        this.turnStartedAt = undefined;
        this.wordsChangedAt = undefined;
        this.callerSpeaking = false;
        this.options.onUserSpeechDiscarded();
        return;
      case 'partial':
        this.wordsChangedAt = this.options.scheduler.now();
        this.options.onCaption({
          turnIndex: event.turnIndex,
          text: clip(event.text),
          final: false,
        });
        this.options.onUserPartial?.(event.text);
        return;
      case 'turn_ended':
        // A repeated EndOfTurn (provider retry, duplicate frame) must never commit a turn twice.
        if (this.repeatedEnd(event.turnIndex)) return;
        this.log('turn_committed', {
          turn_index: event.turnIndex,
          text_chars: event.text.length,
          words: event.text
            .trim()
            .split(/\s+/)
            .filter((word) => word !== '').length,
          // How long the caller spoke, and how long the words had stopped changing before the turn
          // ended: a long turn of speech, or a long wait after it.
          ...this.turnTiming(),
        });
        this.callerSpeaking = false;
        this.options.onCaption({ turnIndex: event.turnIndex, text: clip(event.text), final: true });
        this.options.capture?.caption(event.turnIndex, event.text);
        this.options.onUserTurn(event.text);
        return;
      case 'error':
        this.handleProviderError('stt', event.error);
        return;
    }
  }

  private turnTiming(): { speech_ms?: number; quiet_ms?: number } {
    const now = this.options.scheduler.now();
    const timing = {
      ...(this.turnStartedAt !== undefined && { speech_ms: Math.round(now - this.turnStartedAt) }),
      ...(this.wordsChangedAt !== undefined && { quiet_ms: Math.round(now - this.wordsChangedAt) }),
    };
    this.turnStartedAt = undefined;
    this.wordsChangedAt = undefined;
    return timing;
  }

  /** Records that this session ended `turnIndex`; true if it (or a later turn) already ended. */
  private repeatedEnd(turnIndex: number): boolean {
    if (this.lastEndedTurn !== undefined && turnIndex <= this.lastEndedTurn) {
      this.log('stt_duplicate_end_ignored', { turn_index: turnIndex });
      return true;
    }
    this.lastEndedTurn = turnIndex;
    return false;
  }

  private onTts(event: TtsEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case 'audio': {
        this.ttsBytes += event.bytes.length;
        const active = this.active;
        // Late audio from a cancelled generation, or stray bytes after this one completed.
        if (active === undefined || event.generationId !== active.id || active.providerDone) return;
        if (!active.firstAudioLogged) {
          active.firstAudioLogged = true;
          this.log('tts_first_audio', {
            generation_id: active.id,
            duration_ms: this.elapsed(active.committedAt),
            after_text_ms: this.elapsed(active.firstTextAt),
          });
        }
        this.play(active, this.assembler.push(event.bytes));
        return;
      }
      case 'done': {
        const active = this.active;
        if (active === undefined || event.generationId !== active.id || active.providerDone) return;
        // Stays active until its queued audio has played, so a new turn can still cut it off.
        active.providerDone = true;
        this.log('tts_done', { generation_id: active.id });
        this.play(active, this.assembler.flush(), () => {
          if (active.cancelled) return;
          if (this.active === active) this.active = undefined;
          this.options.onSpeech({ generationId: active.id, state: 'finished' });
        });
        return;
      }
      case 'error': {
        const active = this.active;
        // An error naming no generation (or another one) still means one TTS hasn't finished
        // delivering cannot complete; fail it so the turn doesn't wait on audio that won't come.
        if (active !== undefined && (event.generationId === active.id || !active.providerDone))
          this.failSpeech(active);
        this.handleProviderError('tts', event.error);
        return;
      }
      case 'generation_error': {
        // Only this answer failed; the session is healthy, so no reconnect is spent (ADR-022).
        this.options.logger.warn(
          {
            event: 'tts_generation_error',
            call_id: this.options.callId,
            generation_id: event.generationId,
            error_code: event.error.code,
          },
          'voice provider generation error',
        );
        const active = this.active;
        if (active !== undefined && event.generationId === active.id && !active.providerDone)
          this.failSpeech(active);
        return;
      }
    }
  }

  private play(
    active: NonNullable<VoicePipeline['active']>,
    frames: Int16Array[],
    onDone?: () => void,
  ): void {
    if (frames.length === 0 && onDone === undefined) return;
    const playout = this.playout.get(active.id);
    if (playout !== undefined) {
      playout.queuedFrames = (playout.queuedFrames ?? 0) + frames.length;
      if (active.providerDone) playout.totalFrames = playout.queuedFrames;
    }
    this.options.playFrames(frames, {
      ...(onDone && { onDone }),
      ...(frames.length > 0 &&
        playout !== undefined && {
          onLastPublished: () => {
            playout.playedFrames += frames.length;
          },
        }),
      onFirstPublished: () => {
        // Each audio chunk carries this callback; only the generation's first frame counts.
        if (active.firstPublishedLogged) return;
        active.firstPublishedLogged = true;
        if (!active.playingSent && !active.cancelled) {
          active.playingSent = true;
          this.options.onSpeech({ generationId: active.id, state: 'playing' });
        }
        this.log('audio_first_published', {
          generation_id: active.id,
          duration_ms: this.elapsed(active.committedAt),
        });
      },
    });
  }

  private failSpeech(active: NonNullable<VoicePipeline['active']>): void {
    this.cancelSpeech('failed');
    this.options.onSpeech({ generationId: active.id, state: 'failed' });
  }

  private handleProviderError(which: 'stt' | 'tts', error: VoiceError): void {
    this.options.logger.warn(
      { event: `${which}_error`, call_id: this.options.callId, error_code: error.code },
      'voice provider error',
    );
    if (which === 'stt' && this.callerSpeaking) {
      // The utterance in progress died with the STT session: neither a commit nor a discard will
      // come for it, so treat it as discarded and let the floor (and any held answer) move on.
      this.callerSpeaking = false;
      this.turnStartedAt = undefined;
      this.wordsChangedAt = undefined;
      this.log('user_speech_discarded', { reason: 'stt_error' });
      this.options.onUserSpeechDiscarded();
    }
    if (!error.recoverable) {
      this.options.onFatal(error, which);
      return;
    }
    if (this.reconnecting[which]) return;
    const since = this.reconnectedAt[which];
    if (since !== undefined && this.options.scheduler.now() - since >= RECONNECT_STABLE_MS) {
      this.attempts[which] = 0;
    }
    const delay = RECONNECT_DELAYS_MS[this.attempts[which]];
    if (delay === undefined) {
      this.options.onFatal({ code: error.code, recoverable: false }, which);
      return;
    }
    this.attempts[which] += 1;
    this.reconnecting[which] = true;
    // The failed session is closed and silenced: it can no longer commit a turn, play audio, or
    // report a second error that would start another reconnect.
    this.sessionSeq[which] += 1;
    const stale = which === 'stt' ? this.stt : this.tts;
    if (which === 'stt') this.dropStt();
    else this.tts = undefined;
    void stale?.close().catch(() => undefined);
    const cancel = this.options.scheduler.setTimeout(() => {
      this.cancelTimers.delete(cancel);
      void this.reconnect(which);
    }, delay);
    this.cancelTimers.add(cancel);
  }

  private async reconnect(which: 'stt' | 'tts'): Promise<void> {
    if (this.closed) return;
    try {
      if (which === 'stt') {
        const session = await this.openStt();
        if (this.closed) {
          // Hung up while reconnecting: the new session must not outlive the call.
          await session.close();
          return;
        }
        this.downsampler.reset();
        this.setStt(session);
      } else {
        const session = await this.openTts();
        if (this.closed) {
          await session.close();
          return;
        }
        this.tts = session;
      }
      this.reconnects[which] += 1;
      this.reconnectedAt[which] = this.options.scheduler.now();
      this.log(`${which}_reconnected`);
    } catch (error) {
      if (this.closed) return;
      this.reconnecting[which] = false;
      const voiceError =
        error instanceof VoiceProviderError
          ? error.error
          : { code: 'connection_lost' as const, recoverable: true };
      this.handleProviderError(which, voiceError);
      return;
    }
    this.reconnecting[which] = false;
  }

  private elapsed(since: number): number {
    return Math.round(this.options.scheduler.now() - since);
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.options.logger.info({ event, call_id: this.options.callId, ...fields });
  }
}

function clip(text: string): string {
  return text.length <= MAX_CAPTION_CHARS ? text : `…${text.slice(-MAX_CAPTION_CHARS + 1)}`;
}
