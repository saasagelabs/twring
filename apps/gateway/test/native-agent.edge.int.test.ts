import {
  startFakeNativeServer,
  type FakeNativeServer,
  type FakeNativeServerOptions,
} from '@twring/agent-adapter/fake-native-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeAgentFactory } from '../src/calls/agents';
import { CallRuntime, type EndReason } from '../src/calls/runtime';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { CALL_TIMEOUTS } from '../src/calls/limits';
import { AGENT_TIMEOUTS, MERGED_TURN_NOTE } from '../src/conversation/controller';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// Verifier pass (Milestone 5): the real NativeWsAdapter under the gateway's cancel/end/timeout paths.
const CALL_ID = 'call_nativeedgecase00001';
const TOKEN = 'integration-edge-token';

let server: FakeNativeServer | undefined;
let runtime: CallRuntime | undefined;
afterEach(async () => {
  await runtime?.end('hangup');
  await server?.close();
  runtime = undefined;
  server = undefined;
});

async function call(serverOptions: FakeNativeServerOptions) {
  server = await startFakeNativeServer({ token: TOKEN, ...serverOptions });
  const transport = new FakeTransport();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const logger = recordingLogger();
  const scheduler = new ManualScheduler();
  const ended: EndReason[] = [];
  runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'native',
    maxDurationMs: 600_000,
    scheduler,
    logger,
    voice: { stt, tts },
    createAgent: nativeAgentFactory({ url: server.url, token: TOKEN, env: 'development' }),
    onEnded: ({ reason }) => ended.push(reason),
  });
  const starting = runtime.start();
  // Join once the gateway has announced a state (ready, or ending with the failure reason).
  await vi.waitFor(() => expect(transport.states.length).toBeGreaterThan(0));
  transport.emit({ type: 'caller_joined' });
  await starting;
  return { server, transport, stt, tts, logger, ended, scheduler, runtime };
}

/** Streams run.started + one delta, then waits for turn.cancel. */
const streamUntilCancelled: FakeNativeServerOptions['script'] = async (turn, ctx) => {
  const base = { turn_id: turn.turn_id };
  ctx.send({ type: 'run.started', event_id: `${turn.turn_id}_1`, ...base });
  ctx.send({
    type: 'text.delta',
    event_id: `${turn.turn_id}_2`,
    message_id: 'm',
    delta: 'Working on it ',
    ...base,
  });
  await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
};

const cancels = (s: FakeNativeServer) =>
  s.received.flatMap((m) => (m.type === 'turn.cancel' ? [`${m.turn_id}:${m.reason}`] : []));

describe('CallRuntime + Twring Native agent: cancel reasons and cleanup (verifier)', () => {
  it('BUG: hanging up mid-turn tells the agent call_ended, not superseded', async () => {
    const { server: agent, stt, tts } = await call({ script: streamUntilCancelled });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'plan my trip' });
    await vi.waitFor(() => expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true));
    await runtime!.end('hangup');
    await vi.waitFor(() => expect(cancels(agent)).toHaveLength(1));
    expect(cancels(agent)).toEqual(['turn_1:call_ended']);
  });

  it('BUG: a turn Twring gives up on (first-event timeout) is cancelled with reason timeout', async () => {
    const {
      server: agent,
      stt,
      scheduler,
      transport,
    } = await call({
      script: async (_turn, ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'are you there' });
    await vi.waitFor(() => expect(agent.received.some((m) => m.type === 'user.turn')).toBe(true));
    scheduler.advance(AGENT_TIMEOUTS.firstEventMs);
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'notice', code: 'agent_timeout' }),
      ),
    );
    await vi.waitFor(() => expect(cancels(agent)).toHaveLength(1));
    expect(cancels(agent)).toEqual(['turn_1:timeout']);
  });

  it('BUG: an agent error event (a finished turn) is not answered with turn.cancel', async () => {
    const {
      server: agent,
      stt,
      transport,
    } = await call({
      script: async (turn, ctx) => {
        const base = { turn_id: turn.turn_id };
        ctx.send({ type: 'run.started', event_id: 'e1', ...base });
        ctx.send({ type: 'error', event_id: 'e2', code: 'upstream_down', ...base });
        await Promise.resolve();
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello' });
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'notice', code: 'agent_failed' }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancels(agent)).toEqual([]);
  });

  it('a supersede sends exactly one cancel (reason superseded) and the next turn once', async () => {
    let n = 0;
    const {
      server: agent,
      stt,
      transport,
    } = await call({
      script: async (turn, ctx) => {
        n += 1;
        if (n === 1) return streamUntilCancelled(turn, ctx);
        const base = { turn_id: turn.turn_id };
        ctx.send({ type: 'text.delta', event_id: 'b1', message_id: 'm', delta: 'Ok.', ...base });
        ctx.send({ type: 'done', event_id: 'b2', status: 'completed', ...base });
        await Promise.resolve();
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first' });
    await vi.waitFor(() => expect(agent.received.some((m) => m.type === 'user.turn')).toBe(true));
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second' });
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'agent_text', turn_id: 'turn_2', final: true }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cancels(agent)).toEqual(['turn_1:superseded']);
    const turns = agent.received.flatMap((m) => (m.type === 'user.turn' ? [m.text] : []));
    // turn_1 was never heard (no audio played), so "keep talking" merges it into turn_2.
    // The merged re-send tells the agent why it came again (agent-only note).
    expect(turns).toEqual(['first', `${MERGED_TURN_NOTE} first second`]);
  });

  it('an unreachable agent ends the call as agent_unavailable without logging the URL', async () => {
    const probe = await startFakeNativeServer();
    const url = probe.url;
    await probe.close();
    const transport = new FakeTransport();
    const logger = recordingLogger();
    const ended: EndReason[] = [];
    const scheduler = new ManualScheduler();
    runtime = new CallRuntime({
      callId: CALL_ID,
      transport,
      audioMode: 'native',
      maxDurationMs: 600_000,
      scheduler,
      logger,
      voice: { stt: new FakeSttProvider(), tts: new FakeTtsProvider() },
      createAgent: nativeAgentFactory({ url, token: TOKEN, env: 'development' }),
      onEnded: ({ reason }) => ended.push(reason),
    });
    const starting = runtime.start();
    // Nobody joins: the gateway waits out the failure notice, then leaves.
    await vi.waitFor(() => {
      scheduler.advance(CALL_TIMEOUTS.failureNoticeMs);
      expect(ended).toEqual(['agent_unavailable']);
    });
    await starting;
    expect(transport.endReasons).toEqual(['agent_unavailable']);
    const logged = JSON.stringify(logger.events);
    expect(logged).not.toContain(url);
    expect(logged).not.toContain(TOKEN);
    expect(logger.events.find((e) => e.fields.event === 'agent_unavailable')?.fields).toMatchObject(
      { error_code: 'connection_failed' },
    );
  });
});
