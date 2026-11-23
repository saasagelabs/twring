import { AudioSession } from '@livekit/react-native';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import {
  iosAudioConfiguration,
  outputsFromDevices,
  type AudioOutput,
  type AudioRoutePlatform,
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
  /** Android 12+: setCommunicationDevice for the output. False when it could not (older Android). */
  setCommunicationDevice?(output: AudioOutput): boolean;
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
 * AudioRouteService (MOBILE_PLATFORM_SPEC §3). Android lists and selects outputs through LiveKit;
 * iOS only exposes the system route picker (AVRoutePickerView), which shows the live route itself.
 */
export const audioRouteMode = 'list';

export const audioRoutePlatform: AudioRoutePlatform = {
  list: async () => {
    const devices = Platform.OS === 'android' ? native?.listCallDevices?.() : null;
    if (devices !== null && devices !== undefined) return outputsFromDevices(devices);
    return AudioSession.getAudioOutputs();
  },
  // iOS: switch the session mode instead of forcing a port, so AirPods or a headset still win;
  // 'default' clears any earlier speaker override.
  select: async (output) => {
    if (Platform.OS !== 'ios') {
      // LiveKit first keeps its own idea of the device; Android 12+ then pins the communication
      // device, which replaces the deprecated SCO and speakerphone calls.
      await AudioSession.selectAudioOutput(output);
      native?.setCommunicationDevice?.(output);
      return;
    }
    await AudioSession.setAppleAudioConfiguration(iosAudioConfiguration(output));
    await AudioSession.selectAudioOutput('default');
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
