import { STAY_ON_CALL_RULE, TEXT_TURN_TAG } from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { AcpAdapter } from './adapters/acp';
import { buildClaudeArgs, READ_ONLY_TOOLS, TWRING_SYSTEM_PROMPT } from './adapters/claude-code';
import { scopedSpawn } from './agents';
import type { SpawnFn, SpawnRequest } from './process';
import { CodexAdapter } from './adapters/codex';
import type { LocalAgentEvent } from './events';
import { fakeSpawner, type FakeChild } from './fake-child';
import {
  callPreamble,
  posixQuote,
  powershellQuote,
  ringCommand,
  withPreamble,
  type Launch,
} from './preamble';

async function collect(stream: AsyncIterable<LocalAgentEvent>): Promise<LocalAgentEvent[]> {
  const out: LocalAgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const posix = (over: Partial<Launch> = {}): Launch => ({
  execPath: '/usr/bin/node',
  script: '/home/me/cord-connect.mjs',
  execArgv: [],
  platform: 'linux',
  ...over,
});

describe('ring command', () => {
  it('is this node and script plus `ring`', () => {
    expect(ringCommand(posix())).toBe('/usr/bin/node /home/me/cord-connect.mjs ring');
  });

  it('quotes paths with spaces and quotes for a POSIX shell', () => {
    expect(
      ringCommand(
        posix({ execPath: '/opt/my node/bin/node', script: "/home/o'brien/cord connect.mjs" }),
      ),
    ).toBe(`'/opt/my node/bin/node' '/home/o'\\''brien/cord connect.mjs' ring`);
    expect(posixQuote('$(rm -rf ~)')).toBe(`'$(rm -rf ~)'`);
  });

  it('quotes paths for PowerShell on Windows, with & before a quoted program', () => {
    expect(
      ringCommand({
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        script: "C:\\Users\\Jo O'Neil\\cord-connect.mjs",
        execArgv: [],
        platform: 'win32',
      }),
    ).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\Jo O''Neil\\cord-connect.mjs' ring`,
    );
    expect(
      ringCommand({
        execPath: 'C:\\node\\node.exe',
        script: 'C:\\cord\\cli.mjs',
        execArgv: [],
        platform: 'win32',
      }),
    ).toBe('C:\\node\\node.exe C:\\cord\\cli.mjs ring');
    expect(powershellQuote('$env:HOME; `whoami`')).toBe(`'$env:HOME; \`whoami\`'`);
  });

  it('keeps the tsx loader when run from TypeScript, and only then', () => {
    const tsx = posix({
      script: '/src/cord/apps/connector/src/cli.ts',
      execArgv: [
        '--require',
        '/n m/tsx/preflight.cjs',
        '--import',
        'file:///nm/tsx/loader.mjs',
        '--inspect',
      ],
    });
    expect(ringCommand(tsx)).toBe(
      "/usr/bin/node --require '/n m/tsx/preflight.cjs' --import file:///nm/tsx/loader.mjs /src/cord/apps/connector/src/cli.ts ring",
    );
    expect(ringCommand(posix({ execArgv: ['--import', 'x.mjs'] }))).toBe(
      '/usr/bin/node /home/me/cord-connect.mjs ring',
    );
  });

  it('falls back to npx when the script is unknown', () => {
    expect(ringCommand(posix({ script: undefined }))).toBe('npx twring-connect ring');
  });
});

describe('call preamble', () => {
  it('is short, bracketed, and names the hang-up marker and the ring command', () => {
    const preamble = callPreamble('/usr/bin/node /home/me/cord-connect.mjs ring');
    expect(preamble).toBe(
      `[You are connected to your owner through Twring, by live voice calls and by typed messages. On a call everything you write is spoken aloud: answer in short, plain spoken sentences, no markdown. ${STAY_ON_CALL_RULE} A turn that starts with ${TEXT_TURN_TAG} was typed in the Twring chat: answer in normal written text; markdown, lists and code are fine there, and the call rules do not apply. To ring your owner later (for example when a long task finishes), run: /usr/bin/node /home/me/cord-connect.mjs ring "<short reason>". If the call ends while you are still working on something the owner asked for, keep going and finish it; your final reply is saved in your Twring chat with them, and they may get a call or a notification.]`,
    );
    expect(preamble.length).toBeLessThan(900);
    expect(withPreamble('[p]', 'hi')).toBe('[p]\n\nhi');
  });

  it('Claude Code’s voice system prompt carries the ring line too', () => {
    expect(TWRING_SYSTEM_PROMPT).toContain(`run: ${ringCommand()} "<short reason>"`);
    expect(TWRING_SYSTEM_PROMPT).toContain(STAY_ON_CALL_RULE);
    expect(TWRING_SYSTEM_PROMPT).not.toMatch(/call is (clearly )?over/);
  });
});

