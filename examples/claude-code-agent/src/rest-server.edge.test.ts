import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';

import { RestSseAdapter } from '@twring/agent-adapter';
import type { AgentEvent } from '@twring/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeChild } from './claude-command';
import { toolTurnLines, interruptedResult } from './fixtures';
import { startClaudeAgentServer, type ClaudeAgentServer } from './server';

// Verifier edge cases for the cord-rest/1 endpoint of the Claude dogfood agent (Milestone 6).
// A fake child stands in for `claude`; nothing real is spawned.

class FakeClaude extends EventEmitter implements ClaudeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Record<string, unknown>[] = [];
  killed = false;
  constructor(
    readonly behave: { init: 'answer' | 'hold' | 'refuse'; turns: 'answer' | 'stall' | 'exit' },
  ) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        this.written.push(msg);
        this.onMessage(msg);
      }
    });
  }
  pendingInit: string | undefined;
  answerInit() {
    this.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: this.pendingInit },
    });
  }
  private onMessage(msg: Record<string, unknown>) {
    const req = msg.request as { subtype?: string } | undefined;
    if (msg.type === 'control_request' && req?.subtype === 'initialize') {
      this.pendingInit = msg.request_id as string;
      if (this.behave.init === 'answer') this.answerInit();
      if (this.behave.init === 'refuse')
        this.out({
          type: 'control_response',
          response: { subtype: 'error', request_id: msg.request_id },
        });
      return;
    }
    if (msg.type === 'control_request' && req?.subtype === 'interrupt') {
      this.out(interruptedResult);
      return;
    }
    if (msg.type === 'user') {
      if (this.behave.turns === 'answer') for (const line of toolTurnLines) this.out(line);
      else if (this.behave.turns === 'stall') this.out(toolTurnLines[0]);
      else {
        this.out(toolTurnLines[0]);
        setTimeout(() => this.emit('exit', 1), 5);
      }
    }
  }
  out(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  killTree() {
    this.killed = true;
    this.emit('exit', null);
  }
}

const TOKEN = 'test-token';
const turn = (turnId: string, sessionId = 's', text = 'hello') => {
  const now = new Date().toISOString();
  return {
    callId: 'c',
    sessionId,
    turnId,
    role: 'user' as const,
    text,
    startedAt: now,
    committedAt: now,
  };
};

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

let server: ClaudeAgentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(
  behave: ConstructorParameters<typeof FakeClaude>[0],
  extra: {
    restIdleMs?: number;
    restHeartbeatMs?: number;
    initTimeoutMs?: number;
    restBodyTimeoutMs?: number;
  } = {},
) {
  const children: FakeClaude[] = [];
  server = await startClaudeAgentServer({
    port: 0,
    token: TOKEN,
    spawnClaude: () => {
      const c = new FakeClaude(behave);
      children.push(c);
      return c;
    },
    interruptTimeoutMs: 100,
    ...extra,
  });
  const adapter = new RestSseAdapter({ url: server.restUrl, token: TOKEN });
  await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
  return { children, adapter, server };
}

