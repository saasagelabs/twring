import { AudioSession } from '@livekit/react-native';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import {
  iosAudioConfiguration,
  outputsFromDevices,
  type AudioOutput,
  type AudioRoutePlatform,
  type RouteResult,
} from '@/call/audio-routes';
import type { CallInterruptionPlatform, InterruptionPhase } from '@/call/call-interruption';

/**
 * modules/twring-audio-route: route change and call interruption events, and on Android the call
 * devices (communication devices, so A2DP-only Bluetooth is left out) with setCommunicationDevice
 * on Android 12+.
 */
interface TwringAudioRouteModule {
  /** Android only: communication device names, or null before Android 12 without SCO info. */
  listCallDevices?(): string[] | null;
  /**
   * Android 12+: setCommunicationDevice for the output. False when it could not (older Android).
   * The token records the call, so clearCommunicationDevice from an ended call leaves a newer one.
   */
  setCommunicationDevice?(output: AudioOutput, token?: number): boolean;
  /** Android 12+: the device the OS routes the call to; null for none, unknown type or older Android. */
  currentCallDevice?(): AudioOutput | null;
  /** Whether the audio mode is MODE_IN_COMMUNICATION. */
  callModeActive?(): boolean;
  /** Android 12+: clears the communication device, only if the last set had this token. */
  clearCommunicationDevice?(token?: number): void;
  startWatching(): void;
  stopWatching(): void;
  addListener(event: 'onRoutesChanged', listener: () => void): { remove(): void };
  addListener(
    event: 'onInterruption',
    listener: (event: { phase: InterruptionPhase }) => void,
  ): { remove(): void };
}

const native = requireOptionalNativeModule<TwringAudioRouteModule>('TwringAudioRoute');

/** Watchers share one native registration; it stops with the last one. */
let watchers = 0;
function watching(): () => void {
  if (watchers === 0) native?.startWatching();
  watchers += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers -= 1;
    if (watchers === 0) native?.stopWatching();
  };
}

/**
 * AudioRouteService (MOBILE_PLATFORM_SPEC §3). Android lists call devices natively; before Android
 * 12 it selects through LiveKit. On Android 12+ Twring is the only route writer (ADR-049): it sets
 * the communication device and reads it back, so the UI never shows a route the OS did not take.
 * iOS only exposes the system route picker (AVRoutePickerView), which shows the live route itself.
 */
export const audioRouteMode = 'list';

/** Android 12 (API 31) added setCommunicationDevice. Decided by version, never by a null read-back. */
function singleWriter(): boolean {
  return Platform.OS === 'android' && Number(Platform.Version) >= 31;
}

/** Waits behind a testable clock (fake timers in tests). */
export const routeClock = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const POLL_MS = 50;
const MODE_WAIT_MS = 500;
/** Speaker, earpiece and wired move at once; each attempt gets this long. */
const ATTEMPT_MS = 300;
/** Bluetooth SCO takes about 0.5 to 3 s to open: no clear or second request inside this window. */
const BLUETOOTH_MS = 4000;

const OUTPUTS: ReadonlySet<string> = new Set<AudioOutput>([
  'bluetooth',
  'headset',
  'speaker',
  'earpiece',
]);

/** Polls `check` every 50 ms, true as soon as it holds, false once `limitMs` has passed. */
async function within(limitMs: number, check: () => boolean): Promise<boolean> {
  for (let waited = 0; ; waited += POLL_MS) {
    if (check()) return true;
    if (waited >= limitMs) return false;
    await routeClock.sleep(POLL_MS);
  }
}

function readBack(): AudioOutput | null {
  const device = native?.currentCallDevice?.() ?? null;
  return device !== null && OUTPUTS.has(device) ? device : null;
}

function log(line: Record<string, unknown>): void {
  console.info(JSON.stringify({ ev: 'audio_route', ...line, sdk: Number(Platform.Version) }));
}

/** Tags this call's sets, so clearing at call end leaves a newer call's device alone. */
let callToken = 1;

async function selectVerified(output: AudioOutput): Promise<RouteResult> {
  const started = routeClock.now();
  log({ phase: 'request', want: output });
  const token = callToken;
  // Never write before MODE_IN_COMMUNICATION: during a phone call the mode is Telecom's.
  if (native?.callModeActive !== undefined) {
    const inCall = await within(MODE_WAIT_MS, () => native?.callModeActive?.() ?? true);
    if (!inCall) {
      const actual = readBack();
      log({
        phase: 'result',
        want: output,
        got: actual,
        ok: false,
        ms: routeClock.now() - started,
        mode: false,
      });
      return { ok: false, actual };
    }
  }
  const set = () => native?.setCommunicationDevice?.(output, token);
  const landed = () => readBack() === output;
  set();
  let retry = 0;
  let ok: boolean;
  if (output === 'bluetooth') {
    ok = await within(BLUETOOTH_MS, landed);
  } else {
    ok = await within(ATTEMPT_MS, landed);
    if (!ok) {
      retry = 1;
      native?.clearCommunicationDevice?.(token);
      set();
      ok = await within(ATTEMPT_MS, landed);
    }
  }
  const actual = ok ? output : readBack();
  log({ phase: 'result', want: output, got: actual, ok, ms: routeClock.now() - started, retry });
  return ok ? { ok: true } : { ok: false, actual };
}

export const audioRoutePlatform: AudioRoutePlatform = {
  list: async () => {
    if (singleWriter()) {
      const devices = native?.listCallDevices?.();
      if (devices === null || devices === undefined) throw new Error('call devices unavailable');
      return outputsFromDevices(devices);
    }
    const devices = Platform.OS === 'android' ? native?.listCallDevices?.() : null;
    if (devices !== null && devices !== undefined) return outputsFromDevices(devices);
    return AudioSession.getAudioOutputs();
  },
  // iOS: switch the session mode instead of forcing a port, so AirPods or a headset still win;
  // 'default' clears any earlier speaker override.
  select: async (output) => {
    if (singleWriter()) return selectVerified(output);
    if (Platform.OS !== 'ios') {
      // Before Android 12 LiveKit routes; the native set is a no-op there.
      await AudioSession.selectAudioOutput(output);
      native?.setCommunicationDevice?.(output);
      return { ok: true };
    }
    await AudioSession.setAppleAudioConfiguration(iosAudioConfiguration(output));
    await AudioSession.selectAudioOutput('default');
    return { ok: true };
  },
  current: () => Promise.resolve(singleWriter() ? readBack() : null),
  release: () => {
    if (singleWriter()) {
      native?.clearCommunicationDevice?.(callToken);
      callToken += 1;
    }
    return Promise.resolve();
  },
  ...(native !== null && {
    watch: (onChange: () => void) => {
      const subscription = native.addListener('onRoutesChanged', onChange);
      const stop = watching();
      return () => {
        subscription.remove();
        stop();
      };
    },
  }),
};

export const callInterruptionPlatform: CallInterruptionPlatform = {
  ...(native !== null && {
    watch: (listener: (phase: InterruptionPhase) => void) => {
      const subscription = native.addListener('onInterruption', (event) => listener(event.phase));
      const stop = watching();
      return () => {
        subscription.remove();
        stop();
      };
    },
  }),
};

export function showAudioRoutePicker(): Promise<void> {
  return AudioSession.showAudioRoutePicker();
}
