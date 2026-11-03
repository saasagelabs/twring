import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createAdapter, type LocalAgentConfig } from './agents';
import { saveConfig, type ConnectorConfig } from './config';
import type { LocalAgentEvent } from './events';
import { fakeSpawner } from './fake-child';
import {
  claudeSettingsPath,
  codexConfigPath,
  installClaudeHook,
  installCodexNotify,
  parseHookInput,
  uninstallCodexNotify,
} from './hooks';
import { ringOwner, type FetchFn } from './ring';

/** Verifier edge cases for rings (ADR-024): argument injection, truncation, hooks, --from-hook. */

const TOKEN = `cct_${'a'.repeat(43)}`;
const INVITE = `inv_${'a'.repeat(26)}`;
const BOM = String.fromCharCode(0xfeff);
/** Half of a surrogate pair: a character cut in two. */
const cutInTwo = (text: string): boolean =>
  Array.from(text).some(
    (c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff,
  );
const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function tempDir(prefix = 'cord-verify-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return dir;
}

const claude: LocalAgentConfig = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'claude-code',
  command: 'claude',
  args: [],
  cwd: '/w',
};
const codex: LocalAgentConfig = {
  id: 'codex',
  label: 'Codex',
  kind: 'codex',
  command: 'codex',
  args: [],
  cwd: '/w',
};

function config(server = 'https://cord.example.com'): ConnectorConfig {
  return {
    server,
    connector_id: `con_${'d'.repeat(20)}`,
    token: TOKEN,
    name: 'Laptop',
    agents: [claude, codex],
  };
}

async function collect(stream: AsyncIterable<LocalAgentEvent>): Promise<LocalAgentEvent[]> {
  const out: LocalAgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** A session ref that is really a command-line flag. */
const FLAG_REFS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--last',
  '-c',
];

describe('resume refs never become command-line flags', () => {
  it('codex: a flag-shaped resume ref is not passed to `codex exec resume`', async () => {
    for (const ref of FLAG_REFS) {
      const { spawn, spawned } = fakeSpawner();
      const adapter = createAdapter(codex, spawn, ref);
      void collect(adapter.sendTurn('x', new AbortController().signal)).catch(() => undefined);
      const child = await spawned[0]!;
      expect(child.request.args).not.toContain(ref);
      adapter.close();
    }
  });

  it('claude-code: a flag-shaped resume ref is not passed after --resume', async () => {
    for (const ref of FLAG_REFS) {
      const { spawn, spawned } = fakeSpawner();
      const adapter = createAdapter(claude, spawn, ref);
      void collect(adapter.sendTurn('x', new AbortController().signal)).catch(() => undefined);
      const child = await spawned[0]!;
      expect(child.request.args).not.toContain(ref);
      adapter.close();
    }
  });

  it('a flag-shaped --session or hook session id is not sent as session_ref', async () => {
    const bodies: unknown[] = [];
    const fetch: FetchFn = (_url, init) => {
      bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(
        new Response(
          JSON.stringify({ invite_id: INVITE, expires_at: '2026-10-01T00:00:30.000Z' }),
          {
            status: 201,
          },
        ),
      );
    };
    await ringOwner(
      config(),
      { reason: 'hi', session: '--dangerously-skip-permissions', wait: false },
      { fetch, print: () => undefined },
    );
    expect(bodies[0]).not.toHaveProperty('session_ref');
    const hook = parseHookInput(
      'claude',
      JSON.stringify({ hook_event_name: 'Notification', session_id: '--last', message: 'hi' }),
    );
    expect(hook?.sessionRef).toBeUndefined();
    // Real ids still resume.
    expect(
      parseHookInput(
        'codex',
        JSON.stringify({
          type: 'agent-turn-complete',
          'thread-id': '0199a213-81c0-7800-8aa1-bbab2a035a53',
        }),
      )?.sessionRef,
    ).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });
});

