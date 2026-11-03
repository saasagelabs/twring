import { describe, expect, it } from 'vitest';

import { AdapterError, type TwringAgentAdapter } from '@twring/agent-adapter';
import type { AgentEvent, CallHistoryItem, CallUsage } from '@twring/contracts';

import { SAMPLES_PER_FRAME } from '../audio/pcm';
import { STT_IDLE_KEEPALIVE_MS } from '../voice/pipeline';
import { FakeSttProvider, FakeTtsProvider } from '../voice/testing';

import { builtInAgentFactory } from './agents';
import { CallRuntime, type EndReason } from './runtime';
import { FakeTransport, ManualScheduler, flushMicrotasks, recordingLogger } from './testing';
import { estimateCost, rollupUsage } from './usage';

const CALL_ID = 'call_aaaaaaaaaaaaaaaaaaaa';
const bytes = (ms: number) => new Uint8Array(new Int16Array(48 * ms).fill(500).buffer);

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await flushMicrotasks();
}

function setup(
  opts: {
    agent?: TwringAgentAdapter;
    rates?: { sttPerMinute: number; ttsPer1kChars: number; roomPerMinute: number };
  } = {},
) {
  const transport = new FakeTransport();
  const scheduler = new ManualScheduler();
  const logger = recordingLogger();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const ended: { reason: EndReason; usage: CallUsage }[] = [];
  const runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'repeat',
    createAgent: opts.agent ? () => Promise.resolve(opts.agent!) : builtInAgentFactory('repeat'),
    maxDurationMs: 3_700_000,
    scheduler,
    logger,
    voice: { stt, tts },
    ...(opts.rates && { usageRates: opts.rates }),
    onEnded: ({ reason, usage }) => ended.push({ reason, usage }),
  });
  return { runtime, transport, scheduler, logger, stt, tts, ended };
}

async function started(opts: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(opts);
  await ctx.runtime.start();
  ctx.transport.emit({ type: 'caller_joined' });
  return ctx;
}

/** The generation most recently sent text to TTS. */
function lastGen(tts: FakeTtsProvider): string | undefined {
  const call = [...tts.calls].reverse().find((c) => c.startsWith('speak '));
  return call?.split(' ')[1];
}

function floorSeqs(transport: FakeTransport): number[] {
  return transport.reliableStatuses.flatMap((m) => (m.type === 'floor' ? [m.seq] : []));
}

