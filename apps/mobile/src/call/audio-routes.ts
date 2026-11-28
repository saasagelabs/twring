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
 * Call outputs from the Android communication devices (modules/twring-audio-route). Bluetooth
 * counts only as a headset with a call (SCO or LE Audio) link: an A2DP-only speaker or car stereo
 * has no microphone, so routing a call to it leaves the mic on the phone.
 */
export function outputsFromDevices(devices: readonly string[]): AudioOutput[] {
  const outputs = new Set<AudioOutput>();
  for (const device of devices) {
    switch (device) {
      case 'bluetooth_sco':
      case 'ble_headset':
        outputs.add('bluetooth');
        break;
      case 'wired_headset':
      case 'wired_headphones':
      case 'usb_headset':
        outputs.add('headset');
        break;
      case 'speaker':
        outputs.add('speaker');
        break;
      case 'earpiece':
        outputs.add('earpiece');
        break;
    }
  }
  return ROUTE_PREFERENCE.filter((output) => outputs.has(output));
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
 * The route to use after the available outputs changed. A choice the caller made sticks while its
 * device is still there (Jitsi and twilio/audioswitch keep the user-selected device the same way).
 * Otherwise a newly connected Bluetooth or wired headset takes over; a route that disappeared falls
 * back to the best remaining one; otherwise the current choice stays.
 */
export function nextRoute(
  previous: readonly AudioOutput[],
  outputs: readonly AudioOutput[],
  current: AudioOutput | undefined,
  manual = false,
): AudioOutput | undefined {
  if (manual && current !== undefined && outputs.includes(current)) return current;
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

/** The one line the call screen shows when a switch did not land (the sound stayed elsewhere). */
export function routeFailureText(failed: AudioOutput): string {
  if (failed === 'speaker' || failed === 'earpiece') {
    return `Couldn't switch to ${routeLabel(failed)}. Your headset is holding the sound, turn its Bluetooth off to switch.`;
  }
  return `Couldn't switch to ${routeLabel(failed)}.`;
}

/** Whether the sound really moved; `actual` is the OS read-back (null = none or unknown). */
export type RouteResult = { ok: true } | { ok: false; actual: AudioOutput | null };

export interface AudioRoutePlatform {
  /** Available outputs. Requires a started audio session. */
  list(): Promise<readonly string[]>;
  select(output: AudioOutput): Promise<RouteResult>;
  /** The route the OS reports now; null when unknown (then always select). */
  current?(): Promise<AudioOutput | null>;
  /** Call end: drops the route this call set, unless a newer call has set one since. */
  release?(): Promise<void>;
  /**
   * Calls `onChange` whenever the platform's routes change (Android AudioDeviceCallback, iOS
   * routeChangeNotification), screen off included. Undefined when the native module is missing:
   * the call screen then polls instead.
   */
  watch?: (onChange: () => void) => () => void;
}

export interface AudioRouteState {
  outputs: readonly AudioOutput[];
  /** The route the sound is really on, as far as Twring knows (verified on Android 12+). */
  current?: AudioOutput;
  /** The last switch that did not land; cleared by the next one that does. */
  failed?: AudioOutput;
}

/** Wait before the one retry of an automatic switch to speaker, phone or wired that did not land. */
export const ROUTE_RETRY_MS = 500;

/**
 * Tracks and switches the call's audio output. Route changes never touch the call itself (no
 * reconnect): only the audio session's output moves. Calls are serialized so a poll can't undo a tap.
 * The state shows the route the platform confirmed, never one it only asked for.
 */
export class AudioRoutes {
  private state: AudioRouteState = { outputs: [] };
  /** The caller picked `state.current` themselves; cleared when that device goes away or on reset. */
  private manual = false;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by reset(); work queued or in flight from an older call never selects or sets state. */
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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
    return this.enqueue((live) => this.apply(live));
  }

  /** The caller picked an output. */
  choose(output: AudioOutput): Promise<void> {
    return this.enqueue(async (live) => {
      if (!this.state.outputs.includes(output)) return;
      const result = await this.platform.select(output);
      if (!live()) return;
      if (!result.ok) {
        this.fail(output, result.actual);
        return;
      }
      this.manual = true;
      this.set({ outputs: this.state.outputs, current: output });
    });
  }

  /**
   * Applies the current output again, e.g. after a phone call took the audio away. Re-reads the
   * outputs first so a device that left meanwhile falls back like any other change. Always selects,
   * even when the OS reads back the same route: Telecom may have closed the link underneath it.
   */
  restore(): Promise<void> {
    return this.enqueue(async (live) => {
      const outputs = parseOutputs(await this.platform.list());
      if (!live()) return;
      const current = nextRoute(this.state.outputs, outputs, this.state.current, this.manual);
      if (current === undefined) {
        this.set({ outputs });
        return;
      }
      const result = await this.platform.select(current);
      if (!live()) return;
      if (current !== this.state.current) this.manual = false;
      if (!result.ok) {
        const actual = result.actual ?? this.state.current;
        this.set({ outputs, ...(actual !== undefined && { current: actual }) });
        return;
      }
      this.set({ outputs, current });
    });
  }

  /**
   * Forget everything when the call ends. The platform release runs after any select still in
   * flight, so the ending call's device is cleared and the next call's first refresh is never undone.
   */
  reset(): void {
    this.generation += 1;
    this.manual = false;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.set({ outputs: [] });
    if (this.platform.release === undefined) return;
    this.queue = this.queue
      .then(() => this.platform.release?.())
      .catch((error: unknown) => {
        this.onError(error instanceof Error ? error.message : 'route release failed');
      });
  }

  /** One refresh; `retry` is the target of a switch that did not land, tried once more. */
  private async apply(live: () => boolean, retry?: AudioOutput): Promise<void> {
    const listed = await this.platform.list();
    if (!live()) return;
    const outputs = parseOutputs(listed);
    const current =
      retry !== undefined && outputs.includes(retry)
        ? retry
        : nextRoute(this.state.outputs, outputs, this.state.current, this.manual);
    if (current === undefined) {
      if (this.state.current !== undefined) this.manual = false;
      this.set({ outputs });
      return;
    }
    if (current === this.state.current && !(await this.offRoute(current))) {
      if (!live()) return;
      this.set({ outputs, current });
      return;
    }
    if (!live()) return;
    const result = await this.platform.select(current);
    if (!live()) return;
    if (current !== this.state.current) this.manual = false;
    if (result.ok) {
      this.set({ outputs, current });
      return;
    }
    const actual = result.actual ?? this.state.current;
    this.set({ outputs, ...(actual !== undefined && { current: actual }) });
    if (current === 'bluetooth') return;
    if (retry === undefined) this.scheduleRetry(current);
    else this.fail(current, result.actual);
  }

  /** The OS reads back another route than `wanted`. Unknown (null) trusts the JS state. */
  private async offRoute(wanted: AudioOutput): Promise<boolean> {
    if (this.platform.current === undefined) return false;
    const actual = await this.platform.current();
    return actual !== null && actual !== wanted;
  }

  private scheduleRetry(target: AudioOutput): void {
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    const generation = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (generation !== this.generation) return;
      void this.enqueue((live) => this.apply(live, target));
    }, ROUTE_RETRY_MS);
  }

  private fail(output: AudioOutput, actual: AudioOutput | null): void {
    const current = actual ?? this.state.current;
    this.set({
      outputs: this.state.outputs,
      ...(current !== undefined && { current }),
      failed: output,
    });
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