describe('reason truncation', () => {
  it('never splits a character in two when cutting to 140', async () => {
    const bodies: { reason: string }[] = [];
    const fetch: FetchFn = (_url, init) => {
      bodies.push(JSON.parse(init.body as string) as { reason: string });
      return Promise.resolve(
        new Response(
          JSON.stringify({ invite_id: INVITE, expires_at: '2026-10-01T00:00:30.000Z' }),
          {
            status: 201,
          },
        ),
      );
    };
    await ringOwner(
      config(),
      { reason: `${'a'.repeat(139)}😀 and more`, wait: false },
      { fetch, print: () => undefined },
    );
    const sent = bodies[0]!.reason;
    expect(sent.length).toBeLessThanOrEqual(140);
    expect(cutInTwo(sent)).toBe(false);

    const hook = parseHookInput(
      'claude',
      JSON.stringify({ hook_event_name: 'Notification', message: `${'b'.repeat(138)}😀😀😀` }),
    );
    expect(hook!.reason.length).toBeLessThanOrEqual(140);
    expect(cutInTwo(hook!.reason)).toBe(false);
  });

  it('the ring POST has a deadline, so a hook never hangs on an unresponsive server', async () => {
    let signal: AbortSignal | undefined;
    const fetch: FetchFn = (_url, init) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response('{}', { status: 500 }));
    };
    await ringOwner(config(), { reason: 'hi', wait: false }, { fetch, print: () => undefined });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('hooks install never clobbers', () => {
  it('codex: notify is not inserted inside a multi-line string that has a [line]', async () => {
    const home = await tempDir();
    const path = codexConfigPath(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    const original = [
      'model = "gpt-5-codex"',
      'developer_instructions = """',
      'Rules:',
      '[important] never push to main',
      '"""',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n');
    await writeFile(path, original);
    await installCodexNotify(home, true);
    const text = await readFile(path, 'utf8');
    // The string's content is untouched.
    expect(text).toContain('Rules:\n[important] never push to main\n"""');
    // notify is a top-level key: outside the string, before the first table.
    const notifyAt = text.indexOf('notify = [');
    const stringStart = text.indexOf('"""');
    const stringEnd = text.indexOf('"""', stringStart + 3);
    expect(notifyAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt > stringStart && notifyAt < stringEnd).toBe(false);
    expect(notifyAt).toBeLessThan(text.indexOf('[profiles.fast]'));
  });

  it('codex: install then uninstall restores the file byte for byte (BOM, arrays, CRLF)', async () => {
    const home = await tempDir();
    const path = codexConfigPath(home);
    await mkdir(join(home, '.codex'), { recursive: true });
    const original = [
      `${BOM}# my config`,
      'model = "gpt-5-codex"',
      'trusted = [',
      '  ["a", "b"],',
      ']',
      "prompt = '''",
      'notify = not a key, just text',
      "'''",
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\r\n');
    await writeFile(path, original);
    await installCodexNotify(home, true);
    const installed = await readFile(path, 'utf8');
    expect(installed.startsWith(`${BOM}notify = [`)).toBe(true);
    expect(await installCodexNotify(home, true)).toEqual([
      `Already installed in ${path}. Nothing changed.`,
    ]);
    await uninstallCodexNotify(home);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('claude: a symlinked settings.json stays a symlink and its target gets the hook', async (ctx) => {
    const home = await tempDir();
    const dotfiles = await tempDir('cord-dotfiles-');
    const target = join(dotfiles, 'claude-settings.json');
    await writeFile(target, JSON.stringify({ model: 'opus' }));
    await mkdir(join(home, '.claude'), { recursive: true });
    try {
      await symlink(target, claudeSettingsPath(home), 'file');
    } catch {
      ctx.skip(); // Windows without symlink rights.
    }
    await installClaudeHook(home);
    expect((await lstat(claudeSettingsPath(home))).isSymbolicLink()).toBe(true);
    const settings = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(settings.model).toBe('opus');
    expect(JSON.stringify(settings.hooks)).toContain('--from-hook claude');
  });
});

function runCli(
  configDir: string,
  args: string[],
  stdin: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: { ...process.env, CORD_CONNECT_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdout.resume();
  child.stdin.end(stdin);
  const timer = setTimeout(() => child.kill(), 20_000);
  return new Promise((resolve) =>
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    }),
  );
}

describe('ring --from-hook always exits 0', () => {
  it('with junk stdin, a junk argument, no pairing, or a damaged pairing file', async () => {
    const empty = await tempDir();
    const junk = await runCli(empty, ['ring', '--from-hook', 'claude'], '\u0000not json{{');
    expect(junk.code).toBe(0);
    const junkArg = await runCli(empty, ['ring', '--from-hook', 'codex', '{"type":'], '');
    expect(junkArg.code).toBe(0);
    const badSource = await runCli(empty, ['ring', '--from-hook', 'gemini'], '{}');
    expect(badSource.code).toBe(0);

    const damaged = await tempDir();
    await writeFile(join(damaged, 'config.json'), '{"server": 1');
    const hook = JSON.stringify({ hook_event_name: 'Notification', message: 'Needs you' });
    const res = await runCli(damaged, ['ring', '--from-hook', 'claude'], hook);
    expect(res.code).toBe(0);
  }, 60_000);

  it('with an unreachable server', async () => {
    const dir = await tempDir();
    await saveConfig(join(dir, 'config.json'), config('http://127.0.0.1:9'));
    const hook = JSON.stringify({ hook_event_name: 'Notification', message: 'Needs you' });
    const res = await runCli(dir, ['ring', '--from-hook', 'claude'], hook);
    expect(res.code).toBe(0);
  }, 30_000);
});
