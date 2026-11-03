import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { NativeWsAdapter } from '@twring/agent-adapter';
import type { AgentEvent } from '@twring/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeChild } from './claude-command';
import { interruptedResult, toolTurnLines } from './fixtures';
import { startClaudeAgentServer } from './server';
import { ClaudeSession } from './session';

// Verifier pass (Milestone 5): process lifecycle, cancel ordering and attribution. Never spawns
// the real `claude`: children are fakes, and the spawner test mocks node:child_process.

const spawnCalls: { bin: string; args: string[]; options: Record<string, unknown> }[] = [];
const spawnSyncCalls: { bin: string; args: string[] }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (bin: string, args: string[], options: Record<string, unknown>) => {
    spawnCalls.push({ bin, args, options });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    Object.assign(child, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 4242,
      exitCode: null,
      kill: vi.fn(),
    });
    return child;
  },
  spawnSync: (bin: string, args: string[]) => {
    spawnSyncCalls.push({ bin, args });
    return { status: 0 };
  },
}));

class FakeClaude extends EventEmitter implements ClaudeChild {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: Record<string, unknown>[] = [];
  killed = 0;
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
    this.killed += 1;
    this.emit('exit', null);
  }
}

const flush = (ms = 10) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ids = () => `evt_${n++}`;

function session(answerInit = true) {
  const children: FakeClaude[] = [];
  const events: AgentEvent[] = [];
  const s = new ClaudeSession({
    spawnClaude: () => {
      const c = new FakeClaude(answerInit);
      children.push(c);
      return c;
    },
    emit: (e) => events.push(e),
    newEventId: ids,
    initTimeoutMs: 50,
    interruptTimeoutMs: 50,
  });
  return { s, children, events };
}

describe('ClaudeSession edge cases (verifier)', () => {
  it('output of a process replaced after an ignored interrupt is never attributed to anyone', async () => {
    const { s, children, events } = session();
    await s.start();
    s.userTurn('t1', 'x');
    await flush();
    s.cancel('t1');
    s.userTurn('t2', 'y');
    await flush(80); // interrupt timeout: process replaced
    const old = children[0]!;
    expect(old.killed).toBe(1);
    const before = events.length;
    for (const line of toolTurnLines) old.out(line); // late output of the killed process
    await flush();
    const late = events.slice(before);
    expect(late.every((e) => e.turn_id === 't2')).toBe(true);
    expect(late).toEqual([]); // t2 is on the new child, which has said nothing yet
    expect(children).toHaveLength(2);
    expect(children[1]!.written.filter((m) => m.type === 'user')).toHaveLength(1);
    s.close();
  });

  it('a stray cancel for a finished turn (Twring sends one after an agent error) is ignored', async () => {
    const { s, children, events } = session();
    await s.start();
    s.userTurn('t1', 'x');
    await flush();
    const child = children[0]!;
    child.out(interruptedResult); // t1 ends with error + done: failed
    await flush();
    s.userTurn('t2', 'y');
    await flush();
    s.cancel('t1'); // late cancel for the finished turn while t2 runs
    await flush();
    expect(
      child.written.some(
        (m) =>
          m.type === 'control_request' &&
          m.request_id !== undefined &&
          (m.request as { subtype?: string }).subtype === 'interrupt',
      ),
    ).toBe(false);
    for (const line of toolTurnLines) child.out(line);
    await flush();
    expect(events.filter((e) => e.turn_id === 't2').at(-1)).toMatchObject({
      type: 'done',
      status: 'completed',
    });
    s.close();
  });

  it('the process dying during an interrupt ends the turn as cancelled and the next turn respawns', async () => {
    const { s, children, events } = session();
    await s.start();
    s.userTurn('t1', 'x');
    await flush();
    s.cancel('t1');
    s.userTurn('t2', 'y');
    children[0]!.emit('exit', 1);
    await flush();
    expect(events.filter((e) => e.turn_id === 't1').map((e) => e.type)).toEqual(['done']);
    expect(events.find((e) => e.turn_id === 't1')).toMatchObject({ status: 'cancelled' });
    expect(children).toHaveLength(2);
    expect(children[1]!.written.some((m) => m.type === 'user')).toBe(true);
    s.close();
  });

  it('close() while a respawn is starting kills the new process and sends nothing', async () => {
    const { s, children } = session(false);
    const started = s.start().catch(() => undefined);
    s.userTurn('t1', 'x');
    s.close();
    await started;
    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(1);
    expect(children[0]!.written.some((m) => m.type === 'user')).toBe(false);
  });
});

