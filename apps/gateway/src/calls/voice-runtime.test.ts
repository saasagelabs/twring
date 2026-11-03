import { describe, expect, it, vi } from 'vitest';

import { AdapterError, FakeAgentAdapter, type TwringAgentAdapter } from '@twring/agent-adapter';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { createDeepgramTts } from '../voice/deepgram-tts';
import { FakeSttProvider, FakeTtsProvider, fakeSocketFactory } from '../voice/testing';

import { builtInAgentFactory } from './agents';
import { CALL_TIMEOUTS } from './limits';
import { CallRuntime, type CallRuntimeOptions, type EndReason } from './runtime';
import {
  FakeTransport,
  ManualScheduler,
  flushMicrotasks,
  recordingLogger,
  type LoggedEvent,
} from './testing';

const CALL_ID = 'call_aaaaaaaaaaaaaaaaaaaa';
/** 30 ms of 48 kHz audio as linear16 bytes: one full 20 ms frame plus a 10 ms remainder. */
const speechBytes = (value = 1000) => {
  const samples = new Int16Array(1440).fill(value);
  return new Uint8Array(samples.buffer);
};

function setup(ownKeyProviders?: CallRuntimeOptions['ownKeyProviders']) {
  const transport = new FakeTransport();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const ended: { reason: EndReason; failed: boolean }[] = [];
  const runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'repeat',
    createAgent: builtInAgentFactory('repeat'),
    maxDurationMs: 600_000,
    scheduler,
    logger,
    voice: { stt, tts },
    ...(ownKeyProviders && { ownKeyProviders }),
    onEnded: ({ reason, failed }) => ended.push({ reason, failed }),
  });
  return { runtime, transport, scheduler, logger, stt, tts, ended };
}

/** A factory that hands the runtime this exact adapter. */
const withAgent = (agent: TwringAgentAdapter) => () => Promise.resolve(agent);

async function started() {
  const ctx = setup();
  await ctx.runtime.start();
  ctx.transport.emit({ type: 'caller_joined' });
  return ctx;
}

