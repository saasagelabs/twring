/**
 * A phone call (or another app's call) during a Twring call. The system takes the microphone and
 * the audio route; when it gives them back, the Twring call must work again without the caller
 * doing anything (Signal and Jitsi handle it the same way).
 *
 * While interrupted the microphone is muted, so the agent never hears the other call. When the
 * interruption ends, the route is applied again and the microphone is unmuted, unless the caller
 * had muted it themselves before. iOS does not promise an "ended": when the app comes back to the
 * front and no phone call is on, the call resumes the same way (resumeWithoutEnd).
 */

export type InterruptionPhase = 'began' | 'ended';

export interface CallInterruptionPlatform {
  /** Undefined when the native module is missing: interruptions are then not detected. */
  watch?: (listener: (phase: InterruptionPhase) => void) => () => void;
  /** iOS only: whether a phone call that is not Twring's is still on. */
  otherCallActive?: () => Promise<boolean>;
}

export type InterruptionRecovery = 'ended' | 'foreground';

export interface CallInterruptionHooks {
  onRecovered?: (via: InterruptionRecovery) => void;
  /** The call ended while still paused. */
  onUnrecovered?: () => void;
  wait?: (ms: number) => Promise<void>;
}

/** Lets a real "ended" and WebRTC's own reactivation land before resuming on foreground. */
export const RESUME_DELAY_MS = 750;

export interface CallInterruptionTarget {
  isMuted(): boolean;
  setMuted(muted: boolean): Promise<void>;
  restoreRoute(): Promise<void>;
  /** Stops route writes while the phone call holds the audio; restoreRoute() ends the hold. */
  holdRoute?(): void;
}

export interface CallInterruptionState {
  paused: boolean;
}

export const INTERRUPTION_NOTICE = 'Paused for your phone call';

export class CallInterruption {
  private state: CallInterruptionState = { paused: false };
  /** The caller's own mute when the interruption began; restored as it was. */
  private mutedBefore = false;
  /** Counts interruptions, so a resume never ends one that began after it started. */
  private epoch = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly target: CallInterruptionTarget,
    private readonly onError: (detail: string) => void = () => undefined,
    private readonly hooks: CallInterruptionHooks = {},
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
        return this.end('ended');
    }
  }

  /**
   * The app is in front again with the call still paused and no "ended" (iOS does not promise
   * one). Unless a phone call is still on, resume as "ended" would. A failed check stays paused.
   */
  async resumeWithoutEnd(otherCallActive: () => Promise<boolean>): Promise<void> {
    if (!this.state.paused) return;
    const epoch = this.epoch;
    const wait = this.hooks.wait ?? defaultWait;
    await wait(RESUME_DELAY_MS);
    if (!this.state.paused || this.epoch !== epoch) return;
    let busy: boolean;
    try {
      busy = await otherCallActive();
    } catch {
      busy = true;
    }
    if (busy || !this.state.paused || this.epoch !== epoch) return;
    await this.end('foreground');
  }

  /** Forget the interruption when the call ends; nothing is unmuted or rerouted. */
  reset(): void {
    this.mutedBefore = false;
    if (this.state.paused) {
      this.callHook(() => this.hooks.onUnrecovered?.());
      this.set({ paused: false });
    }
  }

  private async begin(): Promise<void> {
    if (this.state.paused) return;
    this.epoch += 1;
    this.mutedBefore = this.target.isMuted();
    this.set({ paused: true });
    this.target.holdRoute?.();
    if (!this.mutedBefore) await this.guard(() => this.target.setMuted(true));
  }

  private async end(via: InterruptionRecovery): Promise<void> {
    if (!this.state.paused) return;
    this.set({ paused: false });
    await this.guard(() => this.target.restoreRoute());
    if (!this.mutedBefore && this.target.isMuted()) {
      await this.guard(() => this.target.setMuted(false));
    }
    this.callHook(() => this.hooks.onRecovered?.(via));
  }

  private callHook(hook: () => void): void {
    try {
      hook();
    } catch {
      // A telemetry hook never breaks the call.
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

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
