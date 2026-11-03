import { loadGatewayEnv } from '@twring/config/gateway';
import { createCallResponseSchema, errorResponseSchema } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app';
import { CallAudioError, OwnLiveKitAudio, type CallAudio } from '../livekit/call-audio';
import type { RoomService } from '../livekit/rooms';
import { RelayAudio } from '../selfhost/relay-audio';
import {
  RelayAudioRefusedError,
  RelayUnavailableError,
  type RelayAudioSession,
} from '../selfhost/relay-client';

import { CallRegistry } from './registry';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const SESSION: RelayAudioSession = {
  url: 'wss://audio.twring.test',
  room: 'inst_ins_A_call_x',
  caller_token: 'caller.jwt',
  server_token: 'server.jwt',
  expires_at: '2027-01-01T02:00:00.000Z',
};

/** A relay double that records every ask, so a test can prove it was never contacted. */
function fakeRelay(
  answer: 'ok' | 'down' | 'audio_paused' | 'audio_expired' | 'audio_limit_reached',
  endDelay?: Promise<void>,
) {
  const seen = { asked: [] as string[], ended: [] as string[], endsDone: 0 };
  return {
    seen,
    client: {
      audioSession: (callId: string) => {
        seen.asked.push(callId);
        if (answer === 'ok') return Promise.resolve({ ...SESSION, room: `inst_ins_A_${callId}` });
        if (answer === 'down') return Promise.reject(new RelayUnavailableError('/v1/audio'));
        return Promise.reject(new RelayAudioRefusedError(answer));
      },
      endAudioSession: async (room: string) => {
        seen.ended.push(room);
        await endDelay;
        seen.endsDone += 1;
      },
      endAudioSessionByCall: () => Promise.resolve(),
    },
  };
}

function setup(audio: CallAudio) {
  const env = loadGatewayEnv(gatewayEnvFixture({}));
  const transports: { url: string; callerIdentity: string }[] = [];
  const registry = new CallRegistry({
    env,
    audio,
    transports: (params) => {
      transports.push({ url: params.url, callerIdentity: params.callerIdentity });
      return new FakeTransport();
    },
    scheduler: new ManualScheduler(),
    logger: recordingLogger(),
  });
  const app = buildApp({
    env,
    onError: () => undefined,
    userFor: () => 'dev',
    calls: { registry, createRatePerMinute: env.CALL_CREATE_RATE_PER_MINUTE },
  });
  apps.push(app);
  const createCall = () =>
    app.inject({ method: 'POST', url: '/v1/calls', payload: {}, remoteAddress: '203.0.113.7' });
  return { registry, transports, createCall };
}

const downRooms: RoomService = {
  deleteRoom: () => Promise.resolve(),
  removeParticipant: () => Promise.resolve(),
  ping: () => Promise.reject(new Error('connect ECONNREFUSED')),
};

describe('call audio through Twring (self-hosted twring)', () => {
  it("asks the relay and gives the phone the relay's address, room and token", async () => {
    const relay = fakeRelay('ok');
    const { createCall, transports, registry } = setup(new RelayAudio(relay.client));
    const res = await createCall();
    expect(res.statusCode).toBe(201);
    const body = createCallResponseSchema.parse(res.json());
    expect(relay.seen.asked).toEqual([body.call_id]);
    expect(body.livekit).toEqual({
      url: 'wss://audio.twring.test',
      room: `inst_ins_A_${body.call_id}`,
      token: 'caller.jwt',
    });
    expect(body.expires_at).toBe('2027-01-01T02:00:00.000Z');
    // The server joins the relay's room and expects the caller identity the relay minted.
    expect(transports).toEqual([
      { url: 'wss://audio.twring.test', callerIdentity: `caller-${body.call_id}` },
    ]);
    await registry.end(body.call_id);
    await flushMicrotasks();
    expect(relay.seen.ended).toEqual([`inst_ins_A_${body.call_id}`]);
  });

  it('a relay that cannot be reached fails the call with audio_unavailable', async () => {
    const relay = fakeRelay('down');
    const { createCall, registry } = setup(new RelayAudio(relay.client));
    const res = await createCall();
    expect(res.statusCode).toBe(503);
    const { error } = errorResponseSchema.parse(res.json());
    expect(error.code).toBe('audio_unavailable');
    expect(error.message).toBe(
      "Twring's audio service can't be reached right now. Try again in a minute.",
    );
    expect(registry.activeCount).toBe(0);
  });
});

describe('Twring audio refusals reach the phone as what happened', () => {
  it.each([
    [
      'audio_paused',
      403,
      "Calls are paused until your server's email address is confirmed. Your admin can find the email from Twring.",
    ],
    ['audio_expired', 403, "Twring's audio service for this server has ended. Ask your admin."],
    [
      'audio_limit_reached',
      429,
      'This server has reached its call limit for now. Try again later.',
    ],
  ] as const)('%s', async (code, status, message) => {
    const { createCall } = setup(new RelayAudio(fakeRelay(code).client));
    const res = await createCall();
    expect(res.statusCode).toBe(status);
    const { error } = errorResponseSchema.parse(res.json());
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });
});

describe('shutdown', () => {
  it('waits for the relay to hear each call ended', async () => {
    let release!: () => void;
    const relay = fakeRelay('ok', new Promise<void>((resolve) => (release = resolve)));
    const { createCall, registry } = setup(new RelayAudio(relay.client));
    expect((await createCall()).statusCode).toBe(201);
    let done = false;
    const shutdown = registry.shutdown().then(() => (done = true));
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relay.seen.ended).toHaveLength(1);
    expect(done).toBe(false);
    release();
    await shutdown;
    expect(relay.seen.endsDone).toBe(1);
  });
});

describe('own call audio (self-hosted own)', () => {
  it('a LiveKit that does not answer fails with audio_unreachable, never asking the relay', async () => {
    const relay = fakeRelay('ok');
    const own = new OwnLiveKitAudio({
      url: 'wss://livekit.example.test',
      rooms: downRooms,
      selfhost: true,
      tokens: {
        caller: () => Promise.resolve('caller.jwt'),
        gateway: () => Promise.resolve('gateway.jwt'),
      },
    });
    const { createCall } = setup(own);
    const res = await createCall();
    expect(res.statusCode).toBe(503);
    const { error } = errorResponseSchema.parse(res.json());
    expect(error.code).toBe('audio_unreachable');
    expect(error.message).toBe(
      "Call audio isn't reachable on your server. Run twring audio check on the server.",
    );
    // Never a silent switch to Twring's audio.
    expect(relay.seen.asked).toEqual([]);
  });

  it('a CallAudioError from any audio maps to its own code', () => {
    expect(new CallAudioError('audio_unreachable').code).toBe('audio_unreachable');
  });
});