describe('call preamble in the adapters', () => {
  const PRE = '[call preamble]';

  async function acpTurn(
    child: FakeChild,
    capabilities: Record<string, unknown> = {},
    first = true,
  ): Promise<string> {
    if (first) {
      const init = await child.next((m) => m.method === 'initialize');
      child.out({
        jsonrpc: '2.0',
        id: init.id,
        result: { protocolVersion: 1, agentCapabilities: capabilities },
      });
      const open = await child.next(
        (m) => m.method === 'session/new' || m.method === 'session/load',
      );
      child.out({
        jsonrpc: '2.0',
        id: open.id,
        result: open.method === 'session/new' ? { sessionId: 'sess_1' } : null,
      });
    }
    // The first turn's prompt is the first one written; a later turn's is the second.
    const wanted = first ? 1 : 2;
    const prompts = () => child.written.filter((m) => isPrompt(m));
    await child.next((m) => m.method === 'session/prompt' && prompts().length >= wanted);
    const last = prompts()[wanted - 1] as { id: number; params: { prompt: { text: string }[] } };
    child.out({ jsonrpc: '2.0', id: last.id, result: { stopReason: 'end_turn' } });
    return last.params.prompt[0]!.text;
  }

  function isPrompt(m: unknown): boolean {
    return (
      typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'session/prompt'
    );
  }

  it('acp: only the first turn of a new session gets it', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'hermes',
      args: ['acp'],
      cwd: '/w',
      spawn,
      preamble: PRE,
    });
    const first = collect(adapter.sendTurn('hello', new AbortController().signal));
    const child = await spawned[0]!;
    expect(await acpTurn(child)).toBe(`${PRE}\n\nhello`);
    await first;
    const second = collect(adapter.sendTurn('again', new AbortController().signal));
    expect(await acpTurn(child, {}, false)).toBe('again');
    await second;
  });

  it('acp: a resumed ring session gets it on its first turn', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'hermes',
      args: ['acp'],
      cwd: '/w',
      spawn,
      preamble: PRE,
      resume: 'sess_ring',
    });
    const first = collect(adapter.sendTurn('you rang?', new AbortController().signal));
    const child = await spawned[0]!;
    expect(await acpTurn(child, { loadSession: true })).toBe(`${PRE}\n\nyou rang?`);
    await first;
    const second = collect(adapter.sendTurn('thanks', new AbortController().signal));
    expect(await acpTurn(child, {}, false)).toBe('thanks');
    await second;
  });

  function codexTurn(child: FakeChild, thread = 'th_1'): void {
    child.out({ type: 'thread.started', thread_id: thread });
    child.out({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });
    child.out({ type: 'turn.completed', usage: {} });
    child.exit(0);
  }

  it('codex: only the first turn of the call gets it', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn, preamble: PRE });
    const first = collect(adapter.sendTurn('what changed?', new AbortController().signal));
    const child = await spawned[0]!;
    codexTurn(child);
    await first;
    expect(child.stdinText).toBe(`${PRE}\n\nwhat changed?`);
    const second = collect(adapter.sendTurn('and why?', new AbortController().signal));
    const next = await spawned[1]!;
    codexTurn(next);
    await second;
    expect(next.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_1']);
    expect(next.stdinText).toBe('and why?');
  });

  it('codex: a resumed ring thread gets it, and keeps it when the resume falls back', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({
      command: 'codex',
      cwd: '/w',
      spawn,
      preamble: PRE,
      resume: 'th_ring',
    });
    const first = collect(adapter.sendTurn('you rang?', new AbortController().signal));
    const resumed = await spawned[0]!;
    expect(resumed.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_ring']);
    expect(resumed.stdinText).toBe(`${PRE}\n\nyou rang?`);
    resumed.exit(1); // the thread is gone: a new one runs the same text
    const fresh = await spawned[1]!;
    codexTurn(fresh, 'th_new');
    await first;
    expect(fresh.stdinText).toBe(`${PRE}\n\nyou rang?`);
    const second = collect(adapter.sendTurn('thanks', new AbortController().signal));
    const next = await spawned[2]!;
    codexTurn(next, 'th_new');
    await second;
    expect(next.stdinText).toBe('thanks');
  });
});

