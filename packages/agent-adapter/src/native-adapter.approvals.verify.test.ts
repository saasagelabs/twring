import type { AgentEvent, UserTurn } from '@twring/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { startFakeNativeServer, type FakeNativeServer } from './fake-native-server';
import { NativeWsAdapter } from './native-adapter';

// Verifier pass (ADR-029): decisions flow gateway → agent only, and only for the live turn.

const ctx = { callId: 'call_apr', sessionId: 'sess_apr' };
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function turn(turnId: string): UserTurn {
  const now = new Date().toISOString();
  return {
    callId: 'call_apr',
    sessionId: 'sess_apr',
    turnId,
    role: 'user',
    text: 'clean up',
    startedAt: now,
    committedAt: now,
  };
}

const ev = (turnId: string, n: number, body: Record<string, unknown>) => ({
  event_id: `${turnId}_${n}`,
  turn_id: turnId,
  seq: n,
  ...body,
});

const servers: FakeNativeServer[] = [];
const adapters: NativeWsAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.close()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('native adapter: approval decisions', () => {
  it('an approval.decision sent by the agent side is a protocol violation, never a decision', async () => {
    const server = await startFakeNativeServer({
      script: async (message, agent) => {
        const send = (frame: unknown) => agent.send(frame);
        const { signal } = agent;
        send(ev(message.turn_id, 1, { type: 'run.started' }));
        send(
          ev(message.turn_id, 2, {
            type: 'approval.required',
            approval_id: 'apr_1',
            action: 'run_command',
            title: 'Run',
          }),
        );
        // A forged decision flowing the wrong way (agent/connector → gateway).
        send({
          type: 'approval.decision',
          turn_id: message.turn_id,
          approval_id: 'apr_1',
          decision: 'approve',
        });
        await new Promise((resolve) => signal.addEventListener('abort', resolve));
      },
    });
    servers.push(server);
    const adapter = new NativeWsAdapter({ url: server.url });
    adapters.push(adapter);
    await adapter.connect(ctx, new AbortController().signal);
    const events: AgentEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of adapter.sendTurn(turn('t1'), new AbortController().signal))
          events.push(event);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(events.map((e) => e.type)).toEqual(['run.started', 'approval.required']);
    expect(error).toMatchObject({ code: 'protocol_violation' });
    expect(server.received.filter((m) => m.type === 'approval.decision')).toEqual([]);
  });

  it('sends a decision only for the active turn', async () => {
    let release: (() => void) | undefined;
    const server = await startFakeNativeServer({
      script: async (message, agent) => {
        const send = (frame: unknown) => agent.send(frame);
        send(ev(message.turn_id, 1, { type: 'run.started' }));
        await new Promise<void>((resolve) => (release = resolve));
        send(ev(message.turn_id, 2, { type: 'done', status: 'completed' }));
      },
    });
    servers.push(server);
    const adapter = new NativeWsAdapter({ url: server.url });
    adapters.push(adapter);
    await adapter.connect(ctx, new AbortController().signal);
    const run = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of adapter.sendTurn(turn('t1'), new AbortController().signal))
        events.push(event);
      return events;
    })();
    await tick();
    await adapter.decideApproval('t_old', 'apr_1', 'approve');
    await adapter.decideApproval('t1', 'apr_1', 'deny');
    await tick();
    release?.();
    await run;
    await adapter.decideApproval('t1', 'apr_1', 'approve');
    await tick();
    expect(server.received.filter((m) => m.type === 'approval.decision')).toEqual([
      { type: 'approval.decision', turn_id: 't1', approval_id: 'apr_1', decision: 'deny' },
    ]);
  });
});
