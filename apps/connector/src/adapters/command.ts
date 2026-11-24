import { StringDecoder } from 'node:string_decoder';
import type { LocalFile } from '../turn-files';
import { withFilePaths } from '../turn-files';

import {
  EventQueue,
  LocalAgentError,
  type LocalAgentAdapter,
  type LocalAgentEvent,
} from '../events';
import type { ChildLike, SpawnFn } from '../process';

/**
 * Any other agent: a command that reads the user's words on stdin and writes its answer to stdout,
 * which is spoken as it streams. One process per turn, so the command keeps its own memory (if
 * any) itself. Cancel stops the process. User text never goes on the command line.
 */
export interface CommandOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  spawn: SpawnFn;
  /** The agent's name in local log lines. */
  label?: string;
  /** Local log only: why the command failed. Never sent to Twring (stderr can be private). */
  log?: (line: string) => void;
}

/** How much of the command's stderr is kept, from the end, to explain a failure. */
export const STDERR_TAIL_BYTES = 2048;
const REASON_CHARS = 300;

/** The last `max` bytes of a stream, never split inside a UTF-8 character. */
class TailBuffer {
  private buffer = Buffer.alloc(0);
  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const joined = Buffer.concat([this.buffer, chunk.subarray(-this.max)]);
    let start = Math.max(0, joined.length - this.max);
    // Skip UTF-8 continuation bytes so the tail starts on a whole character.
    while (start < joined.length && (joined[start]! & 0xc0) === 0x80) start++;
    this.buffer = joined.subarray(start);
  }

  text(): string {
    return new StringDecoder('utf8').end(this.buffer);
  }
}

/** One local line saying why the command failed, or undefined when there's nothing to say. */
function failureLine(
  label: string,
  command: string,
  code: number | null,
  spawnError: NodeJS.ErrnoException | undefined,
  stderr: string,
): string {
  if (spawnError?.code === 'ENOENT') return `${label} failed: command not found: ${command}`;
  const last = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  const reason = last ?? spawnError?.message;
  const head = `${label} failed${code === null ? '' : ` (exit ${code})`}`;
  if (reason === undefined) return head;
  const trimmed = reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS)}...` : reason;
  return `${head}: ${trimmed}`;
}

export class CommandAdapter implements LocalAgentAdapter {
  private child: ChildLike | null = null;
  private stderr = new TailBuffer(STDERR_TAIL_BYTES);

  constructor(private readonly options: CommandOptions) {}

  async *sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    if (this.child !== null) throw new Error('a turn is already running');
    if (signal.aborted) return;
    const queue = new EventQueue<LocalAgentEvent>();
    const child = this.options.spawn({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
    });
    this.child = child;
    const decoder = new StringDecoder('utf8');
    child.stdin.on('error', () => undefined);
    const stderr = new TailBuffer(STDERR_TAIL_BYTES);
    this.stderr = stderr;
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdout.on('data', (chunk: Buffer) => {
      const out = decoder.write(chunk);
      if (out !== '' && !signal.aborted) queue.push({ type: 'text', text: out });
    });
    let ended = false;
    const onExit = (code: number | null, spawnError?: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      if (this.child === child) this.child = null;
      const rest = decoder.end();
      if (rest !== '' && !signal.aborted) queue.push({ type: 'text', text: rest });
      const failed = !signal.aborted && (code !== 0 || spawnError !== undefined);
      if (failed) {
        this.options.log?.(
          failureLine(
            this.options.label ?? this.options.command,
            this.options.command,
            code,
            spawnError,
            stderr.text(),
          ),
        );
      }
      queue.end(failed ? new LocalAgentError('agent_failed', 'The command failed') : undefined);
    };
    child.once('exit', (code) => onExit(code));
    child.once('error', (error) => onExit(null, error));
    const onAbort = () => {
      child.killTree();
      queue.end();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(withFilePaths(text, options?.files ?? []));
    try {
      yield* queue;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (this.child === child) {
        this.child = null;
        child.killTree();
      }
    }
  }

  /** The kept end of the last turn's stderr (for tests). */
  stderrTail(): string {
    return this.stderr.text();
  }

  close(): void {
    const child = this.child;
    this.child = null;
    child?.killTree();
  }
}
