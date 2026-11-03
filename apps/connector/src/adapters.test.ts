import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPROVAL_HOLD_MS } from '@twring/contracts';

import { ACP_APPROVAL_TIMEOUT_MS, AcpAdapter } from './adapters/acp';
import { ClaudeCodeAdapter, READ_ONLY_TOOLS } from './adapters/claude-code';
import { CodexAdapter } from './adapters/codex';
import { CommandAdapter } from './adapters/command';
import { LocalAgentError, type LocalAgentEvent } from './events';
import { fakeSpawner } from './fake-child';
import { agentEnv, cmdQuote } from './process';
import { ChannelSession } from './session';
import type { LocalFile } from './turn-files';

async function testFiles() {
  const dir = await mkdtemp(join(tmpdir(), 'cord-test-'));
  const make = async (name: string, mimeType: LocalFile['mimeType']): Promise<LocalFile> => {
    const path = join(dir, name);
    await writeFile(path, 'abc');
    return { path, name, mimeType, sizeBytes: 3 };
  };
  return { dir, make, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function collect(stream: AsyncIterable<LocalAgentEvent>): Promise<LocalAgentEvent[]> {
  const out: LocalAgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const text = (events: LocalAgentEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');

const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null });

describe('file delivery to local agents', () => {
  it('sends Claude images and PDFs inline with path lines for text', async () => {
    const temp = await testFiles();
    const files = [
      await temp.make('photo.png', 'image/png'),
      await temp.make('report.pdf', 'application/pdf'),
      await temp.make('note.txt', 'text/plain'),
    ];
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/work',
      tools: READ_ONLY_TOOLS,
      spawn,
    });
    try {
      const result = collect(adapter.sendTurn('look', new AbortController().signal, { files }));
      const child = await spawned[0]!;
      const init = await child.next((m) => m.type === 'control_request');
      child.out({
        type: 'control_response',
        response: { subtype: 'success', request_id: init.request_id },
      });
      const user = await child.next((m) => m.type === 'user');
      expect(user.message).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: `look\nSaved on this computer: ${files[2]!.path}` },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'YWJj' },
          },
        ],
      });
      child.out({ type: 'result', subtype: 'success', is_error: false });
      await result;
    } finally {
      adapter.close();
      await temp.cleanup();
    }
  });

  it('passes Codex images as separate arguments on new and resumed turns', async () => {
    const files: LocalFile[] = [
      { path: '/tmp/photo.png', name: 'photo.png', mimeType: 'image/png', sizeBytes: 3 },
      { path: '/tmp/note.txt', name: 'note.txt', mimeType: 'text/plain', sizeBytes: 3 },
    ];
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/work', spawn });
    const first = collect(adapter.sendTurn('look', new AbortController().signal, { files }));
    const child = await spawned[0]!;
    expect(child.request.args.at(-2)).toBe('--image=/tmp/photo.png');
    expect(child.request.args.at(-1)).toBe('-');
    expect(child.stdinText).toContain('Saved on this computer: /tmp/note.txt');
    child.out({ type: 'thread.started', thread_id: 'th_123' });
    child.out({ type: 'turn.completed' });
    child.exit(0);
    await first;
    const second = collect(adapter.sendTurn('again', new AbortController().signal, { files }));
    const resumed = await spawned[1]!;
    expect(resumed.request.args).toContain('resume');
    expect(resumed.request.args.at(-2)).toBe('--image=/tmp/photo.png');
    expect(resumed.request.args.at(-1)).toBe('-');
    resumed.out({ type: 'turn.completed' });
    resumed.exit(0);
    await second;
    adapter.close();
  });

  it.each([true, false])('uses ACP blocks when capabilities are %s', async (supported) => {
    const temp = await testFiles();
    const files = [
      await temp.make('photo.png', 'image/png'),
      await temp.make('report.pdf', 'application/pdf'),
      await temp.make('note.txt', 'text/plain'),
    ];
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({ command: 'agent', args: [], cwd: '/work', spawn });
    try {
      const result = collect(adapter.sendTurn('look', new AbortController().signal, { files }));
      const child = await spawned[0]!;
      const init = await child.next((m) => m.method === 'initialize');
      child.out({
        jsonrpc: '2.0',
        id: init.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: supported, embeddedContext: supported },
          },
        },
      });
      const session = await child.next((m) => m.method === 'session/new');
      child.out({ jsonrpc: '2.0', id: session.id, result: { sessionId: 'sess_1' } });
      const prompt = await child.next((m) => m.method === 'session/prompt');
      const blocks = (prompt.params as { prompt: Record<string, unknown>[] }).prompt;
      if (supported) {
        expect(blocks[0]).toEqual({ type: 'text', text: 'look' });
        expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'YWJj' });
        expect(blocks[2]).toMatchObject({
          type: 'resource',
          resource: { mimeType: 'application/pdf', blob: 'YWJj' },
        });
        expect(blocks[3]).toMatchObject({
          type: 'resource',
          resource: { mimeType: 'text/plain', text: 'abc' },
        });
      } else {
        expect(blocks).toEqual([
          {
            type: 'text',
            text: `look\n${files.map((file) => `Saved on this computer: ${file.path}`).join('\n')}`,
          },
        ]);
      }
      child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
      await result;
    } finally {
      adapter.close();
      await temp.cleanup();
    }
  });
});

