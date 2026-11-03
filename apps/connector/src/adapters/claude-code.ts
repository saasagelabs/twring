import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import { SESSION_REF_PATTERN, STAY_ON_CALL_RULE, TEXT_TURN_TAG } from '@twring/contracts';

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
  writeJsonLine,
  type ChildLike,
  type SpawnFn,
} from '../process';
import { memberInstructions, ringCommand } from '../preamble';
import { withFilePaths, type LocalFile } from '../turn-files';

/**
 * Claude Code over `claude -p --input-format stream-json --output-format stream-json`, ported from
 * examples/claude-code-agent (verified there against v2.1.282). One process per call keeps the
 * conversation; a barge-in sends the stream-json `interrupt` control request.
 */

/** Appended to Claude Code's system prompt for Twring calls and typed messages. */
export const TWRING_SYSTEM_PROMPT = [
  'You are connected to the user through Twring by live voice calls and typed messages.',
  'On a call, everything you write is spoken aloud: answer in short, natural spoken sentences.',
  'On calls, never use markdown, lists, headings, code blocks, tables, emoji, or URLs.',
  'On calls, before using a tool, say one brief natural line first, such as "Let me look that up."',
  'On calls, keep answers under about 60 words unless the user asks for more.',
  STAY_ON_CALL_RULE,
  `A turn starting with ${TEXT_TURN_TAG} is a typed chat message: answer in normal written text; markdown is allowed, and the call rules do not apply.`,
  `To ring the user later (for example when a long task finishes), run: ${ringCommand()} "<short reason>"`,
].join(' ');

/** The system prompt for one session: the owner's, or (a shared server agent) a team member's. */
export function twringSystemPrompt(scope?: string): string {
  return scope === undefined ? TWRING_SYSTEM_PROMPT : memberInstructions(ringCommand(), scope);
}

/** Safe default: read and search only. No shell, no edits, no MCP. */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'] as const;
/** Opt-in (`--claude-allow-edits`): may also change files. Still no shell. */
export const EDIT_TOOLS = [...READ_ONLY_TOOLS, 'Edit', 'Write'] as const;

export interface ClaudeCodeOptions {
  command: string;
  cwd: string;
  tools: readonly string[];
  model?: string;
  spawn: SpawnFn;
  initTimeoutMs?: number;
  interruptTimeoutMs?: number;
  /** A session id to continue (`--resume`, an answered ring); a new session if it fails. */
  resume?: string;
  /** A team member's own session on a shared server agent. */
  scope?: string;
}

export function buildClaudeArgs(
  tools: readonly string[],
  model?: string,
  resume?: string,
  scope?: string,
): string[] {
  const list = tools.join(',');
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--tools',
    list,
    '--allowedTools',
    list,
    // Never prompt: anything outside the allowlist is denied.
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    // Continue the persisted conversation when a prior session id is known.
    ...(resume === undefined ? [] : ['--resume', resume]),
    '--effort',
    'low',
    ...(model === undefined ? [] : ['--model', model]),
    '--append-system-prompt',
    twringSystemPrompt(scope),
  ];
}

/**
 * The Claude Code executable. npm installs on Windows expose `claude.cmd`, which cannot be spawned
 * without a shell (and the system prompt would need shell quoting), so the real `claude.exe`
 * behind it is used instead.
 */
export function resolveClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return 'claude';
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
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

interface Turn {
  queue: EventQueue<LocalAgentEvent>;
  blocks: Map<number, 'text' | 'tool' | 'other'>;
  openTools: Set<string>;
  cancelling: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
}

export class ClaudeCodeAdapter implements LocalAgentAdapter {
  private child: ChildLike | null = null;
  private starting: Promise<ChildLike> | null = null;
  private pendingInit: { id: string; resolve(): void; reject(error: Error): void } | null = null;
  private turn: Turn | null = null;
  private closed = false;
  /** The session to resume; cleared once a resume failed (the retry is a new session). */
  private resume: string | undefined;
  private sessionId: string | undefined;
  private newSession = false;

