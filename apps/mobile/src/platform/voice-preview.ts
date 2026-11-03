import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { useSyncExternalStore } from 'react';

import {
  VoicePreview,
  type PreviewPlayerFactory,
  type VoicePreviewState,
} from '@/agents/voice-preview';
import { apiErrorCopy } from '@/api/errors';
import { probeSpeechKeyError } from '@/api/speech-key-probe';
import { authHeaders } from '@/auth';
import { systemTimers } from '@/call/timers';
import { mobileEnv } from '@/config/env';
import { activeServerUrl } from '@/servers/active';

/** expo-audio player for voice samples. Only used outside calls (the call owns the audio session). */
const expoPlayers: PreviewPlayerFactory = {
  create(uri, onStatus) {
    // Samples should be heard even with the iOS silent switch on, like any preview the user asked for.
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
    // The sample route needs the signed-in user like every /v1 route (ADR-021).
    const player = createAudioPlayer({ uri, headers: authHeaders() });
    const subscription = player.addListener('playbackStatusUpdate', (status) =>
      onStatus({
        playing: status.playing,
        finished: status.didJustFinish,
        failed: Boolean(status.error),
      }),
    );
    return {
      play: () => player.play(),
      release: () => {
        subscription.remove();
        player.pause();
        player.remove();
      },
    };
  },
};

function sampleUrl(voiceId: string): string | undefined {
  if (!mobileEnv.ok) return undefined;
  const base = activeServerUrl().replace(/\/+$/, '');
  return `${base}/v1/voices/${encodeURIComponent(voiceId)}/sample`;
}

/** The app's one voice-sample player. */
export const voicePreview = new VoicePreview(
  expoPlayers,
  sampleUrl,
  systemTimers,
  async (voiceId) => {
    const uri = sampleUrl(voiceId);
    if (uri === undefined) return undefined;
    const error = await probeSpeechKeyError(fetch, uri, authHeaders());
    return error?.code?.startsWith('speech_key_') ? apiErrorCopy(error).message : undefined;
  },
);

export function useVoicePreview(): VoicePreviewState {
  return useSyncExternalStore(voicePreview.subscribe, voicePreview.getState);
}
