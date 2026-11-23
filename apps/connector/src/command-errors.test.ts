import { describe, expect, it } from 'vitest';

import { CommandAdapter, STDERR_TAIL_BYTES } from './adapters/command';
import { createAdapter, type LocalAgentConfig } from './agents';
import { doctor } from './doctor';
import { LocalAgentError, type LocalAgentEvent } from './events';
import { fakeSpawner } from './fake-child';

async function collect(events: AsyncIterable<LocalAgentEvent>): Promise<LocalAgentEvent[]> {
  const out: LocalAgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function setup() {
  const { spawn, spawned } = fakeSpawner();
  const lines: string[] = [];
  const adapter = new CommandAdapter({
    command: 'lucy',
    args: [],
    cwd: '/w',
    spawn,
    label: 'Lucy',
    log: (line) => lines.push(line),
  });
  return { adapter, spawned, lines };
}

describe('command agent failures are explained on the computer', () => {
  it('exit 1 with stderr: prints the agent, the exit code and the last stderr line', async () => {
    const { adapter, spawned, lines } = setup();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.stderr.write('warming up\nbash: lucy: command not found\n\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.exit(127);
    const error = await events.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(lines).toEqual(['Lucy failed (exit 127): bash: lucy: command not found']);
    // Only the code and the fixed message go anywhere else: the reason stays in the local log.
    expect(error).toBeInstanceOf(LocalAgentError);
    expect((error as LocalAgentError).code).toBe('agent_failed');
    expect((error as LocalAgentError).message).toBe('The command failed');
    expect(JSON.stringify(error)).not.toContain('not found');
  });

  it('ENOENT: says the command was not found', async () => {
    const { adapter, spawned, lines } = setup();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.emit('error', Object.assign(new Error('spawn lucy ENOENT'), { code: 'ENOENT' }));
    await expect(events).rejects.toBeInstanceOf(LocalAgentError);
    expect(lines).toEqual(['Lucy failed: command not found: lucy']);
  });

  it('exit 0: prints nothing', async () => {
    const { adapter, spawned, lines } = setup();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.stderr.write('a harmless warning\n');
    child.stdout.write('ok');
    child.exit(0);
    await events;
    expect(lines).toEqual([]);
  });

  it('a cancel prints no failure line', async () => {
    const { adapter, spawned, lines } = setup();
    const controller = new AbortController();
    const events = collect(adapter.sendTurn('hi', controller.signal));
    const child = await spawned[0]!;
    child.stderr.write('interrupted\n');
    controller.abort();
    await events;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(child.killed).toBe(true);
    expect(lines).toEqual([]);
  });

  it('huge stderr: keeps only a bounded tail, and the line is trimmed', async () => {
    const { adapter, spawned, lines } = setup();
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    for (let i = 0; i < 2000; i++) child.stderr.write(`noise ${i} ${'é'.repeat(200)}\n`);
    child.stderr.write(`final ${'x'.repeat(1000)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(Buffer.byteLength(adapter.stderrTail(), 'utf8')).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(adapter.stderrTail()).not.toContain('�');
    child.exit(1);
    await events.catch(() => undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('Lucy failed (exit 1): final xxx')).toBe(true);
    expect(lines[0]!.length).toBeLessThanOrEqual(340);
  });

  it('createAdapter passes the label and log to a command agent', async () => {
    const { spawn, spawned } = fakeSpawner();
    const lines: string[] = [];
    const config: LocalAgentConfig = {
      id: 'lucy',
      label: 'Lucy',
      kind: 'command',
      command: 'lucy',
      args: [],
      cwd: '/w',
    };
    const adapter = createAdapter(config, spawn, undefined, undefined, (l) => lines.push(l));
    const events = collect(adapter.sendTurn('hi', new AbortController().signal));
    const child = await spawned[0]!;
    child.stderr.write('boom\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.exit(2);
    await events.catch(() => undefined);
    expect(lines).toEqual(['Lucy failed (exit 2): boom']);
  });

  it('doctor prints the same reason line', async () => {
    const { spawn, spawned } = fakeSpawner();
    const config: LocalAgentConfig = {
      id: 'lucy',
      label: 'Lucy',
      kind: 'command',
      command: 'lucy',
      args: [],
      cwd: '/w',
    };
    const printed: string[] = [];
    void spawned[0]!.then(async (child) => {
      child.stderr.write('bash: lucy: command not found\n');
      await new Promise((resolve) => setTimeout(resolve, 5));
      child.exit(127);
    });
    const code = await doctor([config], (l) => printed.push(l), undefined, spawn);
    expect(code).toBe(1);
    expect(printed).toContain('  Lucy failed (exit 127): bash: lucy: command not found');
  });
});
