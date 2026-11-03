import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { agentEventSchema, type AgentEvent } from '@twring/contracts';
import { NativeWsAdapter, RestSseAdapter } from '@twring/agent-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildClaudeArgs, type ClaudeChild } from './claude-command';
import { interruptedResult, toolTurnLines } from './fixtures';
import { TurnMapper } from './mapper';
import { startClaudeAgentServer } from './server';
import { ClaudeSession } from './session';

let counter = 0;
const ids = () => `evt_${counter++}`;

describe('TurnMapper', () => {
  it('maps a real tool turn: text, tool start/end, more text, done; never thinking', () => {
    const mapper = new TurnMapper({ turnId: 't1', newEventId: ids });
    const events = toolTurnLines.flatMap((line) => mapper.map(line));
    for (const e of events) expect(agentEventSchema.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'run.started',
      'text.start',
      'text.delta',
      'text.delta',
      'text.end',
      'tool.start',
      'tool.end',
      'text.start',
      'text.delta',
      'text.end',
      'done',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
    const tool = events.find((e) => e.type === 'tool.start');
    expect(tool).toMatchObject({ tool_name: 'WebSearch', display_label: 'Searching the web…' });
    expect(events.find((e) => e.type === 'tool.end')).toMatchObject({ status: 'success' });
    expect(JSON.stringify(events)).not.toContain('secret reasoning');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(mapper.finished).toBe(true);
    expect(mapper.map(toolTurnLines[3])).toEqual([]);
  });

  it('maps an error result to error + done failed and closes open tools', () => {
    const mapper = new TurnMapper({ turnId: 't1', newEventId: ids });
    toolTurnLines.slice(0, 9).forEach((line) => mapper.map(line));
    const events = mapper.map(interruptedResult);
    expect(events.map((e) => e.type)).toEqual(['tool.end', 'error', 'done']);
    expect(events[1]).toMatchObject({ code: 'claude_error' });
    expect(events[2]).toMatchObject({ status: 'failed' });
  });

  it('splits oversized deltas and ignores malformed input', () => {
    const mapper = new TurnMapper({ turnId: 't1', newEventId: ids });
    expect(mapper.map('nope')).toEqual([]);
    mapper.map(toolTurnLines[2]);
    mapper.map(toolTurnLines[3]);
    const big = mapper.map({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'a'.repeat(9000) },
      },
    });
    expect(big.map((e) => e.type)).toEqual(['text.delta', 'text.delta', 'text.delta']);
    for (const e of big) expect(agentEventSchema.safeParse(e).success).toBe(true);
  });
});

class FakeClaude extends EventEmitter implements ClaudeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Record<string, unknown>[] = [];
  killed = false;
  constructor(answerInit = true) {
    super();
    let buffer = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        this.written.push(msg);
        const req = msg.request as { subtype?: string } | undefined;
        if (answerInit && msg.type === 'control_request' && req?.subtype === 'initialize') {
          this.out({
            type: 'control_response',
            response: { subtype: 'success', request_id: msg.request_id },
          });
        }
      }
    });
  }
  out(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  killTree() {
    this.killed = true;
    this.emit('exit', null);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 10));

function setup(answerInit = true) {
  const children: FakeClaude[] = [];
  const events: AgentEvent[] = [];
  const session = new ClaudeSession({
    spawnClaude: () => {
      const child = new FakeClaude(answerInit);
      children.push(child);
      return child;
    },
    emit: (e) => events.push(e),
    newEventId: ids,
    initTimeoutMs: 50,
    interruptTimeoutMs: 50,
  });
  return { session, children, events };
}

