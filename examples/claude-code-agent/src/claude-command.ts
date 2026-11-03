import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** Appended to Claude Code's system prompt: the conversation is a phone call, not a chat. */
export const VOICE_SYSTEM_PROMPT = [
  'You are on a live phone call with the user through Twring; everything you write is spoken aloud.',
  'Answer in short, natural spoken sentences.',
  'Never use markdown, lists, headings, code blocks, tables, emoji, or URLs.',
  'Before using a tool, say one brief natural line first, such as "Let me look that up."',
  'Keep answers under about 60 words unless the user asks for more.',
].join(' ');

/** The tools a phone call may use. No shell, no file access, no MCP. */
export const ALLOWED_TOOLS = ['WebSearch', 'WebFetch'] as const;

/**
 * Flags for one persistent, stream-json Claude Code process (verified against v2.1.282).
 * `--bare` is deliberately absent: it ignores OAuth, so subscription logins fail with it.
 */
export function buildClaudeArgs(model: string): string[] {
  const tools = ALLOWED_TOOLS.join(',');
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // No hooks, plugins, CLAUDE.md, skills, custom agents, or user MCP servers.
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    // Never prompt: anything outside the allowlist is denied.
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--effort',
    'low',
    '--model',
    model,
    '--append-system-prompt',
    VOICE_SYSTEM_PROMPT,
  ];
}

/** The slice of a ChildProcess the session uses, so tests can substitute a fake. */
export interface ClaudeChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  /** Kills the process and everything it started. */
  killTree(): void;
}

export type SpawnClaude = () => ClaudeChild;

export interface ClaudeSpawnOptions {
  bin: string;
  model: string;
}

/**
 * Spawns Claude Code in a fresh empty temp directory (never the repo). The directory is removed
 * when the process exits.
 */
export function createClaudeSpawner(options: ClaudeSpawnOptions): SpawnClaude {
  return () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cord-claude-'));
    const env = { ...process.env };
    // The agent's bearer token is never passed on.
    delete env.CLAUDE_AGENT_TOKEN;
    const child = spawn(options.bin, buildClaudeArgs(options.model), {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.once('exit', () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Best effort; the OS cleans temp eventually.
      }
    });
    return Object.assign(child, {
      killTree() {
        if (child.exitCode !== null || child.pid === undefined) return;
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      },
    });
  };
}

/**
 * Finds the Claude Code executable. npm installs on Windows expose `claude.cmd`, which cannot be
 * spawned without a shell, so the real `claude.exe` behind it is used instead.
 */
export function resolveClaudeBin(override?: string): string {
  if (override !== undefined && override !== '') return override;
  if (process.platform !== 'win32') return 'claude';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const exe = join(dir, 'claude.exe');
    if (existsSync(exe)) return exe;
    if (existsSync(join(dir, 'claude.cmd'))) {
      const npmExe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(npmExe)) return npmExe;
    }
  }
  return 'claude.exe';
}