describe('CallRuntime conversation (repeat agent)', () => {
  it('announces ready only once speech providers are connected', async () => {
    const { transport, stt, tts, logger } = await started();
    expect(stt.opens).toBe(1);
    expect(tts.opens).toBe(1);
    expect(transport.states).toEqual(['ready']);
    expect(logger.names()).toContain('voice_ready');
  });

  it('fails the call without announcing ready when a provider rejects the key', async () => {
    const ctx = setup();
    ctx.stt.failNextOpen = { code: 'auth_failed', recoverable: false };
    const starting = ctx.runtime.start();
    // Nobody joins: the gateway waits out the failure notice, then leaves.
    await vi.waitFor(() => {
      ctx.scheduler.advance(CALL_TIMEOUTS.failureNoticeMs);
      expect(ctx.ended).toHaveLength(1);
    });
    await starting;
    expect(ctx.transport.states).not.toContain('ready');
    expect(ctx.ended).toEqual([{ reason: 'voice_unavailable', failed: true }]);
    expect(ctx.logger.events).toContainEqual({
      level: 'warn',
      fields: { event: 'voice_unavailable', call_id: CALL_ID, error_code: 'auth_failed' },
    });
    expect(ctx.tts.closed).toBe(1);
  });

  async function refusedAtOpen(ownKeyProviders?: CallRuntimeOptions['ownKeyProviders']) {
    const ctx = setup(ownKeyProviders);
    ctx.stt.failNextOpen = { code: 'auth_failed', recoverable: false };
    const starting = ctx.runtime.start();
    await vi.waitFor(() => {
      ctx.scheduler.advance(CALL_TIMEOUTS.failureNoticeMs);
      expect(ctx.ended).toHaveLength(1);
    });
    await starting;
    return ctx;
  }

  it("ends with deepgram_key_refused when the person's own Deepgram key is refused at open", async () => {
    const ctx = await refusedAtOpen({ stt: 'deepgram', tts: 'deepgram' });
    expect(ctx.transport.endReasons).toEqual(['deepgram_key_refused']);
    expect(ctx.ended).toEqual([{ reason: 'deepgram_key_refused', failed: true }]);
  });

  it("keeps voice_unavailable when Twring's key is refused at open", async () => {
    const ctx = await refusedAtOpen({ tts: 'cartesia' });
    expect(ctx.transport.endReasons).toEqual(['voice_unavailable']);
  });

  it("ends with cartesia_key_refused when the person's own Cartesia TTS is refused mid-call", async () => {
    const ctx = setup({ tts: 'cartesia' });
    await ctx.runtime.start();
    ctx.transport.emit({ type: 'caller_joined' });
    ctx.tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await flushMicrotasks();
    expect(ctx.ended).toEqual([{ reason: 'cartesia_key_refused', failed: true }]);
    expect(ctx.transport.endReasons).toContain('cartesia_key_refused');
  });

  it('a mid-call STT refusal on own Cartesia TTS stays voice_failed', async () => {
    const ctx = setup({ tts: 'cartesia' });
    await ctx.runtime.start();
    ctx.transport.emit({ type: 'caller_joined' });
    ctx.stt.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await flushMicrotasks();
    expect(ctx.ended).toEqual([{ reason: 'voice_failed', failed: true }]);
  });

  it('streams caller audio to STT at 16 kHz', async () => {
    const { transport, stt } = await started();
    for (let i = 0; i < 3; i += 1) transport.frame(new Int16Array(SAMPLES_PER_FRAME));
    expect(stt.samplesReceived).toBe(3 * 320);
  });

  it('captions the caller, then speaks back the finished turn and plays it', async () => {
    const { transport, stt, tts, scheduler, logger } = await started();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send({ type: 'partial', turnIndex: 0, text: 'hello' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello world' });
    await flushMicrotasks();
    expect(tts.calls).toEqual(['speak gen_1 You said: hello ', 'speak gen_1 world', 'flush gen_1']);

    scheduler.advance(180);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await flushMicrotasks();

    expect(transport.published).toHaveLength(3); // 60 ms of audio = three 20 ms frames
    const base = { v: 1, call_id: CALL_ID };
    expect(transport.reliableStatuses).toEqual([
      { ...base, type: 'floor', seq: 1, floor: 'user_speaking' },
      { ...base, type: 'caption', turn_index: 0, text: 'hello', final: false },
      { ...base, type: 'caption', turn_index: 0, text: 'hello world', final: true },
      { ...base, type: 'floor', seq: 2, floor: 'agent_working', turn_id: 'turn_1' },
      {
        ...base,
        type: 'agent_text',
        turn_id: 'turn_1',
        text: 'You said: hello world',
        final: false,
      },
      {
        ...base,
        type: 'agent_text',
        turn_id: 'turn_1',
        text: 'You said: hello world',
        final: true,
      },
      { ...base, type: 'floor', seq: 3, floor: 'agent_speaking', turn_id: 'turn_1' },
      { ...base, type: 'floor', seq: 4, floor: 'listening' },
    ]);
    const names = logger.names();
    expect(names).toEqual(
      expect.arrayContaining([
        'user_speech_started',
        'turn_committed',
        'tts_first_text_enqueued',
        'tts_first_audio',
        'audio_first_published',
        'tts_done',
      ]),
    );
    expect(names.filter((name) => name === 'audio_first_published')).toHaveLength(1);
    expect(
      logger.events.find((e) => e.fields.event === 'tts_first_audio')?.fields.duration_ms,
    ).toBe(180);
    // Transcripts never reach logs; only their length does.
    expect(JSON.stringify(logger.events)).not.toContain('hello');
  });

  it('queues all of a long reply instead of dropping it like live audio', async () => {
    const { transport, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'long' });
    await flushMicrotasks();
    const threeSeconds = new Uint8Array(new Int16Array(48_000 * 3).fill(500).buffer);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: threeSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await flushMicrotasks();
    expect(transport.published).toHaveLength(150);
  });

  it('drops late audio from a replaced generation', async () => {
    const { transport, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'two' });
    await flushMicrotasks();
    expect(tts.calls).toContain('cancel gen_1');
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await flushMicrotasks();
    expect(transport.published).toEqual([]);
    tts.send({ type: 'audio', generationId: 'gen_2', bytes: speechBytes() });
    await flushMicrotasks();
    expect(transport.published).toHaveLength(1);
  });

  it('reconnects STT after a drop, and fails the call when retries run out', async () => {
    const { stt, scheduler, ended, logger } = await started();
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    scheduler.advance(250);
    await flushMicrotasks();
    expect(stt.opens).toBe(2);
    expect(logger.names()).toContain('stt_reconnected');

    for (const delay of [250, 1000, 3000]) {
      stt.failNextOpen = { code: 'connection_lost', recoverable: true };
      if (delay === 250) {
        stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
      }
      scheduler.advance(delay);
      await flushMicrotasks();
    }
    expect(ended).toEqual([{ reason: 'voice_failed', failed: true }]);
  });

  it('fails the call at once on a non-recoverable provider error', async () => {
    const { tts, ended } = await started();
    tts.send({ type: 'error', error: { code: 'auth_failed', recoverable: false } });
    await flushMicrotasks();
    expect(ended).toEqual([{ reason: 'voice_failed', failed: true }]);
  });

  it('a TTS error naming no generation still ends the answer it interrupted', async () => {
    const { transport, stt, tts, ended } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await flushMicrotasks();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
    tts.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    await flushMicrotasks();
    expect(floorsOf(transport).at(-1)).toBe('listening');
    expect(ended).toEqual([]);
  });

  it('closes both providers and stops speech on hang-up', async () => {
    const { runtime, stt, tts, transport } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'bye' });
    await flushMicrotasks();
    await runtime.end('hangup');
    expect(stt.closed).toBe(1);
    expect(tts.closed).toBe(1);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await flushMicrotasks();
    expect(transport.published).toEqual([]);
  });

  it('cuts off an answer still playing out when a new turn commits', async () => {
    const { transport, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    const fiveSeconds = new Uint8Array(new Int16Array(48_000 * 5).fill(500).buffer);
    transport.holdPublishing = true; // playout is real-time; the queue is still full
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: fiveSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await flushMicrotasks();
    const clearsBefore = transport.clearCount;
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'two' });
    await flushMicrotasks();
    expect(transport.clearCount).toBeGreaterThan(clearsBefore);
  });
});