describe('ClaudeSession lifecycle (fake child)', () => {
  it('spawns once, runs turns in order, and keeps the process between turns', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'hello');
    session.userTurn('t2', 'second');
    await flush();
    const child = children[0]!;
    expect(child.written.filter((m) => m.type === 'user')).toHaveLength(1);
    for (const line of toolTurnLines) child.out(line);
    await flush();
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(child.written.filter((m) => m.type === 'user')).toHaveLength(2);
    child.out({ type: 'result', subtype: 'success' });
    await flush();
    expect(events.filter((e) => e.type === 'done').map((e) => e.turn_id)).toEqual(['t1', 't2']);
    expect(children).toHaveLength(1);
    session.close();
    expect(child.killed).toBe(true);
  });

  it('cancel sends interrupt, drops further output, and ends the turn as cancelled', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'count');
    await flush();
    const child = children[0]!;
    toolTurnLines.slice(0, 5).forEach((l) => child.out(l));
    await flush();
    session.cancel('t1');
    await flush();
    expect(child.written.at(-1)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    });
    const before = events.length;
    child.out(toolTurnLines[5]);
    child.out(interruptedResult);
    await flush();
    expect(events.slice(before)).toEqual([
      expect.objectContaining({ type: 'done', status: 'cancelled', turn_id: 't1' }),
    ]);
    expect(child.killed).toBe(false);
    session.close();
  });

  it('a turn arriving right after a cancel waits for the interrupt, then runs with its own output', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'count');
    await flush();
    const child = children[0]!;
    toolTurnLines.slice(0, 5).forEach((l) => child.out(l));
    await flush();
    // Supersede: turn.cancel then user.turn, back to back.
    session.cancel('t1');
    session.userTurn('t2', 'next');
    await flush();
    const users = () => child.written.filter((m) => m.type === 'user');
    expect(users()).toHaveLength(1);
    expect(child.written.at(-1)).toMatchObject({ request: { subtype: 'interrupt' } });
    const before = events.length;
    // t1's late output, then its interrupted result: none of it may be attributed to t2.
    child.out(toolTurnLines[5]);
    child.out(interruptedResult);
    await flush();
    expect(users()).toHaveLength(2);
    expect(users()[1]).toMatchObject({ message: { content: 'next' } });
    expect(events.slice(before)).toEqual([
      expect.objectContaining({ type: 'done', status: 'cancelled', turn_id: 't1' }),
    ]);
    for (const line of toolTurnLines) child.out(line);
    await flush();
    const t2 = events.slice(before + 1);
    expect(t2.length).toBeGreaterThan(1);
    expect(t2.every((e) => e.turn_id === 't2')).toBe(true);
    expect(t2.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
    expect(child.killed).toBe(false);
    session.close();
  });

  it('replaces the process when an interrupt is not honoured in time', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'x');
    await flush();
    session.cancel('t1');
    await new Promise((r) => setTimeout(r, 80));
    expect(children[0]!.killed).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'cancelled' });
    session.userTurn('t2', 'y');
    await flush();
    expect(children).toHaveLength(2);
    expect(children[1]!.written.some((m) => m.type === 'user')).toBe(true);
    session.close();
  });

  it('cancelling a queued turn never sends it', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'a');
    session.userTurn('t2', 'b');
    session.cancel('t2');
    await flush();
    expect(events).toEqual([expect.objectContaining({ turn_id: 't2', status: 'cancelled' })]);
    expect(children[0]!.written.filter((m) => m.type === 'user')).toHaveLength(1);
    session.close();
  });

  it('fails the active turn when the process dies', async () => {
    const { session, children, events } = setup();
    await session.start();
    session.userTurn('t1', 'a');
    await flush();
    children[0]!.emit('exit', 1);
    expect(events.map((e) => e.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({ code: 'claude_exited' });
    session.close();
  });

  it('rejects start and kills the process if it never initializes', async () => {
    const { session, children } = setup(false);
    await expect(session.start()).rejects.toThrow();
    expect(children[0]!.killed).toBe(true);
  });
});