/** A raw POST, for bodies RestSseAdapter never sends. */
function post(url: string, body: string, headers: Record<string, string> = {}, method = 'POST') {
  return new Promise<number>((resolve, reject) => {
    const req = request(
      url,
      { method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('Claude agent cord-rest/1 endpoint edge cases', () => {
  it('a turn whose request closes before Claude is ready never reaches Claude', async () => {
    const { children, adapter } = await start({ init: 'hold', turns: 'answer' });
    const controller = new AbortController();
    const done = collect(adapter.sendTurn(turn('t_early'), controller.signal));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort('barge_in');
    expect(await done).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    children[0]!.answerInit();
    await new Promise((r) => setTimeout(r, 20));
    expect(children[0]!.written.filter((m) => m.type === 'user')).toHaveLength(0);
  });

  it('Claude failing to start answers 503 (agent_error), and the next turn starts a fresh process', async () => {
    const { children, adapter } = await start({ init: 'refuse', turns: 'answer' });
    const error = await collect(adapter.sendTurn(turn('t1'), new AbortController().signal)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe('agent_error');
    expect(String(error)).toContain('503');
    await collect(adapter.sendTurn(turn('t2'), new AbortController().signal)).catch(
      () => undefined,
    );
    expect(children).toHaveLength(2);
  });

  it('Claude exiting mid-turn ends that SSE reply with error, and the next turn restarts Claude', async () => {
    const { children, adapter } = await start({ init: 'answer', turns: 'exit' });
    const events = await collect(adapter.sendTurn(turn('t1'), new AbortController().signal));
    expect(events.map((e) => e.type).at(-1)).toBe('error');
    await collect(adapter.sendTurn(turn('t2'), new AbortController().signal));
    expect(children).toHaveLength(2);
  });

  it('a superseding turn that arrives before the old request closes still runs after the interrupt', async () => {
    const { children, adapter } = await start({ init: 'answer', turns: 'stall' });
    const c1 = new AbortController();
    const it1 = adapter.sendTurn(turn('t1'), c1.signal)[Symbol.asyncIterator]();
    expect((await it1.next()).value).toMatchObject({ type: 'run.started' });
    // Next turn is posted first; the old request is closed only afterwards.
    const second = collect(adapter.sendTurn(turn('t2'), new AbortController().signal));
    await new Promise((r) => setTimeout(r, 30));
    children[0]!.behave.turns = 'answer';
    c1.abort('superseded');
    await it1.next();
    const events = await second;
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(events.every((e) => e.turn_id === 't2')).toBe(true);
    expect(children).toHaveLength(1);
  });

  it('SSE heartbeats flow while a turn runs and stop after it ends', async () => {
    const { children, server: s } = await start(
      { init: 'answer', turns: 'stall' },
      { restHeartbeatMs: 20 },
    );
    const adapter = new RestSseAdapter({
      url: s.restUrl,
      token: TOKEN,
      timeouts: { idleMs: 300 },
    });
    await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    const controller = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of adapter.sendTurn(turn('t_hb'), controller.signal)) seen.push(e.type);
    })();
    // Idle is 300 ms; heartbeats every 20 ms keep a 900 ms stall alive. The wide margin keeps a
    // busy machine (the whole workspace testing in parallel) from tripping the idle timer.
    await new Promise((r) => setTimeout(r, 900));
    controller.abort('barge_in');
    await run;
    expect(seen).toEqual(['run.started']);
    expect(children).toHaveLength(1);
  });

  it('refuses other paths and methods, oversize bodies, and invalid bodies', async () => {
    const { server: s, children } = await start({ init: 'answer', turns: 'answer' });
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect(await post(`${s.restUrl}?x=1`, '{}', auth)).toBe(404);
    expect(await post(s.restUrl, '', auth, 'GET')).toBe(404);
    expect(await post(s.restUrl, '{}', { Authorization: 'Bearer nope' })).toBe(401);
    expect(await post(s.restUrl, 'x'.repeat(70_000), auth)).toBe(413);
    expect(await post(s.restUrl, '{"protocol":"cord-rest/1"}', auth)).toBe(400);
    const long = JSON.stringify({
      protocol: 'cord-rest/1',
      session_id: 's',
      call_id: 'c',
      turn_id: 't',
      text: 'y'.repeat(9000),
      started_at: 'x',
      committed_at: 'x',
    });
    expect(await post(s.restUrl, long, auth)).toBe(400);
    expect(children).toHaveLength(0);
  });

  it('refuses a same-length wrong token', async () => {
    const { server: s } = await start({ init: 'answer', turns: 'answer' });
    const wrong = 'x'.repeat(TOKEN.length);
    expect(await post(s.restUrl, '{}', { Authorization: `Bearer ${wrong}` })).toBe(401);
  });

  it('a body that never finishes arriving is answered 408 and the connection dropped', async () => {
    const { server: s } = await start(
      { init: 'answer', turns: 'answer' },
      { restBodyTimeoutMs: 50 },
    );
    const outcome = await new Promise<number | string>((resolve) => {
      const req = request(
        s.restUrl,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            'Content-Type': 'application/json',
            'Content-Length': '1000',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => resolve('closed'));
      req.write('{"protocol":');
    });
    expect([408, 'closed']).toContain(outcome);
  });

  it('remembers only the most recent turn ids per session (bounded memory)', async () => {
    const { adapter } = await start({ init: 'answer', turns: 'answer' });
    for (let i = 0; i <= 256; i += 1) {
      await collect(adapter.sendTurn(turn(`t${i}`), new AbortController().signal));
    }
    // t0 fell out of the window; t256 is still refused as a duplicate.
    const again = await collect(adapter.sendTurn(turn('t0'), new AbortController().signal));
    expect(again.at(-1)?.type).toBe('done');
    const dup = await collect(adapter.sendTurn(turn('t256'), new AbortController().signal)).then(
      () => 'ok',
      () => 'refused',
    );
    expect(dup).toBe('refused');
  }, 20_000);

  it('separate session_ids get separate Claude processes', async () => {
    const { children, adapter } = await start({ init: 'answer', turns: 'answer' });
    await collect(adapter.sendTurn(turn('t1', 'sess_a'), new AbortController().signal));
    await collect(adapter.sendTurn(turn('t1', 'sess_b'), new AbortController().signal));
    expect(children).toHaveLength(2);
  });

  it('the idle timer does not kill a process while a turn is still running', async () => {
    const { children, adapter } = await start(
      { init: 'answer', turns: 'stall' },
      { restIdleMs: 20 },
    );
    const controller = new AbortController();
    const run = collect(adapter.sendTurn(turn('t1'), controller.signal));
    await new Promise((r) => setTimeout(r, 80));
    expect(children[0]!.killed).toBe(false);
    controller.abort('barge_in');
    await run;
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true));
  });
});
