import { describe, expect, it } from 'vitest';

import { CallAudioError } from '../livekit/call-audio';

import { RelayAudio } from './relay-audio';
import {
  RelayAudioRefusedError,
  RelayUnavailableError,
  type RelayAudioSession,
} from './relay-client';

const IDS = { room: 'cord-call-abc', callerIdentity: 'caller-abc' };
const LIFETIMES = { callerTtlSeconds: 600, gatewayTtlSeconds: 3600 };
const SESSION: RelayAudioSession = {
  url: 'wss://audio.twring.test',
  room: 'inst_ins_A_call_abc',
  caller_token: 'caller.jwt',
  server_token: 'server.jwt',
  expires_at: '2027-01-01T02:00:00.000Z',
};

function relay(answer: () => Promise<RelayAudioSession>) {
  const seen = { asked: [] as string[], ended: [] as string[], endedByCall: [] as string[] };
  return {
    seen,
    client: {
      audioSession: (callId: string) => {
        seen.asked.push(callId);
        return answer();
      },
      endAudioSession: (room: string) => {
        seen.ended.push(room);
        return Promise.resolve();
      },
      endAudioSessionByCall: (callId: string) => {
        seen.endedByCall.push(callId);
        return Promise.resolve();
      },
    },
  };
}

describe('RelayAudio', () => {
  it("uses the relay's address, room and tokens, and the caller identity it minted", async () => {
    const { client, seen } = relay(() => Promise.resolve(SESSION));
    const session = await new RelayAudio(client).start('call_abc', IDS, LIFETIMES);
    expect(seen.asked).toEqual(['call_abc']);
    expect(session).toEqual({
      url: 'wss://audio.twring.test',
      room: 'inst_ins_A_call_abc',
      callerIdentity: 'caller-call_abc',
      callerToken: 'caller.jwt',
      gatewayToken: 'server.jwt',
      expiresAt: new Date('2027-01-01T02:00:00.000Z'),
    });
  });

  it('a relay that cannot be reached fails the call as audio_unavailable', async () => {
    const { client } = relay(() => Promise.reject(new RelayUnavailableError('/v1/audio')));
    const error = await new RelayAudio(client)
      .start('call_abc', IDS, LIFETIMES)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CallAudioError);
    expect((error as CallAudioError).code).toBe('audio_unavailable');
  });

  it('a start that timed out is ended by its call id, so the relay frees the line', async () => {
    const { client, seen } = relay(() => Promise.reject(new RelayUnavailableError('/v1/audio')));
    await new RelayAudio(client).start('call_abc', IDS, LIFETIMES).catch(() => undefined);
    expect(seen.endedByCall).toEqual(['call_abc']);
  });

  it.each(['audio_paused', 'audio_expired', 'audio_limit_reached'] as const)(
    'a %s refusal keeps its code and needs no clean-up',
    async (code) => {
      const { client, seen } = relay(() => Promise.reject(new RelayAudioRefusedError(code)));
      const error = await new RelayAudio(client)
        .start('call_abc', IDS, LIFETIMES)
        .catch((e: unknown) => e);
      expect((error as CallAudioError).code).toBe(code);
      expect(seen.endedByCall).toEqual([]);
    },
  );

  it('ends a session at the relay by its room', async () => {
    const { client, seen } = relay(() => Promise.resolve(SESSION));
    await new RelayAudio(client).end('inst_ins_A_call_abc');
    expect(seen.ended).toEqual(['inst_ins_A_call_abc']);
  });
});