describe('call usage telemetry', () => {
  it('logs one call_usage line with counts only, and hands the same usage to onEnded', async () => {
    const { runtime, transport, scheduler, stt, tts, logger, ended } = await started();
    for (let i = 0; i < 50; i += 1) transport.frame(new Int16Array(SAMPLES_PER_FRAME)); // 1 s
    stt.send({ type: 'speech_started', turnIndex: 0 });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'secret words' });
    await settle();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: bytes(500) });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await settle();
    scheduler.advance(60_000);
    await runtime.end('hangup');

    const lines = logger.events.filter((e) => e.fields.event === 'call_usage');
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('secret');
    const usage = ended[0]!.usage;
    expect(lines[0]!.fields).toMatchObject({ reason: 'hangup', ...usage });
    expect(usage).toMatchObject({
      tts_chars: 'You said: secret words'.length,
      tts_audio_s: 0.5,
      agent_turns: 1,
      agent_turns_completed: 1,
      agent_turns_failed: 0,
      barge_ins: 0,
      gateway_connected_s: 60,
      stt_connected_s: 60,
      stt_reconnects: 0,
      tts_reconnects: 0,
    });
    // 1 s of caller audio plus keepalive silence while the caller was quiet.
    expect(usage.stt_audio_s).toBeGreaterThanOrEqual(1);
    expect(usage.stt_audio_s).toBeLessThan(3);
    expect(usage.estimated_cost_usd).toBeUndefined();
  });

  it('estimates cost only from rates that are set', async () => {
    const { runtime, scheduler, ended } = await started({
      rates: { sttPerMinute: 0, ttsPer1kChars: 0, roomPerMinute: 0.01 },
    });
    scheduler.advance(120_000);
    await runtime.end('hangup');
    expect(ended[0]!.usage.estimated_cost_usd).toBeCloseTo(0.02, 6);
    const base = ended[0]!.usage;
    expect(estimateCost(base, { sttPerMinute: 0, ttsPer1kChars: 0, roomPerMinute: 0 })).toBe(
      undefined,
    );
  });

  it('rolls usage up per UTC day and agent', () => {
    const usage = (turns: number): CallUsage => ({
      stt_audio_s: 1.5,
      stt_connected_s: 2,
      tts_chars: 10,
      tts_audio_s: 1,
      agent_turns: turns,
      agent_turns_completed: turns,
      agent_turns_failed: 0,
      barge_ins: 1,
      gateway_connected_s: 3,
      stt_reconnects: 0,
      tts_reconnects: 0,
      estimated_cost_usd: 0.1,
    });
    const item = (day: string, agent: string, u?: CallUsage): CallHistoryItem => ({
      call_id: CALL_ID,
      agent_id: agent,
      agent_name: 'A',
      started_at: `${day}T10:00:00.000Z`,
      duration_s: 5,
      outcome: 'completed',
      end_reason: 'hangup',
      ...(u && { usage: u }),
    });
    const rows = rollupUsage([
      item('2026-09-02', 'agt_b', usage(1)),
      item('2026-09-01', 'agt_a', usage(2)),
      item('2026-09-01', 'agt_a', usage(3)),
      item('2026-09-01', 'agt_a'),
    ]);
    expect(rows.map((r) => [r.day, r.agent_id, r.calls, r.calls_with_usage])).toEqual([
      ['2026-09-01', 'agt_a', 3, 2],
      ['2026-09-02', 'agt_b', 1, 1],
    ]);
    expect(rows[0]!.usage).toMatchObject({
      agent_turns: 5,
      stt_audio_s: 3,
      barge_ins: 2,
      estimated_cost_usd: 0.2,
    });
    expect(rows[0]!.duration_s).toBe(15);
  });
});

