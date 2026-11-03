import type { LiveKitConfig } from '@twring/config/gateway';
import { GATEWAY_IDENTITY } from '@twring/contracts';
import { AccessToken, RoomConfiguration, TrackSource } from 'livekit-server-sdk';

import { ROOM_SETTINGS } from '../calls/limits';

/**
 * Rooms are created by LiveKit on first join, from the settings carried in the token, instead of
 * a separate RoomService round trip before the call can start (~1.4 s measured on device).
 * Caller and gateway tokens carry identical settings, so whoever joins first creates the same room.
 */
function roomConfig(room: string): RoomConfiguration {
  return new RoomConfiguration({
    name: room,
    emptyTimeout: ROOM_SETTINGS.emptyTimeoutS,
    departureTimeout: ROOM_SETTINGS.departureTimeoutS,
    maxParticipants: ROOM_SETTINGS.maxParticipants,
  });
}

export interface TokenRequest {
  room: string;
  identity: string;
  ttlSeconds: number;
}

/**
 * Caller (phone) token: join exactly one room, publish only a microphone, subscribe to the
 * gateway. No data publishing, metadata edits, or admin grants (SECURITY §13).
 */
export async function mintCallerToken(
  config: LiveKitConfig,
  request: TokenRequest,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: request.identity,
    ttl: request.ttlSeconds,
  });
  token.roomConfig = roomConfig(request.room);
  token.addGrant({
    room: request.room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  return token.toJwt();
}

/**
 * Gateway token: joins as an agent participant so it can publish audio and status data and set
 * its own readiness attribute. Still scoped to one room.
 */
export async function mintGatewayToken(
  config: LiveKitConfig,
  request: Omit<TokenRequest, 'identity'>,
): Promise<string> {
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity: GATEWAY_IDENTITY,
    name: 'Twring',
    ttl: request.ttlSeconds,
  });
  token.kind = 'agent';
  token.roomConfig = roomConfig(request.room);
  token.addGrant({
    room: request.room,
    roomJoin: true,
    agent: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
  });
  return token.toJwt();
}
