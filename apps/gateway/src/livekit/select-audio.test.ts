import { describe, expect, it } from 'vitest';

import { RelayAudio } from '../selfhost/relay-audio';

import { CallAudioError, OwnLiveKitAudio } from './call-audio';
import { callAudioFor } from './select-audio';

const CONFIG = {
  // Nothing listens here: the own LiveKit cannot be reached.
  url: 'ws://127.0.0.1:9',
  apiKey: 'test-key',
  apiSecret: 'test-secret-that-is-long-enough-0123456789',
};

function recordingRelay() {
  const asked: string[] = [];
  return {
    asked,
    relay: {
      audioSession: (callId: string) => {
        asked.push(callId);
        return Promise.reject(new Error('unused'));
      },
      endAudioSession: () => Promise.resolve(),
      endAudioSessionByCall: () => Promise.resolve(),
    },
  };
}

describe('callAudioFor', () => {
  it('own: the server LiveKit and its rooms', () => {
    const { audio, rooms } = callAudioFor({ kind: 'own', config: CONFIG, selfhost: true });
    expect(audio).toBeInstanceOf(OwnLiveKitAudio);
    expect(rooms).toBeDefined();
  });

  it('twring: the relay, and no own rooms', () => {
    const { relay } = recordingRelay();
    const { audio, rooms } = callAudioFor({ kind: 'twring', relay });
    expect(audio).toBeInstanceOf(RelayAudio);
    expect(rooms).toBeUndefined();
  });

  it('own never falls back to Twring audio when the server LiveKit is down', async () => {
    const { audio } = callAudioFor({ kind: 'own', config: CONFIG, selfhost: true });
    const error = await audio
      .start(
        'call_x',
        { room: 'cord-call-x', callerIdentity: 'caller-x' },
        { callerTtlSeconds: 600, gatewayTtlSeconds: 3600 },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallAudioError);
    expect((error as CallAudioError).code).toBe('audio_unreachable');
  });
});