describe('claude-code adapter', () => {
  it('reports a failed resume once after a fresh process starts', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/work',
      tools: READ_ONLY_TOOLS,
      spawn,
      resume: 'old',
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const first = await spawned[0]!;
    expect(first.request.args).toContain('--resume');
    first.exit(1);
    const fresh = await spawned[1]!;
    expect(fresh.request.args).not.toContain('--resume');
    const init = await fresh.next((m) => m.type === 'control_request');
    fresh.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await fresh.next((m) => m.type === 'user');
    fresh.out(
      stream({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'answer' },
      }),
    );
    expect(adapter.takeNewSession()).toBe(true);
    expect(adapter.takeNewSession()).toBe(false);
    fresh.out({ type: 'result', subtype: 'success', is_error: false });
    expect((await events)[0]).toEqual({ type: 'text', text: 'answer' });
    adapter.close();
  });

  it('captures a valid init session id and ignores invalid ids', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/work',
      tools: READ_ONLY_TOOLS,
      spawn,
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    expect(child.request.args).not.toContain('--no-session-persistence');
    child.out({ type: 'system', subtype: 'init', session_id: '--invalid' });
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    expect(adapter.sessionRef()).toBeUndefined();
    child.out({ type: 'system', subtype: 'init', session_id: 'sess_valid-1' });
    child.out({ type: 'result', subtype: 'success', is_error: false });
    await events;
    expect(adapter.sessionRef()).toBe('sess_valid-1');
    adapter.close();
  });

  it('uses the first valid session id when no init id arrives', async () => {
    const { adapter, spawned } = started();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    child.out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess_first' });
    await events;
    expect(adapter.sessionRef()).toBe('sess_first');
    adapter.close();
  });
  function started() {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/work',
      tools: READ_ONLY_TOOLS,
      spawn,
      interruptTimeoutMs: 200,
    });
    return { adapter, spawned };
  }

  it('starts read-only, relays text and tool events, and keeps thinking private', async () => {
    const { adapter, spawned } = started();
    const events = collect(adapter.sendTurn('weather?', new AbortController().signal));
    const child = await spawned[0]!;
    expect(child.request.args).toContain('--tools');
    expect(child.request.args[child.request.args.indexOf('--tools') + 1]).toBe(
      'Read,Grep,Glob,WebSearch,WebFetch',
    );
    expect(child.request.args).toContain('dontAsk');
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id as string },
    });
    const user = await child.next((m) => m.type === 'user');
    expect(user.message).toEqual({ role: 'user', content: 'weather?' });
    child.out(stream({ type: 'message_start', message: { id: 'm1' } }));
    child.out(
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    );
    child.out(
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Let me check.' },
      }),
    );
    child.out(
      stream({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'WebSearch' },
      }),
    );
    child.out({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] },
    });
    child.out(
      stream({ type: 'content_block_start', index: 2, content_block: { type: 'thinking' } }),
    );
    child.out(
      stream({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'thinking_delta', thinking: 'secret' },
      }),
    );
    child.out(
      stream({ type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }),
    );
    child.out(
      stream({
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'text_delta', text: ' Sunny.' },
      }),
    );
    child.out({ type: 'result', subtype: 'success', is_error: false });
    const out = await events;
    expect(text(out)).toBe('Let me check. Sunny.');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(out).toContainEqual({
      type: 'tool.start',
      id: 'tu_1',
      name: 'WebSearch',
      label: 'Searching the web',
    });
    expect(out).toContainEqual({ type: 'tool.end', id: 'tu_1', status: 'success' });
    adapter.close();
    expect(child.killed).toBe(true);
  });

  it('interrupts on cancel and ends the turn quietly', async () => {
    const { adapter, spawned } = started();
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('long task', controller.signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    controller.abort();
    const interrupt = await child.next(
      (m) =>
        m.type === 'control_request' && (m.request as { subtype?: string }).subtype === 'interrupt',
    );
    expect(interrupt).toBeDefined();
    child.out({ type: 'result', subtype: 'error_during_execution', is_error: true });
    await expect(events).resolves.toEqual([]);
    expect(child.killed).toBe(false);
    adapter.close();
  });

  it('fails the turn when Claude Code exits mid-turn', async () => {
    const { adapter, spawned } = started();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    child.exit(1);
    await expect(events).rejects.toBeInstanceOf(LocalAgentError);
  });

  it('fails the turn with line_too_long when Claude Code writes a line over 1 MB', async () => {
    const { adapter, spawned } = started();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    child.out(`{"type":"assistant","pad":"${'x'.repeat(1_100_000)}"}`);
    await expect(events).rejects.toMatchObject({ code: 'line_too_long' });
    expect(child.killed).toBe(true);
  });
});