/** The floors the phone was sent, e.g. `agent_working(Looking that up…)`. */
function floorsOf(transport: FakeTransport): string[] {
  return transport.reliableStatuses.flatMap((m) =>
    m.type === 'floor'
      ? [
          `${m.floor}${m.turn_id !== undefined ? `:${m.turn_id}` : ''}${m.activity !== undefined ? `(${m.activity})` : ''}`,
        ]
      : [],
  );
}

async function settleAll(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await flushMicrotasks();
}

function agentFailureCode(events: LoggedEvent[]): unknown {
  return events.find((e) => e.fields.event === 'agent_unavailable')?.fields.error_code;
}

describe('CallRuntime agent startup', () => {
  async function failingStart(createAgent?: () => Promise<TwringAgentAdapter>) {
    const transport = new FakeTransport();
    const logger = recordingLogger();
    const ended: EndReason[] = [];
    const scheduler = new ManualScheduler();
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'native',
      maxDurationMs: 600_000,
      scheduler,
      logger,
      voice: { stt: new FakeSttProvider(), tts: new FakeTtsProvider() },
      ...(createAgent && { createAgent }),
      onEnded: ({ reason }) => ended.push(reason),
    });
    const starting = runtime.start();
    // Nobody joins: the gateway waits out the failure notice, then leaves.
    await vi.waitFor(() => {
      scheduler.advance(CALL_TIMEOUTS.failureNoticeMs);
      expect(ended).toHaveLength(1);
    });
    await starting;
    return { transport, logger, ended };
  }

  /** A native call with no agent configured, started but not driven to its end. */
  function unavailable() {
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const ended: EndReason[] = [];
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'native',
      maxDurationMs: 600_000,
      scheduler,
      logger: recordingLogger(),
      voice: { stt: new FakeSttProvider(), tts: new FakeTtsProvider() },
      onEnded: ({ reason }) => ended.push(reason),
    });
    const starting = runtime.start();
    return { transport, scheduler, ended, runtime, starting };
  }

  it('stays in the room with the failure reason until the caller joins, then leaves', async () => {
    const { transport, ended, starting } = unavailable();
    await vi.waitFor(() => expect(transport.states).toEqual(['ending']));
    await flushMicrotasks();
    expect(transport.endReasons).toEqual(['agent_unavailable']);
    expect(transport.closeCount).toBe(0);
    expect(ended).toEqual([]);
    transport.emit({ type: 'caller_joined' });
    await starting;
    expect(transport.closeCount).toBe(1);
    expect(ended).toEqual(['agent_unavailable']);
  });

  it('leaves after the failure notice window when nobody joins', async () => {
    const { transport, scheduler, ended, starting } = unavailable();
    await vi.waitFor(() => expect(transport.states).toEqual(['ending']));
    await flushMicrotasks();
    scheduler.advance(CALL_TIMEOUTS.failureNoticeMs - 1);
    await flushMicrotasks();
    expect(transport.closeCount).toBe(0);
    scheduler.advance(1);
    await starting;
    expect(transport.closeCount).toBe(1);
    expect(ended).toEqual(['agent_unavailable']);
  });

  it('a hang-up during the failure notice wait leaves at once', async () => {
    const { transport, ended, runtime, starting } = unavailable();
    await vi.waitFor(() => expect(transport.states).toEqual(['ending']));
    await flushMicrotasks();
    expect(transport.closeCount).toBe(0);
    await runtime.end('hangup');
    await starting;
    expect(transport.closeCount).toBe(1);
    expect(ended).toEqual(['agent_unavailable']);
  });

  it('ends as agent_unavailable, telling the phone why, when the agent cannot be built', async () => {
    const { transport, logger, ended } = await failingStart(() =>
      Promise.reject(new AdapterError('endpoint_rejected', { detail: 'private address' })),
    );
    expect(ended).toEqual(['agent_unavailable']);
    expect(transport.states).toEqual(['ending']);
    expect(transport.endReasons).toEqual(['agent_unavailable']);
    expect(agentFailureCode(logger.events)).toBe('endpoint_rejected');
  });

  it('ends as agent_unavailable when no agent is configured for a conversational mode', async () => {
    const { ended, transport } = await failingStart();
    expect(ended).toEqual(['agent_unavailable']);
    expect(transport.endReasons).toEqual(['agent_unavailable']);
  });

  it('ends as agent_unavailable when the agent fails to connect', async () => {
    const agent = new FakeAgentAdapter();
    agent.connect = () => Promise.reject(new AdapterError('auth_failed', { retryable: false }));
    const { ended, logger } = await failingStart(withAgent(agent));
    expect(ended).toEqual(['agent_unavailable']);
    expect(agentFailureCode(logger.events)).toBe('auth_failed');
  });

  it('tells the phone a hang-up is a hang-up', async () => {
    const { runtime, transport } = await started();
    await runtime.end('hangup');
    expect(transport.endReasons).toEqual(['hangup']);
  });
});

