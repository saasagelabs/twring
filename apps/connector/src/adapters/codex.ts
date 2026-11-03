import {
  EventQueue,
  LocalAgentError,
  type LocalAgentAdapter,
  type LocalAgentEvent,
} from '../events';
import {
  isRecord,
  lineTooLongError,
  parseJsonLine,
  readLines,
  type ChildLike,
  type SpawnFn,
} from '../process';
import { withPreamble } from '../preamble';
import { withFilePaths, type LocalFile } from '../turn-files';

/**
 * OpenAI Codex CLI through its documented non-interactive mode, `codex exec --json`
 * (https://developers.openai.com/codex/noninteractive): the prompt goes on stdin (`-`), stdout is
 * JSON Lines (`thread.started`, `item.started` / `item.completed`, `turn.completed`,
 * `turn.failed`, `error`). One process per turn; later turns continue the same thread with
 * `codex exec resume <thread_id>`. Defaults to `--sandbox read-only`. Codex reports a reply as a
 * whole `agent_message` item, so speech starts when the reply is complete, not word by word.
 */

export type CodexSandbox = 'read-only' | 'workspace-write';

export interface CodexOptions {
  command: string;
  cwd: string;
  spawn: SpawnFn;
  sandbox?: CodexSandbox;
  /** A thread to continue (`codex exec resume`, an answered ring); a new thread if it fails. */
  resume?: string;
  /** Put in front of the call's first user turn (the call preamble). */
  preamble?: string;
}

export function buildCodexArgs(
  sandbox: CodexSandbox,
  threadId?: string,
  images: readonly string[] = [],
): string[] {
  if (threadId === undefined) {
    return [
      'exec',
      '--json',
      '--sandbox',
      sandbox,
      '--skip-git-repo-check',
      ...images.map((path) => `--image=${path}`),
      '-',
    ];
  }
  // `codex exec resume` takes no --sandbox (codex-cli 0.156: "unexpected argument"), so every
  // follow-up turn failed at once. The config override sets the same sandbox for the resumed run.
  // Unquoted on purpose: Codex reads a value that isn't TOML as a plain string, and on Windows the
  // `codex.cmd` shim refuses double quotes in arguments (cmdQuote).
  return [
    'exec',
    'resume',
    threadId,
    '--json',
    '--skip-git-repo-check',
    '-c',
    `sandbox_mode=${sandbox}`,
    ...images.map((path) => `--image=${path}`),
    '-',
  ];
}

const TOOL_ITEMS: Record<string, string> = {
  command_execution: 'Running a command',
  file_change: 'Editing files',
  file_changes: 'Editing files',
  mcp_tool_call: 'Using a tool',
  web_search: 'Searching the web',
};

export class CodexAdapter implements LocalAgentAdapter {
  private threadId: string | undefined;
  private child: ChildLike | null = null;
  /** The thread came from an answered ring and has not answered a turn yet. */
  private resuming: boolean;
  /**
   * The thread Codex took a preamble-carrying turn into (it reported something for that turn). A
   * turn cancelled or failed before Codex opened its thread leaves the next new thread without it,
   * so it is given again until a thread has it.
   */
  private preambleThread: string | undefined;

  constructor(private readonly options: CodexOptions) {
    this.threadId = options.resume;
    this.resuming = options.resume !== undefined;
  }

  sessionRef(): string | undefined {
    return this.threadId;
  }