describe('acp adapter', () => {
  it.each([
    ['no load', 'old', 'none', true],
    ['load failed', 'old', 'failure', true],
    ['loaded', 'old', 'success', false],
    ['first conversation', undefined, 'none', false],
  ] as const)('reports a boundary only for %s', async (_case, resume, load, boundary) => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'agent',
      args: [],
      cwd: '/work',
      spawn,
      ...(resume && { resume }),
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.method === 'initialize');
    child.out({
      jsonrpc: '2.0',
      id: init.id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: load !== 'none' } },
    });
    if (load !== 'none') {
      const request = await child.next((m) => m.method === 'session/load');
      child.out(
        load === 'success'
          ? { jsonrpc: '2.0', id: request.id, result: {} }
          : { jsonrpc: '2.0', id: request.id, error: { code: -1, message: 'unknown session' } },
      );
    }
    if (load !== 'success') {
      const fresh = await child.next((m) => m.method === 'session/new');
      child.out({ jsonrpc: '2.0', id: fresh.id, result: { sessionId: 'fresh' } });
    }
    const prompt = await child.next((m) => m.method === 'session/prompt');
    expect(adapter.takeNewSession()).toBe(boundary);
    expect(adapter.takeNewSession()).toBe(false);
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await events;
    adapter.close();
  });

  function ready(allowKinds: string[] = []) {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'gemini',
      args: ['--acp'],
      cwd: '/work',
      spawn,
      allowKinds,
      cancelTimeoutMs: 200,
    });
    return { adapter, spawned };
  }

  async function handshake(child: Awaited<ReturnType<typeof fakeSpawner>['spawned'][number]>) {
    const init = await child.next((m) => m.method === 'initialize');
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    child.out('Loaded cached credentials.'); // Plain-text noise on stdout is skipped.
    child.out({
      jsonrpc: '2.0',
      id: init.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    const session = await child.next((m) => m.method === 'session/new');
    expect(session.params).toEqual({ cwd: '/work', mcpServers: [] });
    child.out({ jsonrpc: '2.0', id: session.id, result: { sessionId: 'sess_1' } });
    return child.next((m) => m.method === 'session/prompt');
  }

  it('turns five ACP image chunks into local files and ignores the sixth', async () => {
    const { adapter, spawned } = ready();
    const events = collect(
      adapter.sendTurn('draw', new AbortController().signal, { surface: 'text' }),
    );
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    for (let n = 0; n < 6; n++)
      child.out({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'image', mimeType: 'image/png', data: 'YWJj' },
          },
        },
      });
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const files = (await events).filter((event) => event.type === 'file');
    expect(files).toHaveLength(5);
    expect(files[0]).toEqual({
      type: 'file',
      name: 'image-1.png',
      mimeType: 'image/png',
      data: Buffer.from('abc'),
    });
    expect(files[4]).toMatchObject({ name: 'image-5.png' });
    adapter.close();
  });

  it('uploads an ACP image and sends its file id on a typed reply', async () => {
    const { adapter, spawned } = ready();
    const sent: Record<string, unknown>[] = [];
    const uploadFile = vi.fn(() => Promise.resolve(`fil_${'a'.repeat(20)}`));
    const channel = new ChannelSession({
      adapter,
      uploadFile,
      send: (message) => sent.push(message),
    });
    channel.handle({
      type: 'user.turn',
      session_id: 's',
      turn_id: 't',
      text: 'draw',
      surface: 'text',
      started_at: 'x',
      committed_at: 'x',
    });
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    child.out({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', mimeType: 'image/jpeg', data: 'YWJj' },
        },
      },
    });
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await vi.waitFor(() => expect(sent.some((message) => message.type === 'done')).toBe(true));
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'image-1.jpg',
        mimeType: 'image/jpeg',
        bytes: Buffer.from('abc'),
      }),
    );
    expect(sent.find((message) => message.type === 'file')).toMatchObject({
      file_id: `fil_${'a'.repeat(20)}`,
      name: 'image-1.jpg',
    });
    adapter.close();
  });

  it('relays message chunks and tool calls, and denies when the owner says no', async () => {
    const { adapter, spawned } = ready();
    const events = (async () => {
      const out: LocalAgentEvent[] = [];
      for await (const event of adapter.sendTurn('list files', new AbortController().signal)) {
        out.push(event);
        if (event.type === 'approval.required') adapter.decide(event.id, 'deny');
      }
      return out;
    })();
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    expect(prompt.params).toEqual({
      sessionId: 'sess_1',
      prompt: [{ type: 'text', text: 'list files' }],
    });
    const update = (u: unknown) =>
      child.out({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess_1', update: u },
      });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Sure, ' } });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'c1',
      title: 'rm -rf /tmp/x',
      kind: 'execute',
      status: 'pending',
    });
    child.out({
      jsonrpc: '2.0',
      id: 99,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_1',
        toolCall: { toolCallId: 'c1', kind: 'execute' },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    const answer = await child.next((m) => m.id === 99 && 'result' in m);
    expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } });
    child.out({ jsonrpc: '2.0', id: 50, method: 'fs/read_text_file', params: {} });
    const refused = await child.next((m) => m.id === 50);
    expect(refused.error).toMatchObject({ code: -32601 });
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    const out = await events;
    expect(text(out)).toBe('Sure, done.');
    expect(JSON.stringify(out)).not.toContain('rm -rf');
    expect(out).toContainEqual({
      type: 'tool.start',
      id: 'c1',
      name: 'execute',
      label: 'Running a command',
    });
    expect(out).toContainEqual({ type: 'tool.end', id: 'c1', status: 'error' });
    adapter.close();
  });

  it('allows an allowlisted tool kind once', async () => {
    const { adapter, spawned } = ready(['read']);
    const events = collect(adapter.sendTurn('read it', new AbortController().signal));
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    child.out({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_1',
        toolCall: { toolCallId: 'c2', kind: 'read' },
        options: [
          { optionId: 'always', kind: 'allow_always' },
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      },
    });
    expect((await child.next((m) => m.id === 7)).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    await events;
    adapter.close();
  });

  it.each(['approve', 'deny'] as const)(
    'holds an unsafe permission until %s, then answers once',
    async (decision) => {
      const { adapter, spawned } = ready();
      const iterator = adapter.sendTurn('go', new AbortController().signal)[Symbol.asyncIterator]();
      const pendingEvent = iterator.next();
      const child = await spawned[0]!;
      const prompt = await handshake(child);
      child.out({
        jsonrpc: '2.0',
        id: 91,
        method: 'session/request_permission',
        params: {
          toolCall: { kind: 'execute', title: '\u202e\u0000  Run  \u200b  command  ' },
          options: [
            { optionId: 'yes', kind: 'allow_once' },
            { optionId: 'no', kind: 'reject_once' },
          ],
        },
      });
      const event = (await pendingEvent).value as LocalAgentEvent | undefined;
      expect(event).toMatchObject({
        type: 'approval.required',
        action: 'run_command',
        title: 'Run command',
      });
      if (event?.type !== 'approval.required') throw new Error('missing approval');
      expect(
        child.written.some(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            'id' in message &&
            message.id === 91 &&
            'result' in message,
        ),
      ).toBe(false);
      adapter.decide(event.id, decision);
      expect((await child.next((m) => m.id === 91)).result).toEqual({
        outcome: { outcome: 'selected', optionId: decision === 'approve' ? 'yes' : 'no' },
      });
      child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
      expect((await iterator.next()).done).toBe(true);
      adapter.close();
    },
  );

  it('rejects a second pending request and rejects the first on cancel', async () => {
    const { adapter, spawned } = ready();
    const abort = new AbortController();
    const iterator = adapter.sendTurn('go', abort.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    const params = {
      toolCall: { kind: 'delete', title: 'x'.repeat(100) },
      options: [{ optionId: 'no', kind: 'reject_once' }],
    };
    child.out({ jsonrpc: '2.0', id: 91, method: 'session/request_permission', params });
    expect((await first).value).toMatchObject({
      type: 'approval.required',
      action: 'delete_files',
      title: `${'x'.repeat(79)}…`,
    });
    child.out({ jsonrpc: '2.0', id: 92, method: 'session/request_permission', params });
    expect((await child.next((m) => m.id === 92)).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
    abort.abort();
    expect((await child.next((m) => m.id === 91)).result).toEqual({
      outcome: { outcome: 'selected', optionId: 'no' },
    });
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
    expect((await iterator.next()).done).toBe(true);
    adapter.close();
  });

  it.each([
    ['call', ACP_APPROVAL_TIMEOUT_MS],
    ['text', APPROVAL_HOLD_MS + 5_000],
  ] as const)('denies an unanswered %s request after its hold', async (surface, holdMs) => {
    const { adapter, spawned } = ready();
    const stream = adapter.sendTurn('go', new AbortController().signal, { surface });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    vi.useFakeTimers();
    try {
      child.out({
        jsonrpc: '2.0',
        id: 91,
        method: 'session/request_permission',
        params: { toolCall: { kind: 'fetch' }, options: [{ optionId: 'no', kind: 'reject_once' }] },
      });
      expect((await first).value).toMatchObject({ type: 'approval.required', action: 'fetch_web' });
      await vi.advanceTimersByTimeAsync(holdMs - 1);
      expect(
        child.written.some(
          (m) => typeof m === 'object' && m !== null && 'id' in m && m.id === 91 && 'result' in m,
        ),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await child.next((m) => m.id === 91)).result).toEqual({
        outcome: { outcome: 'selected', optionId: 'no' },
      });
    } finally {
      vi.useRealTimers();
    }
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'end_turn' } });
    expect((await iterator.next()).done).toBe(true);
    adapter.close();
  });

  it('sends session/cancel on barge-in and ends when the agent confirms', async () => {
    const { adapter, spawned } = ready();
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('go', controller.signal));
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    controller.abort();
    const cancel = await child.next((m) => m.method === 'session/cancel');
    expect(cancel.params).toEqual({ sessionId: 'sess_1' });
    expect('id' in cancel).toBe(false);
    child.out({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } });
    await expect(events).resolves.toEqual([]);
    adapter.close();
  });

  it('fails the turn on a JSON-RPC error', async () => {
    const { adapter, spawned } = ready();
    const events = collect(adapter.sendTurn('go', new AbortController().signal));
    const child = await spawned[0]!;
    const prompt = await handshake(child);
    child.out({ jsonrpc: '2.0', id: prompt.id, error: { code: -32000, message: 'auth required' } });
    await expect(events).rejects.toBeInstanceOf(LocalAgentError);
    adapter.close();
  });
});