describe('CallRuntime conversation edge cases (verifier)', () => {
  it('a publish failure mid-answer does not leave the floor stuck on the agent', async () => {
    const { transport, stt, tts } = await started();
    let publishes = 0;
    transport.publishFrame = (samples: Int16Array) => {
      transport.published.push(samples);
      publishes += 1;
      return publishes === 2 ? Promise.reject(new Error('track closed')) : Promise.resolve();
    };
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    // TTS is faster than real time: the whole answer (and its end marker) is queued at once.
    const threeSeconds = new Uint8Array(new Int16Array(48_000 * 3).fill(500).buffer);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: threeSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('listening');
  });

  it('a turn cut off mid-playout is replaced by the next one, which completes normally', async () => {
    const { transport, stt, tts } = await started();
    const gates: (() => void)[] = [];
    const realPublish = transport.publishFrame.bind(transport);
    transport.publishFrame = (samples: Int16Array) => {
      transport.published.push(samples);
      return new Promise<void>((resolve) => gates.push(resolve));
    };
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    const fiveSeconds = new Uint8Array(new Int16Array(48_000 * 5).fill(500).buffer);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: fiveSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await flushMicrotasks();

    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'two' });
    await flushMicrotasks();
    transport.publishFrame = realPublish;
    for (const open of gates.splice(0)) open(); // the frame in flight when the cut came
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() }); // late: dropped
    tts.send({ type: 'audio', generationId: 'gen_2', bytes: speechBytes() });
    tts.send({ type: 'done', generationId: 'gen_2' });
    await settleAll();
    expect(floorsOf(transport)).toEqual([
      'agent_working:turn_1',
      'agent_working:turn_2',
      'agent_speaking:turn_2',
      'listening',
    ]);
  });

  it('a Deepgram TTS drop mid-answer ends that answer, and the next turn speaks after reconnect', async () => {
    const factory = fakeSocketFactory();
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const tts = createDeepgramTts({
      apiKey: 'test-key',
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
    });
    const ended: EndReason[] = [];
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'repeat',
      createAgent: builtInAgentFactory('repeat'),
      maxDurationMs: 600_000,
      scheduler,
      logger: recordingLogger(),
      voice: { stt, tts },
      onEnded: ({ reason }) => ended.push(reason),
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    const first = factory.sockets[0]!;
    expect(first.jsonSent()).toContainEqual({ type: 'Flush' });
    first.receive({ type: 'SpeechStarted', speech_id: 's1' });
    first.receive(speechBytes());
    await flushMicrotasks();
    first.drop(1006);
    await flushMicrotasks();
    expect(floorsOf(transport).at(-1)).toBe('listening');

    scheduler.advance(250);
    await settleAll();
    const second = factory.sockets[1]!;
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'two' });
    await flushMicrotasks();
    expect(second.jsonSent()).toContainEqual({ type: 'Speak', text: 'two' });
    second.receive({ type: 'SpeechStarted', speech_id: 's2' });
    second.receive(speechBytes());
    second.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    await settleAll();
    expect(floorsOf(transport).slice(-2)).toEqual(['agent_speaking:turn_2', 'listening']);
    expect(ended).toEqual([]);
  });

  it('agent mode: the fake agent looks something up, answers, and hands the floor back', async () => {
    const transport = new FakeTransport();
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'agent',
      maxDurationMs: 600_000,
      scheduler: new ManualScheduler(),
      logger: recordingLogger(),
      voice: { stt, tts },
      createAgent: withAgent(new FakeAgentAdapter({ sleep: instant })),
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'can you check the weather' });
    await settleAll(20);
    expect(tts.calls.at(-1)).toBe('flush gen_1');
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settleAll();
    expect(floorsOf(transport)).toEqual([
      'agent_working:turn_1',
      'agent_working:turn_1(Looking that up…)',
      'agent_working:turn_1',
      'agent_speaking:turn_1',
      'listening',
    ]);
    const texts = transport.reliableStatuses.filter((m) => m.type === 'agent_text');
    expect(texts.at(-1)).toMatchObject({ final: true, turn_id: 'turn_1' });
    expect(transport.reliableStatuses.some((m) => m.type === 'notice')).toBe(false);
  });

  it('hanging up while the agent is thinking stops it and leaves no timers or late messages', async () => {
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    let aborted = false;
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'agent',
      maxDurationMs: 600_000,
      scheduler,
      logger: recordingLogger(),
      voice: { stt, tts },
      createAgent: withAgent(
        new FakeAgentAdapter({
          sleep: (_ms, signal) =>
            new Promise((_, reject) =>
              signal.addEventListener('abort', () => {
                aborted = true;
                reject(signal.reason as Error);
              }),
            ),
        }),
      ),
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello' });
    await flushMicrotasks();
    await runtime.end('hangup');
    await settleAll();
    const count = transport.reliableStatuses.length;
    expect(aborted).toBe(true);
    expect(scheduler.pending).toBe(0);
    scheduler.advance(300_000);
    await settleAll();
    expect(transport.reliableStatuses).toHaveLength(count);
  });

  it('re-sends the current floor when the caller rejoins', async () => {
    const { transport, stt } = await started();
    stt.send({ type: 'speech_started', turnIndex: 0 });
    transport.emit({ type: 'caller_left' });
    transport.emit({ type: 'caller_joined' });
    const floors = transport.reliableStatuses.filter((m) => m.type === 'floor');
    expect(floors.map((m) => [m.seq, m.floor])).toEqual([
      [1, 'user_speaking'],
      [1, 'user_speaking'],
    ]);
  });
});

