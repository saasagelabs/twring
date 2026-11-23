/**
 * A phone call (or another app's call) during a Twring call. The system takes the microphone and
 * the audio route; when it gives them back, the Twring call must work again without the caller
 * doing anything (Signal and Jitsi handle it the same way).
 *
 * While interrupted the microphone is muted, so the agent never hears the other call. When the
 * interruption ends, the route is applied again and the microphone is unmuted, unless the caller
 * had muted it themselves before.
 */

export type InterruptionPhase = 'began' | 'ended';

export interface CallInterruptionPlatform {
  /** Undefined when the native module is missing: interruptions are then not detected. */
  watch?: (listener: (phase: InterruptionPhase) => void) => () => void;
}

export interface CallInterruptionTarget {
  isMuted(): boolean;
  setMuted(muted: boolean): Promise<void>;
  restoreRoute(): Promise<void>;
}

export interface CallInterruptionState {
  paused: boolean;
}

export const INTERRUPTION_NOTICE = 'Paused for your phone call';

export class CallInterruption {
  private state: CallInterruptionState = { paused: false };
  /** The caller's own mute when the interruption began; restored as it was. */
  private mutedBefore = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly target: CallInterruptionTarget,
    private readonly onError: (detail: string) => void = () => undefined,
  ) {}

  getState = (): CallInterruptionState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Feeds a platform event in. Repeated events of the same phase are ignored. */
  handle(phase: InterruptionPhase): Promise<void> {
    switch (phase) {
      case 'began':
        return this.begin();
      case 'ended':
        return this.end();
    }
  }

  /** Forget the interruption when the call ends; nothing is unmuted or rerouted. */
  reset(): void {
    this.mutedBefore = false;
    if (this.state.paused) this.set({ paused: false });
  }

  private async begin(): Promise<void> {
    if (this.state.paused) return;
    this.mutedBefore = this.target.isMuted();
    this.set({ paused: true });
    if (!this.mutedBefore) await this.guard(() => this.target.setMuted(true));
  }

  private async end(): Promise<void> {
    if (!this.state.paused) return;
    this.set({ paused: false });
    await this.guard(() => this.target.restoreRoute());
    if (!this.mutedBefore && this.target.isMuted()) {
      await this.guard(() => this.target.setMuted(false));
    }
  }

  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.onError(error instanceof Error ? error.message : 'interruption handling failed');
    }
  }

  private set(state: CallInterruptionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