describe('call preamble, verifier pass', () => {
  const PRE = '[call preamble]';

  function codexDone(child: FakeChild, thread: string): void {
    child.out({ type: 'thread.started', thread_id: thread });
    child.out({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } });
    child.out({ type: 'turn.completed', usage: {} });
    child.exit(0);
  }

  it('BUG: codex: a first turn cancelled before Codex opened a thread does not use up the preamble', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn, preamble: PRE });
    const abort = new AbortController();
    const first = collect(adapter.sendTurn('hello', abort.signal));
    const killed = await spawned[0]!;
    expect(killed.stdinText).toBe(`${PRE}\n\nhello`);
    abort.abort(); // the owner kept talking: superseded before `thread.started`
    await first;
    const second = collect(adapter.sendTurn('hello, what changed?', new AbortController().signal));
    const next = await spawned[1]!;
    codexDone(next, 'th_1');
    await second;
    // Still a brand-new thread, which has never seen the preamble.
    expect(next.request.args).not.toContain('resume');
    expect(next.stdinText).toBe(`${PRE}\n\nhello, what changed?`);
    const third = collect(adapter.sendTurn('thanks', new AbortController().signal));
    const last = await spawned[2]!;
    codexDone(last, 'th_1');
    await third;
    expect(last.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_1']);
    expect(last.stdinText).toBe('thanks');
  });

  it('BUG: codex: a first turn that failed before a thread opened does not use up the preamble', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn, preamble: PRE });
    const first = collect(adapter.sendTurn('hello', new AbortController().signal));
    (await spawned[0]!).exit(1); // e.g. not signed in yet
    await expect(first).rejects.toThrow();
    const second = collect(adapter.sendTurn('try again', new AbortController().signal));
    const next = await spawned[1]!;
    codexDone(next, 'th_1');
    await second;
    expect(next.stdinText).toBe(`${PRE}\n\ntry again`);
  });

  it('codex: a turn cancelled after the thread opened is not given the preamble again', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn, preamble: PRE });
    const abort = new AbortController();
    const first = collect(adapter.sendTurn('hello', abort.signal));
    const child = await spawned[0]!;
    child.out({ type: 'thread.started', thread_id: 'th_1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await first;
    const second = collect(adapter.sendTurn('go on', new AbortController().signal));
    const next = await spawned[1]!;
    codexDone(next, 'th_1');
    await second;
    expect(next.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_1']);
    expect(next.stdinText).toBe('go on');
  });

  it('acp: a restarted agent’s new session gets it once more, never twice in one session', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'hermes',
      args: ['acp'],
      cwd: '/w',
      spawn,
      preamble: PRE,
    });
    const prompts: string[] = [];
    async function open(child: FakeChild, sessionId: string): Promise<void> {
      const init = await child.next((m) => m.method === 'initialize');
      child.out({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } });
      const created = await child.next((m) => m.method === 'session/new');
      child.out({ jsonrpc: '2.0', id: created.id, result: { sessionId } });
    }
    async function answer(child: FakeChild, n: number): Promise<void> {
      const isPrompt = (m: unknown) =>
        typeof m === 'object' &&
        m !== null &&
        (m as { method?: unknown }).method === 'session/prompt';
      await child.next(
        (m) => m.method === 'session/prompt' && child.written.filter(isPrompt).length >= n,
      );
      const prompt = child.written.filter(isPrompt)[n - 1] as {
        id: number;
        params: { prompt: { text: string }[] };
      };
      prompts.push(prompt.params.prompt[0]!.text);
      child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    }
    const t1 = collect(adapter.sendTurn('one', new AbortController().signal));
    const a = await spawned[0]!;
    await open(a, 'sess_a');
    await answer(a, 1);
    await t1;
    const t2 = collect(adapter.sendTurn('two', new AbortController().signal));
    await answer(a, 2);
    await t2;
    a.exit(1); // the agent crashed between turns
    await new Promise((resolve) => setTimeout(resolve, 10));
    const t3 = collect(adapter.sendTurn('three', new AbortController().signal));
    const b = await spawned[1]!;
    await open(b, 'sess_b');
    await answer(b, 1);
    await t3;
    const t4 = collect(adapter.sendTurn('four', new AbortController().signal));
    await answer(b, 2);
    await t4;
    expect(prompts).toEqual([`${PRE}\n\none`, 'two', `${PRE}\n\nthree`, 'four']);
  });

  it('acp: a turn cancelled while the session opens does not use up the preamble', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'hermes',
      args: ['acp'],
      cwd: '/w',
      spawn,
      preamble: PRE,
    });
    const abort = new AbortController();
    const first = collect(adapter.sendTurn('one', abort.signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.method === 'initialize');
    abort.abort();
    child.out({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } });
    const created = await child.next((m) => m.method === 'session/new');
    child.out({ jsonrpc: '2.0', id: created.id, result: { sessionId: 'sess_a' } });
    await first;
    const second = collect(adapter.sendTurn('two', new AbortController().signal));
    const prompt = (await child.next((m) => m.method === 'session/prompt')) as {
      id: number;
      params: { prompt: { text: string }[] };
    };
    expect(prompt.params.prompt[0]!.text).toBe(`${PRE}\n\ntwo`);
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await second;
  });

  it('BUG: PowerShell quoting keeps a curly apostrophe in a path as it is', () => {
    // In a single-quoted PowerShell string, any of ' ‘ ’ ‚ ‛ is a quote, and a doubled quote reads
    // as its second character: 'O''Neil' is O'Neil, 'O'‘Neil' is O‘Neil (checked on PowerShell 5.1).
    expect(powershellQuote('C:\\Users\\O‘Neil\\c.mjs')).toBe(`'C:\\Users\\O'‘Neil\\c.mjs'`);
    expect(powershellQuote('C:\\Users\\O’Neil\\c.mjs')).toBe(`'C:\\Users\\O'’Neil\\c.mjs'`);
    expect(powershellQuote("C:\\Users\\O'Neil\\c.mjs")).toBe(`'C:\\Users\\O''Neil\\c.mjs'`);
  });

  it('quotes shell metacharacters in the install path for POSIX shells and PowerShell', () => {
    const nasty = '/home/me/x`id`;$(reboot) "q" \\ & | > *\nrm -rf ~/cord.mjs';
    const posixCommand = ringCommand(posix({ script: nasty }));
    expect(posixCommand).toBe(`/usr/bin/node '${nasty}' ring`);
    const ps = ringCommand({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      script: 'C:\\x`$env:PATH;$(calc)"\n@(1).mjs',
      execArgv: [],
      platform: 'win32',
    });
    expect(ps).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\x\`$env:PATH;$(calc)"\n@(1).mjs' ring`,
    );
    expect(posixQuote("it's")).toBe(`'it'\\''s'`);
    expect(posixQuote('')).toBe(`''`);
    expect(powershellQuote('')).toBe(`''`);
  });

  it('falls back to npx when argv[1] is empty, and the preamble still names it', () => {
    expect(ringCommand(posix({ script: '' }))).toBe('npx twring-connect ring');
    expect(callPreamble(ringCommand(posix({ script: undefined })))).toContain(
      'run: npx twring-connect ring "<short reason>"',
    );
  });
});