const instant = (_ms: number, signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.reject(signal.reason as Error) : Promise.resolve();

describe('CallRuntime barge-in (ADR-015)', () => {
  it('caller speech over a playing answer stops it at once, and the answer never resumes', async () => {
    const { transport, stt, tts, scheduler, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await flushMicrotasks();
    // Real-time playout: each frame is held until the test lets it go.
    const gates: (() => void)[] = [];
    const realPublish = transport.publishFrame.bind(transport);
    transport.publishFrame = (samples: Int16Array) => {
      transport.published.push(samples);
      return new Promise<void>((resolve) => gates.push(resolve));
    };
    const fiveSeconds = new Uint8Array(new Int16Array(48_000 * 5).fill(500).buffer);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: fiveSeconds });
    await flushMicrotasks();
    gates.shift()!(); // the first frame has played
    await flushMicrotasks();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');

    // The caller talks over it for 200 ms before STT is confident it is speech.
    const loud = new Int16Array(SAMPLES_PER_FRAME).fill(8000);
    for (let i = 0; i < 10; i += 1) {
      transport.frame(loud);
      scheduler.advance(20);
    }
    const clearsBefore = transport.clearCount;
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    expect(transport.clearCount).toBe(clearsBefore + 1);
    expect(tts.calls).toContain('cancel gen_1');
    expect(floorsOf(transport).at(-1)).toBe('user_speaking');

    transport.publishFrame = realPublish;
    for (const open of gates.splice(0)) open(); // the frame in flight when the cut came
    await settleAll();
    expect(transport.published).toHaveLength(2); // nothing queued behind it was played
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() }); // late: dropped
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settleAll();
    expect(transport.published).toHaveLength(2);

    const fields = (name: string) => logger.events.find((e) => e.fields.event === name)?.fields;
    expect(fields('barge_in')).toMatchObject({
      turn_id: 'turn_1',
      generation_id: 'gen_1',
      detect_ms: 200,
    });
    expect(fields('tts_cancelled')).toMatchObject({ generation_id: 'gen_1', reason: 'barge_in' });
    // 250 frames queued: one played, one in flight when the cut came, the rest dropped.
    expect(fields('tts_stopped')).toMatchObject({ generation_id: 'gen_1', dropped_ms: 248 * 20 });

    // It was only noise: the old answer stays cut and the floor goes back to listening.
    stt.send({ type: 'speech_discarded', turnIndex: 1 });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('listening');
    expect(transport.published).toHaveLength(2);
  });

  it('empties an answer queued behind a stalled publish; no onset logged for a quiet caller', async () => {
    const { transport, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    transport.holdPublishing = true; // playout is real-time; the queue is still full
    const fiveSeconds = new Uint8Array(new Int16Array(48_000 * 5).fill(500).buffer);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: fiveSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await flushMicrotasks();
    transport.frame(new Int16Array(SAMPLES_PER_FRAME)); // silence: no onset
    const clearsBefore = transport.clearCount;
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    expect(transport.clearCount).toBe(clearsBefore + 1);
    expect(floorsOf(transport).at(-1)).toBe('user_speaking');
    const bargeIn = logger.events.find((e) => e.fields.event === 'barge_in')?.fields;
    expect(bargeIn).toMatchObject({ turn_id: 'turn_1', generation_id: 'gen_1' });
    expect(bargeIn).not.toHaveProperty('detect_ms');
    expect(logger.names()).toContain('tts_stopped');
  });
});

