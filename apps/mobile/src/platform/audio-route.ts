import { AudioSession } from '@livekit/react-native';
import { Platform } from 'react-native';

import { iosAudioConfiguration, type AudioRoutePlatform } from '@/call/audio-routes';

/**
 * AudioRouteService (MOBILE_PLATFORM_SPEC §3). Android lists and selects outputs through LiveKit;
 * iOS only exposes the system route picker (AVRoutePickerView), which shows the live route itself.
 */
export const audioRouteMode = 'list';

export const audioRoutePlatform: AudioRoutePlatform = {
  list: () => AudioSession.getAudioOutputs(),
  // iOS: switch the session mode instead of forcing a port, so AirPods or a headset still win;
  // 'default' clears any earlier speaker override.
  select: async (output) => {
    if (Platform.OS !== 'ios') return AudioSession.selectAudioOutput(output);
    await AudioSession.setAppleAudioConfiguration(iosAudioConfiguration(output));
    await AudioSession.selectAudioOutput('default');
  },
};

export function showAudioRoutePicker(): Promise<void> {
  return AudioSession.showAudioRoutePicker();
}