describe('a scoped session (someone else on a shared server agent)', () => {
  const scope = '0123456789abcdef'.repeat(2);
  it('tells the agent it talks with a team member, whose own requests file to use', () => {
    const scoped = callPreamble('twring-connect ring', scope);
    expect(scoped).toContain("a member of your owner's team, not your owner");
    expect(scoped).toContain('reach this person, not your owner');
    expect(scoped).toContain('twring-requests-01234567.md');
    expect(scoped).not.toContain('You are connected to your owner');
    expect(callPreamble('twring-connect ring')).toContain('You are connected to your owner');
  });
  it("Claude Code's system prompt says the same for a scoped session only", () => {
    const scoped = buildClaudeArgs(READ_ONLY_TOOLS, undefined, undefined, scope).at(-1)!;
    expect(scoped).toContain("a member of your owner's team, not your owner");
    expect(scoped).toContain('twring-requests-01234567.md');
    expect(buildClaudeArgs(READ_ONLY_TOOLS).at(-1)).toBe(TWRING_SYSTEM_PROMPT);
  });
  it("puts the scope in the agent process's environment", () => {
    const requests: SpawnRequest[] = [];
    const spawn: SpawnFn = (request) => {
      requests.push(request);
      return fakeSpawner().spawn(request);
    };
    scopedSpawn(spawn, scope)({ command: 'claude', args: [], cwd: '.', env: { A: '1' } });
    scopedSpawn(spawn, undefined)({ command: 'claude', args: [], cwd: '.' });
    expect(requests[0]?.env).toEqual({ A: '1', TWRING_SESSION_SCOPE: scope });
    expect(requests[1]?.env).toBeUndefined();
  });
});