describe('CallRuntime barge-in edge cases (verifier)', () => {
  /** Agent mode with the fake agent paced by the test's clock. */
  async function paced() {
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const logger = recordingLogger();
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'agent',
      maxDurationMs: 600_000,
      scheduler,
      logger,
      voice: { stt, tts },
      createAgent: withAgent(
        new FakeAgentAdapter({
          sleep: (ms, signal) =>
            new Promise<void>((resolve, reject) => {
              if (signal.aborted) {
                reject(signal.reason as Error);
                return;
              }
              const cancel = scheduler.setTimeout(resolve, ms);
              signal.addEventListener(
                'abort',
                () => {
                  cancel();
                  reject(signal.reason as Error);
                },
                { once: true },
              );
            }),
        }),
      ),
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        scheduler.advance(20);
        await settleAll(3);
      }
    };
    return { runtime, transport, scheduler, logger, stt, tts, step };
  }

  it('the rest of a streaming answer is never sent to TTS after a barge-in, even if it was noise', async () => {
    const { transport, stt, tts, step, logger } = await paced();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await step(400); // thinking, then the first words
    expect(tts.calls[0]).toMatch(/^speak gen_1 /);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');

    stt.send({ type: 'speech_started', turnIndex: 1 });

    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    const callsAtBargeIn = tts.calls.length;
    expect(tts.calls.at(-1)).toBe('cancel gen_1');
    await step(500);
    stt.send({ type: 'speech_discarded', turnIndex: 1 });
    expect(floorsOf(transport).at(-1)).toBe('agent_working:turn_1');
    await step(10_000); // the agent streams the rest of the story and finishes
    expect(tts.calls.slice(callsAtBargeIn)).toEqual([]);
    const published = transport.published.length;
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settleAll();
    expect(transport.published).toHaveLength(published);
    expect(floorsOf(transport).at(-1)).toBe('listening');
    const texts = transport.reliableStatuses.filter((m) => m.type === 'agent_text');
    expect(texts.at(-1)).toMatchObject({ final: true });
    expect(texts.at(-1)?.type === 'agent_text' && texts.at(-1)?.text).toMatch(/whole story\.$/);
    // Nothing of what was said reaches the logs.
    expect(JSON.stringify(logger.events)).not.toMatch(/lighthouse|story/i);
  });

  it('caller barges in then asks something new: the old agent run is cancelled, the new answer plays', async () => {
    const { transport, stt, tts, step } = await paced();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await step(400);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    stt.send({ type: 'speech_started', turnIndex: 1 });
    await step(300); // the old agent keeps working while the caller talks
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'hello' });
    await step(5000);
    expect(tts.calls.some((c) => c.startsWith('speak gen_2 '))).toBe(true);
    expect(tts.calls.at(-1)).toBe('flush gen_2');
    tts.send({ type: 'audio', generationId: 'gen_2', bytes: speechBytes() });
    tts.send({ type: 'done', generationId: 'gen_2' });
    await settleAll();
    expect(floorsOf(transport).slice(-3)).toEqual([
      'agent_working:turn_2',
      'agent_speaking:turn_2',
      'listening',
    ]);
  });

  it('a barge-in of only "wait" cuts the answer, sends no turn, and leaves the floor listening (ADR-017)', async () => {
    const { transport, stt, tts, step, logger } = await paced();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await step(400);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'Wait.' });
    const callsAtCut = tts.calls.length;
    expect(tts.calls.at(-1)).toBe('cancel gen_1');
    await step(10_000); // the agent finishes its story, muted
    expect(tts.calls.slice(callsAtCut)).toEqual([]);
    expect(floorsOf(transport).at(-1)).toBe('listening');
    expect(floorsOf(transport).some((f) => f.endsWith(':turn_2'))).toBe(false);
    expect(logger.events.some((e) => e.fields.event === 'floor_control')).toBe(true);
    expect(logger.events.some((e) => e.fields.event === 'agent_turn_superseded')).toBe(false);
  });

  it('a Deepgram barge-in end to end: Interrupt sent, late socket audio dropped, next turn speaks', async () => {
    const factory = fakeSocketFactory();
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const tts = createDeepgramTts({
      apiKey: 'test-key',
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
    });
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'repeat',
      createAgent: builtInAgentFactory('repeat'),
      maxDurationMs: 600_000,
      scheduler,
      logger: recordingLogger(),
      voice: { stt, tts },
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    const socket = factory.sockets[0]!;

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    socket.receive({ type: 'SpeechStarted', speech_id: 's1' });
    socket.receive(speechBytes());
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
    const publishedAtCut = transport.published.length;

    stt.send({ type: 'speech_started', turnIndex: 1 });

    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    expect(socket.jsonSent()).toContainEqual({ type: 'Interrupt' });
    socket.receive(speechBytes()); // in flight before Deepgram saw the Interrupt
    await settleAll();
    stt.send({ type: 'speech_discarded', turnIndex: 1 });
    expect(floorsOf(transport).at(-1)).toBe('listening');

    stt.send({ type: 'turn_ended', turnIndex: 2, text: 'two' });
    await flushMicrotasks();
    socket.receive(speechBytes()); // still the interrupted turn's
    socket.receive({ type: 'SpeechInterrupted', audio_played_ms: 30 });
    await settleAll();
    expect(transport.published).toHaveLength(publishedAtCut);
    socket.receive({ type: 'SpeechStarted', speech_id: 's2' });
    socket.receive(speechBytes());
    socket.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    await settleAll();
    expect(transport.published.length).toBeGreaterThan(publishedAtCut);
    expect(floorsOf(transport).slice(-2)).toEqual(['agent_speaking:turn_2', 'listening']);
  });

  it('caller speech while TTS is reconnecting is not a barge-in, and the next turn still speaks', async () => {
    const factory = fakeSocketFactory();
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const logger = recordingLogger();
    const tts = createDeepgramTts({
      apiKey: 'test-key',
      model: 'flux-haley-en',
      socketFactory: factory,
      setInterval: () => () => undefined,
    });
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'repeat',
      createAgent: builtInAgentFactory('repeat'),
      maxDurationMs: 600_000,
      scheduler,
      logger,
      voice: { stt, tts },
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    factory.sockets[0]!.receive({ type: 'SpeechStarted', speech_id: 's1' });
    factory.sockets[0]!.receive(speechBytes());
    await settleAll();
    factory.sockets[0]!.drop(1006);
    await settleAll();
    stt.send({ type: 'speech_started', turnIndex: 1 });
    expect(logger.names()).not.toContain('barge_in');
    expect(floorsOf(transport).at(-1)).toBe('user_speaking');
    scheduler.advance(250);
    await settleAll();
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'two' });
    await flushMicrotasks();
    const second = factory.sockets[1]!;
    expect(second.jsonSent()).toContainEqual({ type: 'Speak', text: 'two' });
    second.receive({ type: 'SpeechStarted', speech_id: 's2' });
    second.receive(speechBytes());
    second.receive({ type: 'SpeechMetadata', speech_id: 's2' });
    await settleAll();
    expect(floorsOf(transport).slice(-2)).toEqual(['agent_speaking:turn_2', 'listening']);
  });

  // CONFIRMED BUG. The answer is held while the caller talks over the working agent (ADR-015),
  // released only by STT's discard or dropped by its commit. When STT drops mid-utterance and
  // reconnects, neither ever arrives: the agent's finished answer is never spoken and the floor
  // stays on user_speaking until the caller speaks again (a commit then drops the answer).
  it('an STT reconnect while the caller talks over a working agent does not strand its answer', async () => {
    const { transport, stt, tts, scheduler } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    stt.send({ type: 'speech_started', turnIndex: 1 }); // the caller keeps going
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    await settleAll(); // the repeat agent answers and finishes while held
    scheduler.advance(250);
    await settleAll();
    expect(stt.opens).toBe(2);
    scheduler.advance(10_000);
    await settleAll();
    expect(tts.calls.some((c) => c.startsWith('speak gen_1'))).toBe(true);
    expect(floorsOf(transport).at(-1)).not.toBe('user_speaking');
  });
});