  constructor(private readonly options: ClaudeCodeOptions) {
    this.resume = options.resume;
  }

  sessionRef(): string | undefined {
    return this.sessionId ?? this.resume;
  }

  takeNewSession(): boolean {
    const value = this.newSession;
    this.newSession = false;
    return value;
  }

  async *sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    if (this.turn !== null) throw new Error('a turn is already running');
    const child = await this.ensureStarted();
    if (signal.aborted) return;
    const turn: Turn = {
      queue: new EventQueue(),
      blocks: new Map(),
      openTools: new Set(),
      cancelling: false,
    };
    this.turn = turn;
    const onAbort = () => this.interrupt(turn);
    signal.addEventListener('abort', onAbort, { once: true });
    const files = options?.files ?? [];
    const inline = files.filter(
      (file) => file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf',
    );
    const prompt = withFilePaths(
      text,
      files.filter((file) => !inline.includes(file)),
    );
    let content: string | Record<string, unknown>[];
    try {
      content =
        files.length === 0
          ? text
          : [
              { type: 'text', text: prompt },
              ...(await Promise.all(
                inline.map(async (file) => ({
                  type: file.mimeType === 'application/pdf' ? 'document' : 'image',
                  source: {
                    type: 'base64',
                    media_type: file.mimeType,
                    data: (await readFile(file.path)).toString('base64'),
                  },
                })),
              )),
            ];
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = null;
      throw error;
    }
    writeJsonLine(child, {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    try {
      yield* turn.queue;
    } finally {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(turn.interruptTimer);
      if (this.turn === turn) this.turn = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.turn?.queue.end();
    this.kill();
  }

  private ensureStarted(): Promise<ChildLike> {
    if (this.closed) return Promise.reject(new LocalAgentError('closed', 'agent closed'));
    if (this.child !== null && this.starting === null) return Promise.resolve(this.child);
    this.starting ??= this.start()
      .catch(async (error: unknown) => {
        if (this.resume === undefined || this.closed) throw error;
        // The session could not be resumed (unknown id, other folder): start a new one.
        this.resume = undefined;
        this.sessionId = undefined;
        const child = await this.start();
        this.newSession = true;
        return child;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async start(): Promise<ChildLike> {
    const child = this.options.spawn({
      command: this.options.command,
      args: buildClaudeArgs(
        this.options.tools,
        this.options.model,
        this.resume,
        this.options.scope,
      ),
      cwd: this.options.cwd,
    });
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    readLines(
      child.stdout,
      (line) => {
        if (this.child !== child) return;
        const message = parseJsonLine(line);
        if (message !== undefined) this.onMessage(message);
      },
      () => {
        if (this.child !== child) return;
        // A message was lost, so the stream can no longer be followed: fail the turn and start
        // a fresh process for the next one.
        this.turn?.queue.end(lineTooLongError());
        this.kill();
      },
    );
    child.once('error', () => this.onExit(child));
    child.once('exit', () => this.onExit(child));
    const id = `init_${randomUUID()}`;
    const ready = new Promise<void>((resolve, reject) => {
      this.pendingInit = { id, resolve, reject };
    });
    writeJsonLine(child, {
      type: 'control_request',
      request_id: id,
      request: { subtype: 'initialize' },
    });
    const timer = setTimeout(
      () =>
        this.pendingInit?.reject(
          new LocalAgentError('agent_unavailable', 'Claude Code did not start in time'),
        ),
      this.options.initTimeoutMs ?? 30_000,
    );
    try {
      await ready;
      return child;
    } catch (error) {
      if (this.child === child) this.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      this.pendingInit = null;
    }
  }

  private interrupt(turn: Turn): void {
    if (turn.cancelling || turn.queue.isEnded) return;
    turn.cancelling = true;
    const child = this.child;
    if (child !== null) {
      writeJsonLine(child, {
        type: 'control_request',
        request_id: `int_${randomUUID()}`,
        request: { subtype: 'interrupt' },
      });
    }
    turn.interruptTimer = setTimeout(() => {
      // Claude did not wind down in time: replace the process (its memory is lost).
      this.kill();
      this.finish(turn);
    }, this.options.interruptTimeoutMs ?? 5_000);
  }

  private onMessage(message: Record<string, unknown>): void {
    if (
      this.sessionId === undefined &&
      typeof message.session_id === 'string' &&
      SESSION_REF_PATTERN.test(message.session_id)
    ) {
      this.sessionId = message.session_id;
    }
    if (message.type === 'control_response') {
      const response = isRecord(message.response) ? message.response : {};
      if (this.pendingInit !== null && response.request_id === this.pendingInit.id) {
        if (response.subtype === 'success') this.pendingInit.resolve();
        else
          this.pendingInit.reject(
            new LocalAgentError('agent_unavailable', 'Claude Code refused to start'),
          );
      }
      return;
    }
    const turn = this.turn;
    if (turn === null) return;
    if (message.type === 'result') {
      if (!turn.cancelling && (message.subtype !== 'success' || message.is_error === true)) {
        this.finish(turn, new LocalAgentError('agent_failed', 'Claude Code reported an error'));
      } else {
        this.finish(turn);
      }
      return;
    }
    // Nothing more is forwarded for an interrupted turn.
    if (turn.cancelling) return;
    if (
      message.type === 'stream_event' &&
      isRecord(message.event) &&
      message.parent_tool_use_id == null
    ) {
      this.mapStreamEvent(turn, message.event);
    } else if (message.type === 'user') {
      this.mapToolResults(turn, message);
    }
  }

  private mapStreamEvent(turn: Turn, event: Record<string, unknown>): void {
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start':
        turn.blocks.clear();
        return;
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : {};
        if (block.type === 'text') {
          turn.blocks.set(index, 'text');
          if (typeof block.text === 'string' && block.text !== '')
            turn.queue.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name.slice(0, 128) : 'unknown';
          turn.blocks.set(index, 'tool');
          turn.openTools.add(block.id);
          turn.queue.push({ type: 'tool.start', id: block.id, name, label: toolLabel(name) });
        } else {
          turn.blocks.set(index, 'other');
        }
        return;
      }
      case 'content_block_delta': {
        const delta = isRecord(event.delta) ? event.delta : {};
        if (
          turn.blocks.get(index) === 'text' &&
          delta.type === 'text_delta' &&
          typeof delta.text === 'string'
        ) {
          turn.queue.push({ type: 'text', text: delta.text });
        }
        return;
      }
      default:
        return;
    }
  }

  private mapToolResults(turn: Turn, message: Record<string, unknown>): void {
    const inner = isRecord(message.message) ? message.message : {};
    if (!Array.isArray(inner.content)) return;
    for (const part of inner.content as unknown[]) {
      if (!isRecord(part) || part.type !== 'tool_result') continue;
      const id = part.tool_use_id;
      if (typeof id !== 'string' || !turn.openTools.delete(id)) continue;
      turn.queue.push({
        type: 'tool.end',
        id,
        status: part.is_error === true ? 'error' : 'success',
      });
    }
  }

  private finish(turn: Turn, error?: Error): void {
    clearTimeout(turn.interruptTimer);
    for (const id of turn.openTools) turn.queue.push({ type: 'tool.end', id, status: 'cancelled' });
    turn.openTools.clear();
    turn.queue.end(error);
  }

  private onExit(child: ChildLike): void {
    if (this.child !== child) return;
    this.child = null;
    this.pendingInit?.reject(new LocalAgentError('agent_unavailable', 'Claude Code exited'));
    const turn = this.turn;
    if (turn !== null) {
      this.finish(
        turn,
        turn.cancelling ? undefined : new LocalAgentError('agent_failed', 'Claude Code exited'),
      );
    }
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    child?.killTree();
  }
}

function toolLabel(name: string): string {
  switch (name) {
    case 'WebSearch':
      return 'Searching the web';
    case 'WebFetch':
      return 'Reading a web page';
    case 'Read':
    case 'Grep':
    case 'Glob':
      return 'Looking through files';
    case 'Edit':
    case 'Write':
      return 'Editing files';
    default:
      return 'Working';
  }
}
