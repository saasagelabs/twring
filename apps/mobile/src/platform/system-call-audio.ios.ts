import { AudioDeviceModule, AudioEngineAvailability } from '@livekit/react-native-webrtc';
import { requireOptionalNativeModule } from 'expo';

import { createSystemCallAudio } from './system-call-audio-core';

type Subscription = { remove(): void };

interface CordRingAudioModule {
  callAudioState?(): Promise<{ owned: boolean; active: boolean }>;
  addListener(
    event: 'onCallAudioActivated' | 'onCallAudioReleased',
    listener: () => void,
  ): Subscription;
}

const native = requireOptionalNativeModule<CordRingAudioModule>('CordRing');

const systemCallAudio = createSystemCallAudio({
  state: async () => (await native?.callAudioState?.()) ?? { owned: false, active: false },
  setEngineAllowed: (allowed) =>
    AudioDeviceModule.setEngineAvailability(
      allowed ? AudioEngineAvailability.default : AudioEngineAvailability.none,
    ),
  onActivated: (listener) => void native?.addListener('onCallAudioActivated', listener),
  onReleased: (listener) => void native?.addListener('onCallAudioReleased', listener),
});

/**
 * iOS: true when a ring answered on the system call screen owns the audio session. CallKit
 * activates it, so the app must not; WebRTC's engine waits for that (system-call-audio-core.ts).
 * A missing or old native module means the app starts its own session as before.
 */
export function prepareSystemCallAudio(): Promise<boolean> {
  return systemCallAudio.prepare();
}