describe('server + NativeWsAdapter (fake child)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  it('handshakes after init, streams a turn, and kills the process on disconnect', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: () => {
        const c = new FakeClaude();
        children.push(c);
        c.stdin.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('"type":"user"')) {
            for (const line of toolTurnLines) c.out(line);
          }
        });
        return c;
      },
    });
    closers.push(() => server.close());
    const adapter = new NativeWsAdapter({ url: server.url, token: 'test-token' });
    const signal = new AbortController().signal;
    await adapter.connect({ callId: 'c', sessionId: 's' }, signal);
    expect(adapter.capabilities.cancellation).toBe(true);
    const types: string[] = [];
    const now = new Date().toISOString();
    for await (const e of adapter.sendTurn(
      {
        callId: 'c',
        sessionId: 's',
        turnId: 't1',
        role: 'user',
        text: 'hi',
        startedAt: now,
        committedAt: now,
      },
      signal,
    )) {
      types.push(e.type);
    }
    expect(types).toContain('tool.start');
    expect(types.at(-1)).toBe('done');
    await adapter.close();
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true));
  });

  it('refuses a missing token and an empty configured token', async () => {
    await expect(
      startClaudeAgentServer({ token: '', spawnClaude: () => new FakeClaude() }),
    ).rejects.toThrow();
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: () => new FakeClaude(),
    });
    closers.push(() => server.close());
    const adapter = new NativeWsAdapter({ url: server.url, token: 'wrong' });
    await expect(
      adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('buildClaudeArgs', () => {
  it('restricts tools to web search/fetch and never prompts', () => {
    const args = buildClaudeArgs('sonnet');
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--bare');
  });
});

describe('server cord-rest/1 endpoint + RestSseAdapter (fake child)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  /** A child that answers every user message with a full tool turn, or stalls on "stall". */
  function spawner(children: FakeClaude[]) {
    return () => {
      const c = new FakeClaude();
      children.push(c);
      c.stdin.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        if (text.includes('"type":"user"')) {
          if (text.includes('stall')) c.out(toolTurnLines[0]);
          else for (const line of toolTurnLines) c.out(line);
        }
        if (text.includes('"subtype":"interrupt"')) c.out(interruptedResult);
      });
      return c;
    };
  }

  const turn = (turnId: string, text = 'hello') => {
    const now = new Date().toISOString();
    return {
      callId: 'c',
      sessionId: 's',
      turnId,
      role: 'user' as const,
      text,
      startedAt: now,
      committedAt: now,
    };
  };

  async function types(stream: AsyncIterable<AgentEvent>): Promise<string[]> {
    const out: string[] = [];
    for await (const e of stream) out.push(e.type);
    return out;
  }

  it('keeps one Claude process per session across turns', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: spawner(children),
    });
    closers.push(() => server.close());
    const adapter = new RestSseAdapter({ url: server.restUrl, token: 'test-token' });
    await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    const signal = new AbortController().signal;
    expect((await types(adapter.sendTurn(turn('t1'), signal))).at(-1)).toBe('done');
    expect((await types(adapter.sendTurn(turn('t2'), signal))).at(-1)).toBe('done');
    expect(children).toHaveLength(1);
    expect(children[0]!.written.filter((m) => m.type === 'user')).toHaveLength(2);
    expect(adapter.capabilities.streamingText).toBe(true);
  });

  it('refuses a wrong token and a repeated turn_id', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: spawner(children),
    });
    closers.push(() => server.close());
    const wrong = new RestSseAdapter({ url: server.restUrl, token: 'wrong' });
    await wrong.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    await expect(types(wrong.sendTurn(turn('t1'), new AbortController().signal))).rejects.toThrow(
      /rejected the credentials/,
    );
    expect(children).toHaveLength(0);
    const adapter = new RestSseAdapter({ url: server.restUrl, token: 'test-token' });
    await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    await types(adapter.sendTurn(turn('t1'), new AbortController().signal));
    await expect(types(adapter.sendTurn(turn('t1'), new AbortController().signal))).rejects.toThrow(
      /HTTP 409/,
    );
  });

  it('closing a turn request interrupts that turn and keeps the process', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: spawner(children),
    });
    closers.push(() => server.close());
    const adapter = new RestSseAdapter({ url: server.restUrl, token: 'test-token' });
    await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    const controller = new AbortController();
    for await (const e of adapter.sendTurn(turn('t1', 'stall'), controller.signal)) {
      if (e.type === 'run.started') controller.abort('superseded');
    }
    await vi.waitFor(() =>
      expect(
        children[0]!.written.some(
          (m) => (m.request as { subtype?: string } | undefined)?.subtype === 'interrupt',
        ),
      ).toBe(true),
    );
    expect((await types(adapter.sendTurn(turn('t2'), new AbortController().signal))).at(-1)).toBe(
      'done',
    );
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(false);
  });

  it('kills an idle session process and starts a fresh one later', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'test-token',
      spawnClaude: spawner(children),
      restIdleMs: 30,
    });
    closers.push(() => server.close());
    const adapter = new RestSseAdapter({ url: server.restUrl, token: 'test-token' });
    await adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal);
    await types(adapter.sendTurn(turn('t1'), new AbortController().signal));
    await vi.waitFor(() => expect(children[0]!.killed).toBe(true));
    await types(adapter.sendTurn(turn('t2'), new AbortController().signal));
    expect(children).toHaveLength(2);
  });
});
