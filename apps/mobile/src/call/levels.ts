import type { CallState } from '@twring/contracts';

import type { Timers } from './timers';

/**
 * Real audio levels for the call visualizer (UX_UI_SPEC §11), 0…1. `local` is this phone's
 * microphone, `remote` is the Twring gateway's voice track. Both come from LiveKit.
 */
export interface AudioLevels {
  local: number;
  remote: number;
}

export const SILENT_LEVELS: AudioLevels = { local: 0, remote: 0 };

/** ~12.5 Hz: smooth enough for bars, cheap enough to never compete with audio on the JS thread. */
export const LEVEL_INTERVAL_MS = 80;

const clamp = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * Throttled level store, kept apart from the call view so a level update re-renders only the
 * visualizer, never the whole call screen. Leading edge publishes at once; later samples inside the
 * interval collapse into one trailing publish of the latest value.
 */
export class CallLevels {
  private levels: AudioLevels = SILENT_LEVELS;
  private pending: AudioLevels | undefined;
  private lastPublished = Number.NEGATIVE_INFINITY;
  private cancelTrailing: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly timers: Timers,
    private readonly intervalMs = LEVEL_INTERVAL_MS,
  ) {}

  getLevels = (): AudioLevels => this.levels;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  push(sample: AudioLevels): void {
    const next = { local: clamp(sample.local), remote: clamp(sample.remote) };
    const elapsed = this.timers.now() - this.lastPublished;
    if (elapsed >= this.intervalMs && this.cancelTrailing === undefined) {
      this.publish(next);
      return;
    }
    this.pending = next;
    this.cancelTrailing ??= this.timers.setTimeout(
      () => {
        this.cancelTrailing = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending !== undefined) this.publish(pending);
      },
      Math.max(0, this.intervalMs - elapsed),
    );
  }

  /** Back to silence at once (call ended, reconnecting): no stale level may keep bars up. */
  reset(): void {
    this.cancelTrailing?.();
    this.cancelTrailing = undefined;
    this.pending = undefined;
    if (this.levels.local === 0 && this.levels.remote === 0) return;
    this.levels = SILENT_LEVELS;
    this.emit();
  }

  private publish(levels: AudioLevels): void {
    this.lastPublished = this.timers.now();
    if (levels.local === this.levels.local && levels.remote === this.levels.remote) return;
    this.levels = levels;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** What the visualizer shows, and which real signal (if any) drives it. */
export type VisualizerMode =
  /** Nothing to show yet (preparing, connecting, ending). */
  | { kind: 'idle' }
  /** Calm presence: the line is open, nobody is speaking. No level drives it. */
  | { kind: 'listening' }
  /** The caller is speaking: driven by the local microphone level. */
  | { kind: 'user'; signal: 'local' }
  /** The agent is thinking or acting: a quiet progress state, never a waveform. */
  | { kind: 'working' }
  /** The agent is speaking: driven by the gateway's audio track level. */
  | { kind: 'agent'; signal: 'remote' }
  | { kind: 'reconnecting' };

export function visualizerMode(state: CallState, muted: boolean): VisualizerMode {
  switch (state.status) {
    case 'LISTENING':
      return { kind: 'listening' };
    case 'USER_SPEAKING':
      // A muted mic sends silence; showing a waveform would lie.
      return muted ? { kind: 'listening' } : { kind: 'user', signal: 'local' };
    case 'AGENT_WORKING':
      return { kind: 'working' };
    case 'AGENT_SPEAKING':
      return { kind: 'agent', signal: 'remote' };
    case 'RECONNECTING':
      return { kind: 'reconnecting' };
    case 'IDLE':
    case 'PREPARING':
    case 'CONNECTING':
    case 'ENDING':
    case 'ENDED':
    case 'FAILED':
      return { kind: 'idle' };
  }
}

/** The level that drives `mode`, or 0 when the mode has no signal. */
export function drivingLevel(kind: VisualizerMode['kind'], levels: AudioLevels): number {
  switch (kind) {
    case 'user':
      return levels.local;
    case 'agent':
      return levels.remote;
    case 'idle':
    case 'listening':
    case 'working':
    case 'reconnecting':
      return 0;
  }
}
