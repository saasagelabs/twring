import type { LiveKitConfig } from '@twring/config/gateway';

import { RelayAudio } from '../selfhost/relay-audio';
import type { RelayClient } from '../selfhost/relay-client';

import { OwnLiveKitAudio, type CallAudio } from './call-audio';
import { createLiveKitRoomService, type RoomService } from './rooms';
import { mintCallerToken, mintGatewayToken } from './tokens';

/**
 * Where calls get their audio. Hosted Twring and self-hosted `own`: the server's LiveKit.
 * Self-hosted `twring`: Twring's, through the relay.
 */
export type CallAudioSource =
  | { kind: 'own'; config: LiveKitConfig; selfhost: boolean }
  | {
      kind: 'twring';
      relay: Pick<RelayClient, 'audioSession' | 'endAudioSession' | 'endAudioSessionByCall'>;
    };

/**
 * The call audio for a source, and the own LiveKit's rooms when there is one. Exactly one audio:
 * a failing own LiveKit is never replaced by Twring's (the call fails and says what to check).
 */
export function callAudioFor(source: CallAudioSource): { audio: CallAudio; rooms?: RoomService } {
  switch (source.kind) {
    case 'own': {
      const { config } = source;
      const rooms = createLiveKitRoomService(config);
      const audio = new OwnLiveKitAudio({
        url: config.url,
        rooms,
        selfhost: source.selfhost,
        tokens: {
          caller: (request) => mintCallerToken(config, request),
          gateway: (request) => mintGatewayToken(config, request),
        },
      });
      return { audio, rooms };
    }
    case 'twring':
      return { audio: new RelayAudio(source.relay) };
    default: {
      const never: never = source;
      return never;
    }
  }
}
