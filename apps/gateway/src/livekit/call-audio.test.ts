import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';

import {
  CallAudioError,
  OWN_AUDIO_CHECK_TIMEOUT_MS,
  OwnLiveKitAudio,
  type CallAudio,
} from './call-audio';
import type { RoomService } from './rooms';
import { mintCallerToken, mintGatewayToken } from './tokens';

const LIVEKIT = {
  url: 'wss://cord-test.livekit.invalid',
  apiKey: 'test-key',
  apiSecret: 'test-secret-that-is-long-enough-0123456789',
};
const IDS = { room: 'cord-call-abc', callerIdentity: 'caller-abc' };
const LIFETIMES = { callerTtlSeconds: 600, gatewayTtlSeconds: 3600 };

function rooms(options: { pingFails?: boolean } = {}) {
  const seen = { deleted: [] as string[], pings: 0 };
  const service: RoomService = {
    deleteRoom: (name) => {
      seen.deleted.push(name);
      return Promise.resolve();
    },
    removeParticipant: () => Promise.resolve(),
    ping: () => {
      seen.pings += 1;
      return options.pingFails === true
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : Promise.resolve();
    },
  };
  return { service, seen };
}

function ownAudio(selfhost: boolean, service: RoomService): CallAudio {
  return new OwnLiveKitAudio({
    url: LIVEKIT.url,
    rooms: service,
    selfhost,
    tokens: {
      caller: (request) => mintCallerToken(LIVEKIT, request),
      gateway: (request) => mintGatewayToken(LIVEKIT, request),
    },
  });
}

/** The claims that do not change with the clock. */
async function stableClaims(token: string) {
  const claims = await new TokenVerifier(LIVEKIT.apiKey, LIVEKIT.apiSecret).verify(token);
  const { exp, nbf, ...rest } = claims as typeof claims & { exp: number; nbf: number };
  return { ...rest, lifetime: exp - nbf };
}

describe('OwnLiveKitAudio', () => {
  it.each([false, true])(
    'hands out exactly the room and token claims of before (selfhost %s)',
    async (selfhost) => {
      const session = await ownAudio(selfhost, rooms().service).start('call_abc', IDS, LIFETIMES);
      expect(session.url).toBe(LIVEKIT.url);
      expect(session.room).toBe('cord-call-abc');
      expect(session.callerIdentity).toBe('caller-abc');
      // The same claims as minting directly, as the registry did before CallAudio.
      expect(await stableClaims(session.callerToken)).toEqual(
        await stableClaims(
          await mintCallerToken(LIVEKIT, {
            room: IDS.room,
            identity: 'caller-abc',
            ttlSeconds: 600,
          }),
        ),
      );
      expect(await stableClaims(session.gatewayToken)).toEqual(
        await stableClaims(await mintGatewayToken(LIVEKIT, { room: IDS.room, ttlSeconds: 3600 })),
      );
      expect(await stableClaims(session.callerToken)).toMatchInlineSnapshot(`
        {
          "iss": "test-key",
          "lifetime": 600,
          "roomConfig": {
            "agents": [],
            "departureTimeout": 20,
            "emptyTimeout": 60,
            "maxParticipants": 2,
            "maxPlayoutDelay": 0,
            "metadata": "",
            "minPlayoutDelay": 0,
            "name": "cord-call-abc",
            "syncStreams": false,
            "tags": {},
          },
          "sub": "caller-abc",
          "video": {
            "canPublish": true,
            "canPublishData": false,
            "canPublishSources": [
              "microphone",
            ],
            "canSubscribe": true,
            "canUpdateOwnMetadata": false,
            "room": "cord-call-abc",
            "roomJoin": true,
          },
        }
      `);
      expect(await stableClaims(session.gatewayToken)).toMatchInlineSnapshot(`
        {
          "iss": "test-key",
          "kind": "agent",
          "lifetime": 3600,
          "name": "Twring",
          "roomConfig": {
            "agents": [],
            "departureTimeout": 20,
            "emptyTimeout": 60,
            "maxParticipants": 2,
            "maxPlayoutDelay": 0,
            "metadata": "",
            "minPlayoutDelay": 0,
            "name": "cord-call-abc",
            "syncStreams": false,
            "tags": {},
          },
          "sub": "cord-gateway",
          "video": {
            "agent": true,
            "canPublish": true,
            "canPublishData": true,
            "canPublishSources": [
              "microphone",
            ],
            "canSubscribe": true,
            "canUpdateOwnMetadata": true,
            "room": "cord-call-abc",
            "roomJoin": true,
          },
        }
      `);
    },
  );

  it('hosted: never checks the server first, and a minting failure is passed on as before', async () => {
    const { service, seen } = rooms({ pingFails: true });
    const audio = new OwnLiveKitAudio({
      url: LIVEKIT.url,
      rooms: service,
      tokens: {
        caller: () => Promise.reject(new Error('mint failed')),
        gateway: (request) => mintGatewayToken(LIVEKIT, request),
      },
    });
    await expect(audio.start('call_abc', IDS, LIFETIMES)).rejects.toThrow('mint failed');
    expect(seen.pings).toBe(0);
    expect(seen.deleted).toEqual(['cord-call-abc']);
  });

  it('self-hosted: a LiveKit that does not answer fails the call as audio_unreachable', async () => {
    const { service, seen } = rooms({ pingFails: true });
    const error = await ownAudio(true, service)
      .start('call_abc', IDS, LIFETIMES)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallAudioError);
    expect((error as CallAudioError).code).toBe('audio_unreachable');
    expect(seen.pings).toBe(1);
    expect(seen.deleted).toEqual(['cord-call-abc']);
  });

  it('self-hosted: a LiveKit check that never answers fails as audio_unreachable after its limit', async () => {
    const hanging: RoomService = {
      deleteRoom: () => Promise.resolve(),
      removeParticipant: () => Promise.resolve(),
      ping: () => new Promise(() => undefined),
    };
    const audio = new OwnLiveKitAudio({
      url: LIVEKIT.url,
      rooms: hanging,
      selfhost: true,
      checkTimeoutMs: 20,
      tokens: {
        caller: (request) => mintCallerToken(LIVEKIT, request),
        gateway: (request) => mintGatewayToken(LIVEKIT, request),
      },
    });
    const error = await audio.start('call_abc', IDS, LIFETIMES).catch((e: unknown) => e);
    expect((error as CallAudioError).code).toBe('audio_unreachable');
  });

  it('the LiveKit check limit is 3 seconds by default', () => {
    expect(OWN_AUDIO_CHECK_TIMEOUT_MS).toBe(3_000);
  });

  it('ends a call by deleting its room', async () => {
    const { service, seen } = rooms();
    await ownAudio(true, service).end('cord-call-abc');
    expect(seen.deleted).toEqual(['cord-call-abc']);
  });
});