  async *sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    if (!this.resuming) {
      yield* this.runTurn(text, signal, options?.files);
      return;
    }
    let emitted = false;
    try {
      for await (const event of this.runTurn(text, signal, options?.files)) {
        emitted = true;
        yield event;
      }
      this.resuming = false;
    } catch (error) {
      // The thread could not be resumed and Codex did nothing with the turn: run it once more
      // in a new thread. Anything already reported means Codex worked on it, so never twice.
      if (emitted || signal.aborted || !this.resuming) throw error;
      this.resuming = false;
      this.threadId = undefined;
      yield* this.runTurn(text, signal, options?.files);
    }
  }

  private async *runTurn(
    turnText: string,
    signal: AbortSignal,
    files: readonly LocalFile[] = [],
  ): AsyncIterable<LocalAgentEvent> {
    if (this.child !== null) throw new Error('a turn is already running');
    if (signal.aborted) return;
    // A new thread has never seen the preamble; a resumed ring thread gets it again, once per call.
    const { preamble } = this.options;
    const carriesPreamble =
      preamble !== undefined &&
      (this.threadId === undefined || this.threadId !== this.preambleThread);
    const prompt = withFilePaths(
      turnText,
      files.filter((file) => !file.mimeType.startsWith('image/')),
    );
    const text = carriesPreamble ? withPreamble(preamble, prompt) : prompt;
    const queue = new EventQueue<LocalAgentEvent>();
    const openTools = new Set<string>();
    const child = this.options.spawn({
      command: this.options.command,
      args: buildCodexArgs(
        this.options.sandbox ?? 'read-only',
        this.threadId,
        files.filter((file) => file.mimeType.startsWith('image/')).map((file) => file.path),
      ),
      cwd: this.options.cwd,
    });
    this.child = child;
    let completed = false;
    let failure: Error | undefined;
    const endTools = () => {
      for (const id of openTools) queue.push({ type: 'tool.end', id, status: 'cancelled' });
      openTools.clear();
    };
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    readLines(
      child.stdout,
      (line) => {
        const event = parseJsonLine(line);
        if (event === undefined || signal.aborted) return;
        if (
          event.type === 'thread.started' &&
          typeof event.thread_id === 'string' &&
          // It goes back on a command line (maybe through a shell on Windows): ids only.
          /^[A-Za-z0-9_-]{1,128}$/.test(event.thread_id)
        ) {
          this.threadId = event.thread_id;
        }
        // Codex is working on this turn in its thread: the preamble is in that thread now.
        if (carriesPreamble && this.threadId !== undefined) this.preambleThread = this.threadId;
        switch (event.type) {
          case 'thread.started':
            return;
          case 'item.started':
          case 'item.completed': {
            const item = isRecord(event.item) ? event.item : {};
            const id = typeof item.id === 'string' ? item.id : undefined;
            const type = typeof item.type === 'string' ? item.type : '';
            if (event.type === 'item.completed' && type === 'agent_message') {
              if (typeof item.text === 'string' && item.text !== '')
                queue.push({ type: 'text', text: item.text });
              return;
            }
            const label = TOOL_ITEMS[type];
            if (id === undefined || label === undefined) return;
            if (event.type === 'item.started' && !openTools.has(id)) {
              openTools.add(id);
              queue.push({ type: 'tool.start', id, name: type, label });
            } else if (event.type === 'item.completed' && openTools.delete(id)) {
              queue.push({
                type: 'tool.end',
                id,
                status: item.status === 'failed' ? 'error' : 'success',
              });
            }
            return;
          }
          case 'turn.completed':
            completed = true;
            return;
          case 'turn.failed':
          case 'error':
            failure ??= new LocalAgentError('agent_failed', 'Codex reported an error');
            return;
          default:
            return;
        }
      },
      () => {
        failure ??= lineTooLongError();
        child.killTree();
      },
    );
    const onExit = (code: number | null) => {
      if (this.child === child) this.child = null;
      endTools();
      if (signal.aborted) queue.end();
      else if (failure !== undefined) queue.end(failure);
      else if (!completed || code !== 0)
        queue.end(new LocalAgentError('agent_failed', 'Codex stopped before finishing'));
      else queue.end();
    };
    child.once('exit', onExit);
    child.once('error', () => onExit(null));
    const onAbort = () => {
      // `codex exec` has no documented interrupt: stopping the process is the cancel.
      child.killTree();
      endTools();
      queue.end();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdin.end(text);
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