describe('codex adapter', () => {
  it('runs codex exec --json read-only, speaks the agent message, and resumes the thread', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/work', spawn });
    const first = collect(adapter.sendTurn('what changed?', new AbortController().signal));
    const child = await spawned[0]!;
    expect(child.request.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-',
    ]);
    child.out({ type: 'thread.started', thread_id: 'th_123' });
    child.out({ type: 'turn.started' });
    child.out({
      type: 'item.started',
      item: { id: 'i1', type: 'command_execution', status: 'in_progress' },
    });
    child.out({
      type: 'item.completed',
      item: { id: 'i1', type: 'command_execution', status: 'completed' },
    });
    child.out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'private' } });
    child.out({
      type: 'item.completed',
      item: { id: 'i2', type: 'agent_message', text: 'Two files changed.' },
    });
    child.out({ type: 'turn.completed', usage: {} });
    child.exit(0);
    const out = await first;
    expect(child.stdinText).toBe('what changed?');
    expect(text(out)).toBe('Two files changed.');
    expect(JSON.stringify(out)).not.toContain('private');
    expect(out).toContainEqual({ type: 'tool.end', id: 'i1', status: 'success' });

    const second = collect(adapter.sendTurn('and why?', new AbortController().signal));
    const next = await spawned[1]!;
    expect(next.request.args.slice(0, 3)).toEqual(['exec', 'resume', 'th_123']);
    // Resumed runs keep the sandbox through the config override; `resume` rejects --sandbox.
    expect(next.request.args).not.toContain('--sandbox');
    expect(next.request.args).toEqual(expect.arrayContaining(['-c', 'sandbox_mode=read-only']));
    // On Windows `codex` is a .cmd shim: every argument must survive cmd.exe quoting.
    for (const arg of next.request.args) expect(() => cmdQuote(arg)).not.toThrow();
    next.out({ type: 'turn.failed', error: { message: 'x' } });
    next.exit(1);
    await expect(second).rejects.toBeInstanceOf(LocalAgentError);
  });

  it('kills the process on cancel', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/work', spawn });
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('go', controller.signal));
    const child = await spawned[0]!;
    controller.abort();
    await expect(events).resolves.toEqual([]);
    expect(child.killed).toBe(true);
  });
});