describe('CallRuntime tts_stopped.dropped_ms, second pass (verifier)', () => {
  const droppedMs = (logger: ReturnType<typeof recordingLogger>) =>
    logger.events.find((e) => e.fields.event === 'tts_stopped')?.fields.dropped_ms;

  it('counts queued frames only: the in-flight frame and the end-of-speech marker are excluded', async () => {
    const { transport, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    transport.holdPublishing = true;
    const fiveSeconds = new Uint8Array(new Int16Array(48_000 * 5).fill(500).buffer); // 250 frames
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: fiveSeconds });
    tts.send({ type: 'done', generationId: 'gen_1' }); // adds only a marker (no partial frame)
    await flushMicrotasks();
    expect(transport.published).toHaveLength(1); // in flight
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    expect(droppedMs(logger)).toBe(249 * 20);
  });

  it('a partial frame still in the assembler counts pro rata; nothing queued is zero, never negative', async () => {
    const { transport, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() }); // 1.5 frames
    await settleAll(); // the whole frame is published; half a frame waits in the assembler
    expect(transport.published).toHaveLength(1);
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // not echo: confirms
    expect(droppedMs(logger)).toBe(10);
  });
});

describe('CallRuntime echo rejection (ADR-015)', () => {
  it("the agent's own voice picked up by STT neither cuts the answer nor becomes a turn", async () => {
    const { transport, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');

    stt.send({ type: 'speech_started', turnIndex: 1 });
    // Only the start of "You said: tell me a story" has played: that is what is audible.
    stt.send({ type: 'partial', turnIndex: 1, text: 'you said' });
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'you said tell me' });
    await settleAll();
    expect(tts.calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
    expect(logger.names()).not.toContain('barge_in');
    expect(logger.names().filter((n) => n === 'echo_rejected')).toHaveLength(2);
    expect(logger.names()).not.toContain('agent_turn_superseded');
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
  });
});