describe('server lifecycle (verifier)', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  it('a client that disconnects before Claude initializes leaves no process behind', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'tok-edge',
      initTimeoutMs: 5_000,
      spawnClaude: () => {
        const c = new FakeClaude(false);
        children.push(c);
        return c;
      },
    });
    closers.push(() => server.close());
    const adapter = new NativeWsAdapter({
      url: server.url,
      token: 'tok-edge',
      timeouts: { handshakeMs: 50 },
    });
    await expect(
      adapter.connect({ callId: 'c', sessionId: 's' }, new AbortController().signal),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(children[0]?.killed).toBe(1));
  });

  it('server.close() kills every live Claude process', async () => {
    const children: FakeClaude[] = [];
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'tok-edge',
      spawnClaude: () => {
        const c = new FakeClaude();
        children.push(c);
        return c;
      },
    });
    const adapters = [0, 1].map(() => new NativeWsAdapter({ url: server.url, token: 'tok-edge' }));
    for (const [i, a] of adapters.entries()) {
      await a.connect({ callId: `c${i}`, sessionId: `s${i}` }, new AbortController().signal);
    }
    expect(children).toHaveLength(2);
    await server.close();
    expect(children.map((c) => c.killed > 0)).toEqual([true, true]);
    for (const a of adapters) await a.close();
  });

  it('the bearer token is never echoed on a refused upgrade', async () => {
    const server = await startClaudeAgentServer({
      port: 0,
      token: 'the-real-token-1234',
      spawnClaude: () => new FakeClaude(),
    });
    closers.push(() => server.close());
    const adapter = new NativeWsAdapter({ url: server.url, token: 'guess-token-5678' });
    const error = await adapter
      .connect({ callId: 'c', sessionId: 's' }, new AbortController().signal)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(String(error)).not.toMatch(/the-real-token|guess-token/);
  });
});

describe('createClaudeSpawner (mocked child_process, verifier)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    spawnCalls.length = 0;
    spawnSyncCalls.length = 0;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('never passes the agent token in argv or env, and runs outside the repo', async () => {
    const { createClaudeSpawner } = await import('./claude-command');
    process.env.CLAUDE_AGENT_TOKEN = 'bridge-secret-token-xyz';
    const spawnClaude = createClaudeSpawner({ bin: 'claude-test-bin', model: 'sonnet' });
    const child = spawnClaude();
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(JSON.stringify(call.args)).not.toContain('bridge-secret-token-xyz');
    const env = call.options.env as Record<string, string | undefined>;
    expect(env.CLAUDE_AGENT_TOKEN).toBeUndefined();
    expect(String(call.options.cwd)).not.toContain(process.cwd());
    expect(call.options.shell).toBeUndefined();
    // Tool restriction flags are present and each variadic list is followed by another flag.
    for (const flag of ['--tools', '--allowedTools', '--mcp-config']) {
      const i = call.args.indexOf(flag);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(call.args[i + 2]?.startsWith('--')).toBe(true);
    }
    child.killTree();
    if (process.platform === 'win32') {
      expect(spawnSyncCalls).toEqual([{ bin: 'taskkill', args: ['/pid', '4242', '/T', '/F'] }]);
    }
  });
});