describe('long calls', () => {
  it('sends STT keepalive silence only while caller audio has stopped', async () => {
    const { transport, scheduler, stt } = await started();
    for (let i = 0; i < 200; i += 1) {
      transport.frame(new Int16Array(SAMPLES_PER_FRAME));
      scheduler.advance(20);
    }
    expect(stt.samplesReceived).toBe(200 * 320); // talking: no keepalive
    scheduler.advance(STT_IDLE_KEEPALIVE_MS * 3);
    expect(stt.samplesReceived).toBeGreaterThan(200 * 320);
  });

  it('a 60-minute soak of turns, barge-ins, reconnects and rejoins keeps state and timers bounded', async () => {
    const { runtime, transport, scheduler, stt, tts, logger, ended } = await started();
    const max: Record<string, number> = {};
    let maxPending = 0;
    let turnIndex = 0;
    let turns = 0;
    let bargeIns = 0;
    const sample = () => {
      for (const [k, v] of Object.entries(runtime.retainedState()))
        max[k] = Math.max(max[k] ?? 0, v);
      maxPending = Math.max(maxPending, scheduler.pending);
    };
    for (let minute = 0; minute < 60; minute += 1) {
      for (let i = 0; i < 25; i += 1) transport.frame(new Int16Array(SAMPLES_PER_FRAME));
      // An ordinary turn, answered in full.
      stt.send({ type: 'speech_started', turnIndex });
      stt.send({ type: 'turn_ended', turnIndex, text: `question number ${minute}` });
      turnIndex += 1;
      turns += 1;
      await settle();
      const gen = lastGen(tts)!;
      tts.send({ type: 'audio', generationId: gen, bytes: bytes(200) });
      tts.send({ type: 'done', generationId: gen });
      await settle();
      sample();
      if (minute % 3 === 0) {
        // A barge-in over an answer still playing, then a new question.
        stt.send({ type: 'turn_ended', turnIndex, text: `tell me a long story ${minute}` });
        turnIndex += 1;
        turns += 1;
        await settle();
        // Audio still arriving (no `done`): the answer is playing when the caller cuts in.
        const playing = lastGen(tts)!;
        tts.send({ type: 'audio', generationId: playing, bytes: bytes(2000) });
        await settle();
        stt.send({ type: 'speech_started', turnIndex });
        stt.send({ type: 'partial', turnIndex, text: 'no something else please' });
        stt.send({ type: 'turn_ended', turnIndex, text: 'no something else please' });
        turnIndex += 1;
        turns += 1;
        bargeIns += 1;
        await settle();
        const next = lastGen(tts)!;
        tts.send({ type: 'audio', generationId: next, bytes: bytes(100) });
        tts.send({ type: 'done', generationId: next });
        await settle();
        sample();
      }
      if (minute % 10 === 9) {
        stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
        scheduler.advance(250);
        await settle();
        turnIndex = 0; // Flux numbers turns per connection
      }
      if (minute % 15 === 14) {
        tts.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
        scheduler.advance(250);
        await settle();
      }
      if (minute % 20 === 19) {
        transport.emit({ type: 'caller_left' });
        scheduler.advance(5_000);
        transport.emit({ type: 'caller_joined' });
      }
      sample();
      scheduler.advance(60_000 - (scheduler.now() % 60_000));
      await settle();
    }
    expect(ended).toEqual([]);
    expect(logger.names()).not.toContain('voice_failed');
    expect(max['voice.playout']).toBeLessThanOrEqual(8);
    expect(max['voice.timers']).toBeLessThanOrEqual(2);
    // Cut and finished generations stay only for their echo tail, pruned on the next speech.
    expect(max['conversation.generations']).toBeLessThanOrEqual(6);
    expect(max['conversation.turnTimers']).toBeLessThanOrEqual(3);
    expect(max.runtimeTimers).toBeLessThanOrEqual(3);
    expect(max.drainedCallbacks).toBe(0);
    expect(maxPending).toBeLessThanOrEqual(8);
    // Floor seq only ever moves forward by one (a rejoin re-sends the same seq).
    const seqs = floorSeqs(transport);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]! - seqs[i - 1]!).toBeOneOf([0, 1]);

    await runtime.end('hangup');
    await settle();
    expect(scheduler.pending).toBe(0);
    const usage = ended[0]!.usage;
    expect(usage).toMatchObject({
      agent_turns: turns,
      barge_ins: bargeIns,
      stt_reconnects: 6,
      tts_reconnects: 4,
      gateway_connected_s: 3600,
    });
    expect(usage.stt_connected_s).toBeCloseTo(3600 - 6 * 0.25, 0);
  }, 60_000);
});

