import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

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

// Verifier edge cases (Milestone 6): only a rejected credential may end a REST call; transient and
// agent-side failures fail the one turn and the call carries on. The not-streaming notice is sent
// once per call and never for a streaming agent.
const CALL_ID = 'call_restedge000000000';
const TOKEN = 'integration-test-token';

let server: FakeRestServer | undefined;
let runtime: CallRuntime | undefined;
afterEach(async () => {
  await runtime?.end('hangup');
  await server?.close();
  runtime = undefined;
  server = undefined;
});

async function callAt(url: string, token = TOKEN) {
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
    createAgent: restAgentFactory({ url, token, env: 'development' }),
    onEnded: ({ reason }) => ended.push(reason),
  });
  const starting = runtime.start();
  await vi.waitFor(() => expect(transport.states.length).toBeGreaterThan(0));
  transport.emit({ type: 'caller_joined' });
  await starting;
  return { transport, stt, tts, logger, ended };
}

async function call(serverOptions: FakeRestServerOptions) {
  server = await startFakeRestServer({ token: TOKEN, ...serverOptions });
  return { ...(await callAt(server.url)), server };
}

const notices = (transport: FakeTransport) =>
  transport.reliableStatuses.flatMap((m) => (m.type === 'notice' ? [m.code] : []));

const finalTexts = (transport: FakeTransport) =>
  transport.reliableStatuses.flatMap((m) =>
    m.type === 'agent_text' && m.final ? [m.turn_id] : [],
  );

const speech = () => new Uint8Array(new Int16Array(960).fill(1000).buffer);

describe('CallRuntime with a failing REST agent', () => {
  it.each([
    ['HTTP 500', 'status500'],
    ['HTTP 429', 'status429'],
    ['a protocol violation', 'malformed'],
    ['a dropped stream', 'drop'],
    ['a 404 (wrong path)', 'status404'],
  ])('%s fails the turn but never ends the call; the next turn is answered', async (_n, kind) => {
    let turns = 0;
    const { transport, stt, ended } = await call({
      script: async (_turn, ctx) => {
        turns += 1;
        if (turns === 1) {
          if (kind.startsWith('status')) ctx.status(Number(kind.slice(6)));
          else if (kind === 'malformed') ctx.raw('event: text.delta\ndata: {nope\n\n');
          else {
            ctx.event('run.started', {});
            await new Promise((r) => setTimeout(r, 5));
            ctx.drop();
          }
          return;
        }
        ctx.event('run.started', {});
        ctx.event('text.start', { message_id: 'm' });
        ctx.event('text.delta', { message_id: 'm', delta: 'Fine now.' });
        ctx.event('text.end', { message_id: 'm' });
        ctx.event('done', { status: 'completed' });
        await Promise.resolve();
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first' });
    await vi.waitFor(() => expect(notices(transport)).toContain('agent_failed'));
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second' });
    await vi.waitFor(() => expect(finalTexts(transport)).toContain('turn_2'));
    expect(ended).toEqual([]);
    expect(notices(transport)).not.toContain('agent_not_streaming');
  });

  it('an agent never reached on the first turn ends the call as agent_unavailable', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const { transport, stt, ended } = await callAt(`http://127.0.0.1:${port}/cord/turns`);
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'anyone there' });
    await vi.waitFor(() => expect(ended).toEqual(['agent_unavailable']), { timeout: 5_000 });
    expect(transport.endReasons).toEqual(['agent_unavailable']);
  });

  it('an agent that goes away after answering fails the turn with agent_unreachable', async () => {
    const { transport, stt, tts, ended, server: s } = await call({});
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'), { timeout: 5_000 });
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    await vi.waitFor(() => expect(finalTexts(transport)).toContain('turn_1'));
    await s.close();
    server = undefined;
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second' });
    await vi.waitFor(() => expect(notices(transport)).toContain('agent_unreachable'), {
      timeout: 5_000,
    });
    expect(ended).toEqual([]);
  });

  it('a 403 on a later turn fails only that turn (the call goes on)', async () => {
    let turns = 0;
    const { transport, stt, tts, ended } = await call({
      script: async (_turn, ctx) => {
        turns += 1;
        if (turns > 1) {
          ctx.status(403);
          return;
        }
        ctx.event('run.started', {});
        ctx.event('text.start', { message_id: 'm' });
        ctx.event('text.delta', { message_id: 'm', delta: 'One.' });
        ctx.event('text.end', { message_id: 'm' });
        ctx.event('done', { status: 'completed' });
        await Promise.resolve();
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first' });
    await vi.waitFor(() => expect(tts.calls.at(-1)).toBe('flush gen_1'));
    tts.send({ type: 'audio', generationId: 'gen_1', bytes: speech() });
    tts.send({ type: 'done', generationId: 'gen_1' });
    stt.send({ type: 'turn_ended', turnIndex: 1, text: 'second' });
    await vi.waitFor(() => expect(notices(transport)).toContain('agent_failed'));
    expect(ended).toEqual([]);
    expect(transport.endReasons).toEqual([]);
  });

  it('a 403 on the first turn ends the call as agent_unavailable', async () => {
    const { transport, stt, ended } = await call({
      script: (_turn, ctx) => {
        ctx.status(403);
        return Promise.resolve();
      },
    });
    stt.send({ type: 'turn_ended', turnIndex: 0, text: 'first' });
    await vi.waitFor(() => expect(ended).toEqual(['agent_unavailable']));
    expect(transport.endReasons).toEqual(['agent_unavailable']);
  });

  it('a final-JSON agent gets the not-streaming notice exactly once over several turns', async () => {
    const { transport, stt, tts } = await call({ mode: 'json' });
    for (let i = 0; i < 3; i += 1) {
      stt.send({ type: 'turn_ended', turnIndex: i, text: `turn ${i}` });
      await vi.waitFor(() => expect(tts.calls.at(-1)).toBe(`flush gen_${i + 1}`));
      tts.send({ type: 'audio', generationId: `gen_${i + 1}`, bytes: speech() });
      tts.send({ type: 'done', generationId: `gen_${i + 1}` });
    }
    await vi.waitFor(() => expect(finalTexts(transport)).toContain('turn_3'));
    expect(notices(transport)).toEqual(['agent_not_streaming']);
  });
});
