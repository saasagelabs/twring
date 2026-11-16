import { FakeAgentAdapter } from '@twring/agent-adapter';
import { loadGatewayEnv } from '@twring/config/gateway';
import type { CallHistoryItem } from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import type { RoomService } from '../livekit/rooms';
import { FakeSttProvider, FakeTtsProvider } from '../voice/testing';

import type * as RuntimeModule from './runtime';
import { CallRegistry, type SavedAgentCall } from './registry';
import { FakeTransport, ManualScheduler, recordingLogger } from './testing';

const runtimeLanguages = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock('./runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeModule>();
  class RecordingCallRuntime extends actual.CallRuntime {
    constructor(options: ConstructorParameters<typeof actual.CallRuntime>[0]) {
      runtimeLanguages.push(options.language);
      super(options);
    }
  }
  return { ...actual, CallRuntime: RecordingCallRuntime };
});

const rooms: RoomService = {
  deleteRoom: () => Promise.resolve(),
  removeParticipant: () => Promise.resolve(),
  ping: () => Promise.resolve(),
};

const agentFor = (userId: string): SavedAgentCall => ({
  userId,
  agentId: `agt_${'a'.repeat(20)}`,
  agentName: 'Agent',
  protocol: 'cord-rest',
  voiceId: 'flux-aura-en',
  keyterms: [],
  createAgent: () => Promise.resolve(new FakeAgentAdapter()),
});

function registry() {
  return new CallRegistry({
    env: loadGatewayEnv(gatewayEnvFixture({})),
    liveKitUrl: 'wss://cord-test.livekit.invalid',
    rooms,
    tokens: { caller: () => Promise.resolve('c'), gateway: () => Promise.resolve('g') },
    transports: () => new FakeTransport(),
    voice: { stt: new FakeSttProvider(), tts: new FakeTtsProvider() },
    sttForKeyterms: () => new FakeSttProvider(),
    ttsForVoice: () => new FakeTtsProvider(),
    history: {
      record: (_u: string, _i: CallHistoryItem) => Promise.resolve(),
      list: () => Promise.resolve([]),
    } as never,
    scheduler: new ManualScheduler(),
    logger: recordingLogger(),
  });
}

describe('the call runtime gets the language the person speaks', () => {
  it('Hindi reaches the runtime; English stays unset', async () => {
    const r = registry();
    const dg = { apiKey: 'dg', source: 'twring' as const };
    await r.create(agentFor('asha'), 'asha', { speech: { deepgram: dg, language: 'hi' } });
    await r.create(agentFor('bob'), 'bob', { speech: { deepgram: dg } });
    expect(runtimeLanguages).toEqual(['hi', undefined]);
  });
});