describe('CallRuntime echo rejection, attack pass (verifier)', () => {
  // CONFIRMED BUG, end to end. A partial proves the caller is not echo and cuts the answer; the
  // commit ("um" + the agent's words) is then judged echo and dropped. The cut answer never
  // resumes and the caller's turn is lost: the call goes silent.
  it('a caller turn whose barge-in was confirmed is not dropped as echo at commit', async () => {
    const { transport, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me about the blue one' });
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');

    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'um' }); // not echo: confirms
    expect(tts.calls).toContain('cancel gen_1');
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'um the blue one' });
    await settleAll();
    expect(logger.names()).not.toContain('echo_rejected');
    expect(floorsOf(transport)).toContain('agent_working:turn_2');
  });

  it('an STT drop during a pending barge-in leaves the answer playing and nothing pending', async () => {
    const { transport, stt, tts, scheduler } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'tell me a story' });
    await flushMicrotasks();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() });
    await settleAll();
    stt.send({ type: 'speech_started', turnIndex: 1 }); // pending, not yet confirmed
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    scheduler.advance(250);
    await settleAll();
    expect(stt.opens).toBe(2);
    expect(tts.calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
    // A stray partial from the new session without a speech start cannot cut the answer.
    stt.send({ type: 'partial', turnIndex: 0, text: 'hold on' });
    expect(tts.calls.filter((c) => c.startsWith('cancel'))).toEqual([]);
  });
});

describe('CallRuntime playout position for the echo window (verifier)', () => {
  const voiceOf = (runtime: CallRuntime) =>
    (
      runtime as unknown as {
        voice: { playedMs(id: string): number; totalAudioMs(id: string): number | undefined };
      }
    ).voice;

  it('a one-frame chunk reports playing and counts its frame; the whole answer counts once published', async () => {
    const { runtime, transport, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    tts.send({
      type: 'audio',
      generationId: 'gen_1',
      bytes: new Uint8Array(new Int16Array(SAMPLES_PER_FRAME).fill(900).buffer),
    });
    await settleAll();
    expect(floorsOf(transport).at(-1)).toBe('agent_speaking:turn_1');
    expect(voiceOf(runtime).playedMs('gen_1')).toBe(20);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speechBytes() }); // 1.5 frames
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settleAll();
    expect(voiceOf(runtime).totalAudioMs('gen_1')).toBe(60);
    expect(voiceOf(runtime).playedMs('gen_1')).toBe(60);
  });

  it('clearOutput mid-chunk: the in-flight chunk is not counted, the position stays put', async () => {
    const { runtime, transport, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await flushMicrotasks();
    transport.holdPublishing = true;
    tts.send({
      type: 'audio',
      generationId: 'gen_1',
      bytes: new Uint8Array(new Int16Array(SAMPLES_PER_FRAME * 10).fill(900).buffer),
    });
    await settleAll();
    expect(transport.published).toHaveLength(1); // first frame in flight
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'hold on' }); // real: cut
    expect(voiceOf(runtime).playedMs('gen_1')).toBe(0);
  });
});

describe('CallRuntime spoken acknowledgement switch (ADR-032)', () => {
  /** The agent thinks until the call ends, saying nothing. */
  const quiet = (_ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason as Error)),
    );

  async function silentAgentCall(switches: { presenceCues?: boolean; acknowledge?: boolean }) {
    const transport = new FakeTransport();
    const scheduler = new ManualScheduler();
    const stt = new FakeSttProvider();
    const tts = new FakeTtsProvider();
    const runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'agent',
      maxDurationMs: 600_000,
      scheduler,
      logger: recordingLogger(),
      voice: { stt, tts },
      createAgent: withAgent(new FakeAgentAdapter({ sleep: quiet })),
      ...switches,
    });
    await runtime.start();
    transport.emit({ type: 'caller_joined' });
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'check the build please' });
    await settleAll(20);
    scheduler.advance(1_500);
    await settleAll();
    return { runtime, tts };
  }

  it('speaks "one moment" in the agent’s voice when switched on', async () => {
    const { runtime, tts } = await silentAgentCall({ presenceCues: true, acknowledge: true });
    expect(tts.calls).toContain('speak gen_1 Okay, one moment.');
    await runtime.end('hangup');
  });

  it('stays quiet when switched off', async () => {
    for (const switches of [{ presenceCues: true }, { acknowledge: true }]) {
      const { runtime, tts } = await silentAgentCall(switches);
      expect(tts.calls, JSON.stringify(switches)).toEqual([]);
      await runtime.end('hangup');
    }
  });
});