describe('command adapter', () => {
  it('sends text on stdin and streams stdout as speech', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CommandAdapter({
      command: 'my-agent',
      args: ['--quiet'],
      cwd: '/w',
      spawn,
    });
    const events = collect(adapter.sendTurn('hello; rm -rf /', new AbortController().signal));
    const child = await spawned[0]!;
    expect(child.request.args).toEqual(['--quiet']);
    child.stdout.write('Hi ');
    child.stdout.write(Buffer.from('th€re', 'utf8').subarray(0, 4));
    child.stdout.write(Buffer.from('th€re', 'utf8').subarray(4));
    child.exit(0);
    expect(text(await events)).toBe('Hi th€re');
    expect(child.stdinText).toBe('hello; rm -rf /');
  });

  it('fails on a non-zero exit', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CommandAdapter({ command: 'x', args: [], cwd: '/w', spawn });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    (await spawned[0]!).exit(2);
    await expect(events).rejects.toBeInstanceOf(LocalAgentError);
  });
});

describe('adapters: crashes, hangs, and races', () => {
  it('claude-code: a process that never finishes starting fails the turn and is killed', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/w',
      tools: READ_ONLY_TOOLS,
      spawn,
      initTimeoutMs: 30,
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.out('not json at all'); // Noise is ignored; the timeout still applies.
    const error = await events.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(LocalAgentError);
    expect((error as LocalAgentError).code).toBe('agent_unavailable');
    expect(child.killed).toBe(true);
    adapter.close();
  });

  it('claude-code: a crash before start fails the turn, and the next turn starts a new process', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/w',
      tools: READ_ONLY_TOOLS,
      spawn,
    });
    const first = collect(adapter.sendTurn('hi', new AbortController().signal));
    (await spawned[0]!).exit(1);
    await expect(first).rejects.toMatchObject({ code: 'agent_unavailable' });

    const second = collect(adapter.sendTurn('again', new AbortController().signal));
    const child = await spawned[1]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    child.out({ type: 'result', subtype: 'success' });
    await expect(second).resolves.toEqual([]);
    adapter.close();
  });

  it('claude-code: an agent that ignores the interrupt is replaced, and the turn still ends', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/w',
      tools: READ_ONLY_TOOLS,
      spawn,
      interruptTimeoutMs: 30,
    });
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('long task', controller.signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    controller.abort();
    await expect(events).resolves.toEqual([]);
    expect(child.killed).toBe(true);
    // Its late output does not leak into the next turn.
    const next = collect(adapter.sendTurn('next', new AbortController().signal));
    child.out(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }));
    const fresh = await spawned[1]!;
    const init2 = await fresh.next((m) => m.type === 'control_request');
    fresh.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init2.request_id },
    });
    await fresh.next((m) => m.type === 'user');
    fresh.out({ type: 'result', subtype: 'success' });
    await expect(next).resolves.toEqual([]);
    adapter.close();
  });

  it('claude-code: close() mid-turn ends the turn and kills the process', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new ClaudeCodeAdapter({
      command: 'claude',
      cwd: '/w',
      tools: READ_ONLY_TOOLS,
      spawn,
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.type === 'control_request');
    child.out({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id },
    });
    await child.next((m) => m.type === 'user');
    adapter.close();
    await expect(events).resolves.toEqual([]);
    expect(child.killed).toBe(true);
    await expect(collect(adapter.sendTurn('x', new AbortController().signal))).rejects.toThrow();
  });

  it('acp: an agent that never answers initialize fails the turn and is killed', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({
      command: 'gemini',
      args: ['--acp'],
      cwd: '/w',
      spawn,
      startTimeoutMs: 30,
    });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.out('{"half": ');
    child.out('[1, 2, 3]');
    await expect(events).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(child.killed).toBe(true);
    adapter.close();
  });

  it('acp: a crash mid-turn fails the turn instead of hanging', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new AcpAdapter({ command: 'gemini', args: ['--acp'], cwd: '/w', spawn });
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    const init = await child.next((m) => m.method === 'initialize');
    child.out({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: 1 } });
    const session = await child.next((m) => m.method === 'session/new');
    child.out({ jsonrpc: '2.0', id: session.id, result: { sessionId: 's1' } });
    await child.next((m) => m.method === 'session/prompt');
    child.out({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hm' } },
      },
    });
    child.exit(null);
    await expect(events).rejects.toBeInstanceOf(LocalAgentError);
    adapter.close();
  });

  it('codex: a thread id that is not a plain id is never put back on a command line', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CodexAdapter({ command: 'codex', cwd: '/w', spawn });
    const first = collect(adapter.sendTurn('one', new AbortController().signal));
    const child = await spawned[0]!;
    child.out({ type: 'thread.started', thread_id: 'abc & calc.exe' });
    child.out({ type: 'turn.completed' });
    child.exit(0);
    await first;
    const second = collect(adapter.sendTurn('two', new AbortController().signal));
    const next = await spawned[1]!;
    expect(next.request.args).not.toContain('resume');
    expect(next.request.args.join(' ')).not.toContain('calc');
    next.out({ type: 'turn.completed' });
    next.exit(0);
    await second;
  });

  it('command: a cancel that races the process finishing ends the turn once, quietly', async () => {
    const { spawn, spawned } = fakeSpawner();
    const adapter = new CommandAdapter({ command: 'x', args: [], cwd: '/w', spawn });
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('hi', controller.signal));
    const child = await spawned[0]!;
    child.stdout.write('partial ');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.exit(3);
    controller.abort();
    const result = await events.then(
      (out) => ({ out }),
      (error: unknown) => ({ error }),
    );
    // Whichever wins, the turn ends (never hangs) and nothing after the cancel is spoken.
    expect('out' in result ? text(result.out) : 'failed').toMatch(/^(partial |failed)$/);
    // The next turn is not blocked by the previous one.
    const next = collect(adapter.sendTurn('again', new AbortController().signal));
    const second = await spawned[1]!;
    second.stdout.write('ok');
    second.exit(0);
    expect(text(await next)).toBe('ok');
  });
});

describe('agent environment', () => {
  it('drops CLAUDE_CODE_* and the connector settings', () => {
    const env = agentEnv({
      PATH: '/bin',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
      CORD_CONNECT_CONFIG_DIR: '/x',
      ANTHROPIC_API_KEY: 'kept-for-the-agent',
    });
    expect(env).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'kept-for-the-agent' });
  });
});
