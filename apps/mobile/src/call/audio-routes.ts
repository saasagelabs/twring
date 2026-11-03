/** Where call audio plays. Android names from LiveKit's AudioSession.getAudioOutputs(). */
export type AudioOutput = 'bluetooth' | 'headset' | 'speaker' | 'earpiece';

/** Automatic choice order: a headset the caller connected wins; otherwise speaker (UX §15). */
export const ROUTE_PREFERENCE: readonly AudioOutput[] = [
  'bluetooth',
  'headset',
  'speaker',
  'earpiece',
];

const PRIVATE: ReadonlySet<AudioOutput> = new Set(['bluetooth', 'headset']);

/** Known outputs in preference order; unknown names from the platform are ignored. */
export function parseOutputs(raw: readonly string[]): AudioOutput[] {
  if (raw.includes('default') && raw.includes('force_speaker')) return ['speaker', 'earpiece'];
  return ROUTE_PREFERENCE.filter((output) => raw.includes(output));
}

/**
 * The iOS audio session for each choice. Neither forces a port, so a connected Bluetooth or wired
 * headset still takes over: Speaker is the video-chat mode with defaultToSpeaker (the call's start,
 * as before), Phone is the voice-chat mode, which uses the earpiece when nothing is connected.
 */
export function iosAudioConfiguration(output: AudioOutput): {
  audioCategory: 'playAndRecord';
  audioCategoryOptions: (
    'allowBluetooth' | 'allowBluetoothA2DP' | 'allowAirPlay' | 'defaultToSpeaker'
  )[];
  audioMode: 'videoChat' | 'voiceChat';
} {
  const speaker = output === 'speaker';
  return {
    audioCategory: 'playAndRecord',
    audioCategoryOptions: [
      'allowBluetooth',
      'allowBluetoothA2DP',
      'allowAirPlay',
      ...(speaker ? (['defaultToSpeaker'] as const) : []),
    ],
    audioMode: speaker ? 'videoChat' : 'voiceChat',
  };
}

/**
 * The route to use after the available outputs changed. A newly connected Bluetooth or wired
 * headset takes over; a route that disappeared falls back to the best remaining one; otherwise the
 * current (possibly manual) choice stays.
 */
export function nextRoute(
  previous: readonly AudioOutput[],
  outputs: readonly AudioOutput[],
  current: AudioOutput | undefined,
): AudioOutput | undefined {
  const arrived = outputs.find((output) => PRIVATE.has(output) && !previous.includes(output));
  if (arrived !== undefined) return arrived;
  if (current !== undefined && outputs.includes(current)) return current;
  return outputs[0];
}

export function routeLabel(output: AudioOutput): string {
  switch (output) {
    case 'bluetooth':
      return 'Bluetooth';
    case 'headset':
      return 'Headphones';
    case 'speaker':
      return 'Speaker';
    case 'earpiece':
      return 'Phone';
  }
}

export interface AudioRoutePlatform {
  /** Available outputs. Requires a started audio session. */
  list(): Promise<readonly string[]>;
  select(output: AudioOutput): Promise<void>;
}

export interface AudioRouteState {
  outputs: readonly AudioOutput[];
  current?: AudioOutput;
}

/**
 * Tracks and switches the call's audio output. Route changes never touch the call itself (no
 * reconnect): only the audio session's output moves. Calls are serialized so a poll can't undo a tap.
 */
export class AudioRoutes {
  private state: AudioRouteState = { outputs: [] };
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by reset(); work queued or in flight from an older call never selects or sets state. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly platform: AudioRoutePlatform,
    private readonly onError: (detail: string) => void = () => undefined,
  ) {}

  getState = (): AudioRouteState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Re-reads the outputs and applies the automatic policy. */
  refresh(): Promise<void> {
    return this.enqueue(async (live) => {
      const listed = await this.platform.list();
      if (!live()) return;
      const outputs = parseOutputs(listed);
      const current = nextRoute(this.state.outputs, outputs, this.state.current);
      if (current !== undefined && current !== this.state.current) {
        await this.platform.select(current);
      }
      if (!live()) return;
      this.set({ outputs, ...(current !== undefined && { current }) });
    });
  }

  /** The caller picked an output. */
  choose(output: AudioOutput): Promise<void> {
    return this.enqueue(async (live) => {
      if (!this.state.outputs.includes(output)) return;
      await this.platform.select(output);
      if (!live()) return;
      this.set({ ...this.state, current: output });
    });
  }

  /** Forget everything when the call ends. */
  reset(): void {
    this.generation += 1;
    this.set({ outputs: [] });
  }

  private enqueue(task: (live: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.generation;
    const live = () => generation === this.generation;
    this.queue = this.queue
      .then(() => (live() ? task(live) : undefined))
      .catch((error: unknown) => {
        this.onError(error instanceof Error ? error.message : 'route change failed');
      });
    return this.queue;
  }

  private set(state: AudioRouteState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