describe('provider and adapter drops', () => {
  it('STT drop while the agent speaks: the answer plays on, nothing is discarded, next turn works', async () => {
    const { scheduler, stt, tts, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'one' });
    await settle();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: bytes(1000) });
    await settle();
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    expect(tts.calls).not.toContain('cancel gen_1');
    expect(logger.names()).not.toContain('user_speech_discarded');
    scheduler.advance(250);
    await settle();
    expect(stt.opens).toBe(2);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'two' });
    await settle();
    expect(tts.calls.some((c) => c.startsWith('speak gen_2'))).toBe(true);
  });

  it('TTS drop right after a barge-in: no stuck floor, next answer speaks after reconnect', async () => {
    const { transport, scheduler, stt, tts } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'story please now' });
    await settle();
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: bytes(2000) });
    await settle();
    stt.send({ type: 'speech_started', turnIndex: 1 });
    stt.send({ type: 'partial', turnIndex: 1, text: 'actually a different thing' });
    tts.send({
      type: 'error',
      generationId: 'gen_1',
      error: { code: 'connection_lost', recoverable: true },
    });
    scheduler.advance(250);
    await settle();
    expect(tts.opens).toBe(2);
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'actually a different thing' });
    await settle();
    const gen = lastGen(tts)!;
    tts.send({ type: 'audio', generationId: gen, bytes: bytes(100) });
    tts.send({ type: 'done', generationId: gen });
    await settle();
    const floors = transport.reliableStatuses.filter((m) => m.type === 'floor');
    expect(floors.at(-1)).toMatchObject({ floor: 'listening' });
  });

  it('both providers dropping at once reconnect independently, each on the bounded delay', async () => {
    const { scheduler, stt, tts, ended } = await started();
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    tts.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    scheduler.advance(249);
    await settle();
    expect([stt.opens, tts.opens]).toEqual([1, 1]);
    scheduler.advance(1);
    await settle();
    expect([stt.opens, tts.opens]).toEqual([2, 2]);
    expect(ended).toEqual([]);
  });

  it('a reconnect storm (accept then drop at once) escalates the delays and then fails the call', async () => {
    const { scheduler, stt, ended } = await started();
    const opensAt: number[] = [];
    for (const delay of [250, 1000, 3000]) {
      stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
      scheduler.advance(delay - 1);
      await settle();
      const before = stt.opens;
      scheduler.advance(1);
      await settle();
      expect(stt.opens).toBe(before + 1);
      opensAt.push(scheduler.now());
    }
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    await settle();
    expect(ended.map((e) => e.reason)).toEqual(['voice_failed']);
  });

  it('a reconnected session that stays up restores the full retry budget', async () => {
    const { scheduler, stt, ended } = await started();
    for (let i = 0; i < 5; i += 1) {
      stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
      scheduler.advance(250);
      await settle();
      scheduler.advance(10_000);
    }
    expect(stt.opens).toBe(6);
    expect(ended).toEqual([]);
  });

  it('agent socket drop during a tool call fails that turn only; the call and next turn go on', async () => {
    let n = 0;
    const agent: TwringAgentAdapter = {
      name: 'cord-native',
      capabilities: {
        streamingText: true,
        toolEvents: true,
        cancellation: false,
      } as TwringAgentAdapter['capabilities'],
      connect: () => Promise.resolve(),
      close: () => Promise.resolve(),
      async *sendTurn(turn) {
        await Promise.resolve();
        n += 1;
        const base = { turn_id: turn.turnId } as const;
        const ev = (e: Record<string, unknown>, i: number) =>
          ({ ...base, event_id: `${turn.turnId}_${i}`, ...e }) as unknown as AgentEvent;
        if (n === 1) {
          yield ev({ type: 'tool.start', tool_name: 'lookup', tool_call_id: 't1' }, 1);
          throw new AdapterError('connection_failed');
        }
        yield ev({ type: 'text.delta', message_id: 'm1', delta: 'fine' }, 1);
        yield ev({ type: 'done', status: 'completed' }, 2);
      },
    };
    const { stt, tts, transport, ended, logger } = await started({ agent });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'look it up' });
    await settle();
    expect(ended).toEqual([]);
    expect(transport.reliableStatuses).toContainEqual(
      expect.objectContaining({ type: 'notice', code: 'agent_unreachable' }),
    );
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'and now' });
    await settle();
    expect(tts.calls.some((c) => c.startsWith('speak') && c.endsWith('fine'))).toBe(true);
    expect(logger.names()).toContain('agent_turn_done');
  });
});

describe('duplicate event protection', () => {
  it('a repeated EndOfTurn for the same turn index commits once; a new STT session starts over', async () => {
    const { scheduler, stt, logger } = await started();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    stt.send({ type: 'speech_discarded', turnIndex: 0 });
    await settle();
    expect(logger.names().filter((n) => n === 'turn_committed')).toHaveLength(1);
    expect(logger.names().filter((n) => n === 'agent_request_started')).toHaveLength(1);
    expect(logger.names()).toContain('stt_duplicate_end_ignored');
    stt.send({ type: 'error', error: { code: 'connection_lost', recoverable: true } });
    scheduler.advance(250);
    await settle();
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'again' });
    await settle();
    expect(logger.names().filter((n) => n === 'turn_committed')).toHaveLength(2);
  });
});
