import {
  startFakeRestServer,
  type FakeRestServer,
  type FakeRestServerOptions,
} from '@twring/agent-adapter/fake-rest-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { restAgentFactory } from '../src/calls/agents';
import { CallRuntime, type EndReason } from '../src/calls/runtime';
import { FakeTransport, ManualScheduler, recordingLogger } from '../src/calls/testing';
import { FakeSttProvider, FakeTtsProvider } from '../src/voice/testing';

// A real RestSseAdapter (built by the gateway's REST agent factory, SSRF guard included) posts
// cord-rest/1 turns to the reference agent over real HTTP on 127.0.0.1. Media and speech are fakes.
const CALL_ID = 'call_restintegration00';
const TOKEN = 'integration-test-token';

let server: FakeRestServer | undefined;
let runtime: CallRuntime | undefined;
afterEach(async () => {
  await runtime?.end('hangup');
  await server?.close();
  runtime = undefined;
  server = undefined;
});

async function call(serverOptions: FakeRestServerOptions, token = TOKEN) {
  server = await startFakeRestServer({ token: TOKEN, ...serverOptions });
  const transport = new FakeTransport();
  const stt = new FakeSttProvider();
  const tts = new FakeTtsProvider();
  const logger = recordingLogger();
  const ended: EndReason[] = [];
  runtime = new CallRuntime({
    callId: CALL_ID,
    transport,
    audioMode: 'rest',
    maxDurationMs: 600_000,
    scheduler: new ManualScheduler(),
    logger,
    voice: { stt, tts },
    createAgent: restAgentFactory({ url: server.url, token, env: 'development' }),
    onEnded: ({ reason }) => ended.push(reason),
  });
  const starting = runtime.start();
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

const notices = (transport: FakeTransport) =>
  transport.reliableStatuses.flatMap((m) => (m.type === 'notice' ? [m.code] : []));

describe('CallRuntime with a REST + SSE agent', () => {
  it('streams the agent reply into TTS and hands the floor back', async () => {
    const { transport, stt, tts, server: agent } = await call({ mode: 'instant' });
    expect(transport.states).toEqual(['ready']);

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await vi.waitFor(() => expect(floors(transport).at(-1)).toBe('listening'));

    expect(floors(transport)).toContain('agent_speaking:turn_1');
    expect(notices(transport)).toEqual([]);
    expect(agent.requests.map((r) => r.idempotencyKey)).toEqual(['turn_1']);
  });

  it('a wrong token ends the call as agent_unavailable, without token or host in logs', async () => {
    const { transport, stt, ended, logger } = await call(
      { mode: 'instant' },
      'the-wrong-token-value',
    );
    // Connect makes no request, so the rejection surfaces on the first turn and ends the call.
    expect(transport.states).toEqual(['ready']);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(ended).toEqual(['agent_unavailable']));
    expect(transport.endReasons).toEqual(['agent_unavailable']);
    const failure = logger.events.find((e) => e.fields.event === 'agent_unavailable');
    expect(failure?.fields.error_code).toBe('auth_failed');
    const logged = JSON.stringify(logger.events);
    expect(logged).not.toContain('the-wrong-token-value');
    expect(logged).not.toContain('127.0.0.1');
  });

  it('speaks a final-JSON reply and says once that the agent does not stream', async () => {
    const { transport, stt, tts } = await call({ mode: 'json' });

    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'hello there' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    expect(tts.calls.some((c) => c.startsWith('speak gen_1 '))).toBe(true);
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await vi.waitFor(() => expect(floors(transport).at(-1)).toBe('listening'));

    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'and again' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_2'));
    expect(notices(transport)).toEqual(['agent_not_streaming']);
    const texts = transport.reliableStatuses.filter((m) => m.type === 'agent_text');
    expect(texts.at(-1)).toMatchObject({ turn_id: 'turn_2', final: true });
  });

  it('a turn committed mid-stream aborts the request and the next turn is answered', async () => {
    let turns = 0;
    const {
      server: agent,
      transport,
      stt,
      tts,
    } = await call({
      script: async (turn, ctx) => {
        turns += 1;
        ctx.event('run.started', {});
        ctx.event('text.start', { message_id: 'm' });
        if (turns === 1) {
          ctx.event('text.delta', { message_id: 'm', delta: 'Let me think ' });
          await new Promise<void>((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve()),
          );
          return;
        }
        ctx.event('text.delta', { message_id: 'm', delta: 'Second answer.' });
        ctx.event('text.end', { message_id: 'm' });
        ctx.event('done', { status: 'completed' });
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
    expect(notices(transport)).toEqual([]);
    await vi.waitFor(() => expect(agent.cancelled).toEqual(['turn_1']));
    expect(agent.received.map((t) => t.turn_id)).toEqual(['turn_1', 'turn_2']);
  });
});
