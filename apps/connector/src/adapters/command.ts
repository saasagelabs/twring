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
}

export class CommandAdapter implements LocalAgentAdapter {
  private child: ChildLike | null = null;

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
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      const out = decoder.write(chunk);
      if (out !== '' && !signal.aborted) queue.push({ type: 'text', text: out });
    });
    const onExit = (code: number | null) => {
      if (this.child === child) this.child = null;
      const rest = decoder.end();
      if (rest !== '' && !signal.aborted) queue.push({ type: 'text', text: rest });
      queue.end(
        signal.aborted || code === 0
          ? undefined
          : new LocalAgentError('agent_failed', 'The command failed'),
      );
    };
    child.once('exit', onExit);
    child.once('error', () => onExit(null));
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

  close(): void {
    const child = this.child;
    this.child = null;
    child?.killTree();
  }
}
