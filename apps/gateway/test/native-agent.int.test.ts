import {
  startFakeNativeServer,
  type FakeNativeServer,
  type FakeNativeServerOptions,
} from '@twring/agent-adapter/fake-native-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeAgentFactory } from '../src/calls/agents';
import { CallRuntime, type EndReason } from '../src/calls/runtime';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// A real NativeWsAdapter (built by the gateway's native agent factory, SSRF guard included) talks
// cord-agent/1 to the reference agent over a real socket on 127.0.0.1. Media and speech are fakes.
const CALL_ID = 'call_nativeintegration0';
const TOKEN = 'integration-test-token';

let server: FakeNativeServer | undefined;
let runtime: CallRuntime | undefined;
afterEach(async () => {
  await runtime?.end('hangup');
  await server?.close();
  runtime = undefined;
  server = undefined;
});

async function call(serverOptions: FakeNativeServerOptions, token = TOKEN) {
  server = await startFakeNativeServer({ token: TOKEN, ...serverOptions });
  const transport = new FakeTransport();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const logger = recordingLogger();
  const ended: EndReason[] = [];
  runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'native',
    maxDurationMs: 600_000,
    scheduler: new ManualScheduler(),
    logger,
    voice: { stt, tts },
    createAgent: nativeAgentFactory({ url: server.url, token, env: 'development' }),
    onEnded: ({ reason }) => ended.push(reason),
  });
  const starting = runtime.start();
  // Join once the gateway has announced a state (ready, or ending with the failure reason).
  await vi.waitFor(() => expect(transport.states.length).toBeGreaterThan(0));
  transport.emit({ type: 'caller_joined' });
  await starting;
  return { server, transport, stt, tts, logger, ended };
}

const speech = () => new Uint8Array(new Int16Array(960).fill(1000).buffer);

function floors(transport: FakeTransport): string[] {
  return transport.reliableStatuses.flatMap((m) =>
    m.type === 'floor' ? [`${m.floor}${m.turn_id !== undefined ? `:${m.turn_id}` : ''}`] : [],
  );
}

describe('CallRuntime with a Twring Native agent', () => {
  it('streams the agent reply into TTS and hands the floor back', async () => {
    const { transport, stt, tts } = await call({ mode: 'instant' });
    expect(transport.states).toEqual(['ready']);

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await vi.waitFor(() => expect(floors(transport).at(-1)).toBe('listening'));

    expect(floors(transport)).toContain('agent_speaking:turn_1');
    const texts = transport.reliableStatuses.filter((m) => m.type === 'agent_text');
    expect(texts.at(-1)).toMatchObject({ turn_id: 'turn_1', final: true });
    expect(transport.reliableStatuses.some((m) => m.type === 'notice')).toBe(false);
  });

  it('ends the call as agent_unavailable when the agent rejects the token', async () => {
    const { transport, ended, logger } = await call({ mode: 'instant' }, 'the-wrong-token-value');
    expect(ended).toEqual(['agent_unavailable']);
    expect(transport.states).toEqual(['ending']);
    expect(transport.endReasons).toEqual(['agent_unavailable']);
    const failure = logger.events.find((e) => e.fields.event === 'agent_unavailable');
    expect(failure?.fields.error_code).toBe('auth_failed');
    const logged = JSON.stringify(logger.events);
    expect(logged).not.toContain('the-wrong-token-value');
    expect(logged).not.toContain('127.0.0.1');
  });

  it('reports a mid-turn drop, then reconnects and answers the next turn', async () => {
    let turns = 0;
    const {
      server: agent,
      transport,
      stt,
      tts,
    } = await call({
      script: async (turn, ctx) => {
        turns += 1;
        const base = { turn_id: turn.turn_id };
        ctx.send({ type: 'run.started', event_id: `${turn.turn_id}_a`, ...base });
        ctx.send({ type: 'text.start', event_id: `${turn.turn_id}_b`, message_id: 'm', ...base });
        ctx.send({
          type: 'text.delta',
          event_id: `${turn.turn_id}_c`,
          message_id: 'm',
          delta: turns === 1 ? 'Let me ' : 'Back again.',
          ...base,
        });
        if (turns === 1) {
          ctx.drop();
          return;
        }
        ctx.send({ type: 'text.end', event_id: `${turn.turn_id}_d`, message_id: 'm', ...base });
        ctx.send({ type: 'done', event_id: `${turn.turn_id}_e`, status: 'completed', ...base });
        await Promise.resolve();
      },
    });

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first question' });
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'notice', code: 'agent_failed' }),
      ),
    );

    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second question' });
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'agent_text', turn_id: 'turn_2', final: true }),
      ),
    );
    const spoken = tts.calls.flatMap((c) => (c.startsWith('speak gen_2 ') ? [c.slice(12)] : []));
    expect(spoken.join('')).toBe('Back again.');
    tts.send({ type: 'audio', generationId: 'gen_2', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_2' });
    await vi.waitFor(() => expect(floors(transport).at(-1)).toBe('listening'));
    // Two sessions (the drop forced a fresh handshake); each turn was sent exactly once.
    expect(agent.received.filter((m) => m.type === 'session.hello')).toHaveLength(2);
    expect(agent.received.filter((m) => m.type === 'user.turn')).toHaveLength(2);
  });
  it('answers a turn committed while the agent is still streaming the previous one', async () => {
    let turns = 0;
    const {
      server: agent,
      transport,
      stt,
      tts,
    } = await call({
      script: async (turn, ctx) => {
        turns += 1;
        const first = turns === 1;
        const base = { turn_id: turn.turn_id };
        const id = (n: number) => `${turn.turn_id}_${n}`;
        ctx.send({ type: 'run.started', event_id: id(1), ...base });
        ctx.send({ type: 'text.start', event_id: id(2), message_id: 'm', ...base });
        ctx.send({
          type: 'text.delta',
          event_id: id(3),
          message_id: 'm',
          delta: first ? 'Let me think ' : 'Second answer.',
          ...base,
        });
        if (first) {
          // Still streaming when the caller's next turn commits; wind down only on turn.cancel.
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve()),
          );
          ctx.send({
            type: 'text.delta',
            event_id: id(4),
            message_id: 'm',
            delta: 'late',
            ...base,
          });
          ctx.send({ type: 'done', event_id: id(5), status: 'cancelled', ...base });
          return;
        }
        ctx.send({ type: 'text.end', event_id: id(4), message_id: 'm', ...base });
        ctx.send({ type: 'done', event_id: id(5), status: 'completed', ...base });
        await Promise.resolve();
      },
    });

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first question' });
    await vi.waitFor(() => expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true));

    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'actually, something else' });
    await vi.waitFor(() =>
      expect(transport.reliableStatuses).toContainEqual(
        expect.objectContaining({ type: 'agent_text', turn_id: 'turn_2', final: true }),
      ),
    );
    const spoken = tts.calls.flatMap((c) => (c.startsWith('speak gen_2 ') ? [c.slice(12)] : []));
    expect(spoken.join('')).toBe('Second answer.');
    expect(tts.calls.some((c) => c.includes('late'))).toBe(false);
    expect(
      transport.reliableStatuses.some((m) => m.type === 'notice' && m.code === 'agent_failed'),
    ).toBe(false);
    // Let any stray cancel for the finished turn_2 arrive before checking none was sent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sent = agent.received.flatMap((m) =>
      m.type === 'user.turn' || m.type === 'turn.cancel' ? [`${m.type}:${m.turn_id}`] : [],
    );
    expect(sent).toEqual(['user.turn:turn_1', 'turn.cancel:turn_1', 'user.turn:turn_2']);
  });
});
