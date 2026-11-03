import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { LocalAgentError } from './events';

/** The slice of a child process adapters use, so tests can substitute a fake. */
export interface ChildLike {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  /** Kills the process and everything it started. */
  killTree(): void;
}

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
}

export type SpawnFn = (request: SpawnRequest) => ChildLike;

/**
 * Longest stdout line an adapter will read (about 1 MB). A longer line is never held in memory:
 * the rest of it is skipped and `onOverflow` fails the turn.
 */
export const MAX_LINE_CHARS = 1_000_000;

/** The turn failure for an agent that wrote a line over `MAX_LINE_CHARS`. */
export function lineTooLongError(): LocalAgentError {
  return new LocalAgentError('line_too_long', 'The agent wrote a line longer than 1 MB');
}

/**
 * The environment an agent runs with: ours minus the connector's own secrets and anything that
 * would make a nested Claude Code think it runs inside another one (`CLAUDE_CODE_*`, `CLAUDECODE`),
 * which breaks its sign-in.
 */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') continue;
    if (key.startsWith('CORD_CONNECT_')) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Finds an executable on PATH. On Windows, npm installs expose `.cmd` shims, which Node can only
 * start through a shell; those are reported with `shell: true`.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; shell: boolean } | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '');
  const exts =
    process.platform === 'win32'
      ? ['.exe', '.cmd', '.bat', ...(env.PATHEXT ?? '').toLowerCase().split(';')]
      : [''];
  for (const dir of dirs) {
    for (const ext of new Set(exts)) {
      const candidate = join(dir, `${name}${ext}`);
      if (existsSync(candidate)) {
        const kind = extname(candidate).toLowerCase();
        return { path: candidate, shell: kind === '.cmd' || kind === '.bat' };
      }
    }
  }
  return undefined;
}

/** Arguments `cmd.exe` passes through untouched. */
const CMD_PLAIN = /^[A-Za-z0-9_.,:=+@/\\-]+$/;
/** Characters `cmd.exe` still interprets inside double quotes (or that end the command). */
const CMD_UNSAFE = /["%!\r\n\0]/;

/**
 * One word of a `cmd.exe /s /c` command line: plain words as they are, anything else in double
 * quotes (so spaces and `& | < > ^` are literal). Refuses what quoting cannot make safe.
 */
export function cmdQuote(word: string): string {
  if (CMD_PLAIN.test(word)) return word;
  if (CMD_UNSAFE.test(word)) {
    throw new Error('This argument cannot be passed safely to a Windows command shim.');
  }
  return `"${word}"`;
}

/**
 * Spawns without a shell where possible. A Windows `.cmd` shim needs one: only fixed arguments may
 * be passed then (never user text), which every adapter here guarantees; the command adapter sends
 * user text on stdin. The shim's path and arguments are quoted for `cmd.exe` (a user folder like
 * `C:\Users\John Smith` has a space), and anything `cmd.exe` would expand is refused.
 *
 * On macOS and Linux the agent leads its own process group, so `killTree` stops everything it
 * started (tools, sub-agents), not only the agent itself.
 */
export const systemSpawn: SpawnFn = ({ command, args, cwd, env }) => {
  const resolved = findExecutable(command) ?? { path: command, shell: false };
  const options = {
    cwd,
    env: { ...agentEnv(), ...env },
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  };
  const child = resolved.shell
    ? spawn([resolved.path, ...args].map(cmdQuote).join(' '), [], { ...options, shell: true })
    : spawn(resolved.path, [...args], options);
  return Object.assign(child, {
    killTree() {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
  });
};

/**
 * Calls `onLine` for each stdout line (without its `\n` or `\r\n`). Memory stays bounded: a line
 * longer than `maxChars` is dropped as it streams in, and `onOverflow` runs once for it.
 */
export function readLines(
  stream: Readable,
  onLine: (line: string) => void,
  onOverflow?: () => void,
  maxChars: number = MAX_LINE_CHARS,
): void {
  let partial = '';
  /** Inside an oversized line: everything up to its end is skipped. */
  let skipping = false;
  const emit = (line: string) => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf('\n', start);
      if (end === -1) break;
      if (skipping) skipping = false;
      else if (partial.length + (end - start) <= maxChars) emit(partial + chunk.slice(start, end));
      else onOverflow?.();
      partial = '';
      start = end + 1;
    }
    if (skipping) return;
    const rest = chunk.slice(start);
    if (partial.length + rest.length > maxChars) {
      partial = '';
      skipping = true;
      onOverflow?.();
      return;
    }
    partial += rest;
  });
  stream.on('end', () => {
    if (!skipping && partial !== '') emit(partial);
    partial = '';
  });
}

/** Parses one JSON line; undefined for anything that isn't a JSON object. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Writes one line of JSON, ignoring a closed pipe (the exit handler reports that). */
export function writeJsonLine(child: ChildLike, message: unknown): void {
  if (child.stdin.destroyed) return;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
