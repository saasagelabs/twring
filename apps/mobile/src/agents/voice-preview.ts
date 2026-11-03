import type { Timers } from '../call/timers';

/** What one native player reports. */
export interface PreviewPlayerStatus {
  playing: boolean;
  finished: boolean;
  /** The native player could not play the sample. */
  failed?: boolean;
}

/** Platform seam over the audio player (expo-audio in the app, a fake in tests). */
export interface PreviewPlayerFactory {
  create(
    uri: string,
    onStatus: (status: PreviewPlayerStatus) => void,
  ): { play(): void; release(): void };
}

export type VoicePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; voiceId: string }
  | { status: 'playing'; voiceId: string }
  /** The sample could not be played; the picker says so on that voice's row. */
  | { status: 'failed'; voiceId: string; message?: string };

/** A sample that hasn't started by now isn't coming (first synthesis can take a few seconds). */
export const PREVIEW_START_TIMEOUT_MS = 12_000;

/**
 * One voice sample at a time. Tapping the playing voice stops it; tapping another switches. Every
 * way out (finish, stop, leaving the screen, starting a call) releases the native player.
 */
export class VoicePreview {
  private state: VoicePreviewState = { status: 'idle' };
  private player: { play(): void; release(): void } | undefined;
  private cancelTimeout: (() => void) | undefined;
  /** Bumped on every start/stop: status from a released player is ignored. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly factory: PreviewPlayerFactory,
    private readonly sampleUrl: (voiceId: string) => string | undefined,
    private readonly timers: Timers,
    /** Why a failed sample failed when the server said (a refused own key); undefined if unknown. */
    private readonly probeFailure?: (voiceId: string) => Promise<string | undefined>,
  ) {}

  getState = (): VoicePreviewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Play `voiceId`'s sample, or stop it if it is the one loading or playing. */
  toggle(voiceId: string): void {
    const current = this.state;
    if (
      (current.status === 'loading' || current.status === 'playing') &&
      current.voiceId === voiceId
    ) {
      this.stop();
      return;
    }
    this.play(voiceId);
  }

  play(voiceId: string): void {
    this.release();
    const generation = ++this.generation;
    const uri = this.sampleUrl(voiceId);
    if (uri === undefined) {
      this.set({ status: 'failed', voiceId });
      return;
    }
    this.set({ status: 'loading', voiceId });
    this.cancelTimeout = this.timers.setTimeout(() => {
      if (generation !== this.generation || this.state.status !== 'loading') return;
      this.release();
      // The app's own wait ran out: the server may still be making the sample, so asking again
      // would only start a second one. Plain failure copy.
      this.set({ status: 'failed', voiceId });
    }, PREVIEW_START_TIMEOUT_MS);
    try {
      this.player = this.factory.create(uri, (status) => {
        if (generation !== this.generation) return;
        if (status.failed === true) {
          this.release();
          this.fail(voiceId, generation);
        } else if (status.finished) {
          this.release();
          this.set({ status: 'idle' });
        } else if (status.playing && this.state.status === 'loading') {
          this.clearTimeout();
          this.set({ status: 'playing', voiceId });
        }
      });
      this.player.play();
    } catch {
      this.release();
      this.set({ status: 'failed', voiceId });
    }
  }

  /** Shows the failure now, then adds the server's reason if the probe finds one. */
  private fail(voiceId: string, generation: number): void {
    this.set({ status: 'failed', voiceId });
    const probe = this.probeFailure;
    if (probe === undefined) return;
    void probe(voiceId).then(
      (message) => {
        if (message === undefined || generation !== this.generation) return;
        if (this.state.status !== 'failed' || this.state.voiceId !== voiceId) return;
        this.set({ status: 'failed', voiceId, message });
      },
      () => undefined,
    );
  }

  /** Stops and releases any sample. Idempotent. */
  stop(): void {
    this.generation += 1;
    this.release();
    if (this.state.status !== 'idle') this.set({ status: 'idle' });
  }

  private release(): void {
    this.clearTimeout();
    const player = this.player;
    this.player = undefined;
    try {
      player?.release();
    } catch {
      // Already gone.
    }
  }

  private clearTimeout(): void {
    this.cancelTimeout?.();
    this.cancelTimeout = undefined;
  }

  private set(state: VoicePreviewState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
