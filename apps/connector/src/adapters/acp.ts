import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { APPROVAL_HOLD_MS, MAX_FILE_BYTES, type ApprovalAction } from '@twring/contracts';

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
import { withPreamble } from '../preamble';
import { withFilePaths, type LocalFile } from '../turn-files';

/**
 * Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0, one JSON object per line
 * over the agent's stdio, as Zed uses it. Gemini CLI speaks it natively (`gemini --acp`), Hermes
 * with `hermes acp`. Twring is the client: it sends `initialize`, `session/new`, then one
 * `session/prompt` per turn, and relays `session/update` notifications. It offers no file system
 * or terminal to the agent, and answers permission requests itself: deny, unless the tool's kind
 * is on the user's allowlist.
 */

export const ACP_PROTOCOL_VERSION = 1;

/** ACP tool kinds (`read`, `search`, `fetch`, `edit`, `execute`, …) the user allowed. */
export interface AcpOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  spawn: SpawnFn;
  /** Tool kinds to allow once when the agent asks. Empty (default): every request is denied. */
  allowKinds?: readonly string[];
  startTimeoutMs?: number;
  cancelTimeoutMs?: number;
  /**
   * A session to continue (an answered ring): `session/load` when the agent advertises
   * `loadSession`, otherwise (or if loading fails) a new session.
   */
  resume?: string;
  /** Put in front of the first user turn of each session (the call preamble). */
  preamble?: string;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

interface Turn {
  queue: EventQueue<LocalAgentEvent>;
  openTools: Set<string>;
  cancelling: boolean;
  cancelTimer?: ReturnType<typeof setTimeout>;
  surface: 'call' | 'text';
  imageCount: number;
}

export const ACP_APPROVAL_TIMEOUT_MS = 125_000;
const APPROVAL_FALLBACK: Record<ApprovalAction, string> = {
  edit_files: 'Change files',
  delete_files: 'Delete files',
  run_command: 'Run a command',
  read_files: 'Read files',
  fetch_web: 'Open a web page',
  other: 'Approve an action',
};
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
function approvalId(): string {
  return `apr_${Array.from(randomBytes(20), (byte) => BASE32[byte & 31]).join('')}`;
}
function approvalAction(kind: string): ApprovalAction {
  switch (kind) {
    case 'edit':
    case 'move':
      return 'edit_files';
    case 'delete':
      return 'delete_files';
    case 'execute':
      return 'run_command';
    case 'read':
    case 'search':
      return 'read_files';
    case 'fetch':
      return 'fetch_web';
    default:
      return 'other';
  }
}
const UNSAFE_APPROVAL_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- strips controls and invisible Unicode from agent text
  /[\x00-\x1f\x7f-\x9f\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/gu;
function approvalTitle(value: unknown, action: ApprovalAction): string {
  const clean =
    typeof value === 'string'
      ? value.replace(UNSAFE_APPROVAL_CHARS, ' ').replace(/\s+/gu, ' ').trim()
      : '';
  const chars = Array.from(clean || APPROVAL_FALLBACK[action]);
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('');
}

export class AcpAdapter implements LocalAgentAdapter {
  private child: ChildLike | null = null;
  private starting: Promise<string> | null = null;
  private sessionId: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private turn: Turn | null = null;
  private closed = false;
  private approval: { id: string; finish: (decision: 'approve' | 'deny') => void } | null = null;
  /** The agent refused to load the session to resume: later starts open new sessions. */
  private resumeFailed = false;
  private newSession = false;
  /** The session that has been given the preamble. */
  private preambleSession: string | null = null;
  private promptCapabilities: { image: boolean; embeddedContext: boolean } = {
    image: false,
    embeddedContext: false,
  };

  constructor(private readonly options: AcpOptions) {}

  supportsInlineImages(): boolean {
    return this.promptCapabilities.image;
  }

  sessionRef(): string | undefined {
    return this.sessionId ?? undefined;
  }

  takeNewSession(): boolean {
    const value = this.newSession;
    this.newSession = false;
    return value;
  }

  async *sendTurn(
    text: string,
    signal: AbortSignal,
    options?: { surface?: 'call' | 'text'; files?: LocalFile[] },
  ): AsyncIterable<LocalAgentEvent> {
    if (this.turn !== null) throw new Error('a turn is already running');
    const sessionId = await this.ensureSession();
    if (signal.aborted) return;
    const turn: Turn = {
      queue: new EventQueue(),
      openTools: new Set(),
      cancelling: false,
      surface: options?.surface ?? 'call',
      imageCount: 0,
    };
    this.turn = turn;
    const onAbort = () => this.cancel(turn, sessionId);
    signal.addEventListener('abort', onAbort, { once: true });
    const { preamble } = this.options;
    let prompt = text;
    if (preamble !== undefined && this.preambleSession !== sessionId) {
      this.preambleSession = sessionId;
      prompt = withPreamble(preamble, text);
    }
    const blocks: Record<string, unknown>[] = [];
    const paths: LocalFile[] = [];
    try {
      for (const file of options?.files ?? []) {
        if (file.mimeType.startsWith('image/') && this.promptCapabilities.image) {
          blocks.push({
            type: 'image',
            mimeType: file.mimeType,
            data: (await readFile(file.path)).toString('base64'),
          });
        } else if (this.promptCapabilities.embeddedContext && file.mimeType === 'application/pdf') {
          blocks.push({
            type: 'resource',
            resource: {
              uri: pathToFileURL(file.path).href,
              mimeType: file.mimeType,
              blob: (await readFile(file.path)).toString('base64'),
            },
          });
        } else if (
          (this.promptCapabilities.embeddedContext && file.mimeType.startsWith('text/')) ||
          (this.promptCapabilities.embeddedContext && file.mimeType === 'application/json')
        ) {
          blocks.push({
            type: 'resource',
            resource: {
              uri: pathToFileURL(file.path).href,
              mimeType: file.mimeType,
              text: await readFile(file.path, 'utf8'),
            },
          });
        } else paths.push(file);
      }
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      if (this.turn === turn) this.turn = null;
      throw error;
    }
    this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: withFilePaths(prompt, paths) }, ...blocks],
    }).then(
      (result) => {
        const stop = isRecord(result) ? result.stopReason : undefined;
        this.finish(
          turn,
          stop === 'refusal' && !turn.cancelling
            ? new LocalAgentError('agent_refused', 'The agent refused the request')
            : undefined,
        );
      },
      (error: Error) => this.finish(turn, turn.cancelling ? undefined : error),
    );
    try {
      yield* turn.queue;
    } finally {
      signal.removeEventListener('abort', onAbort);
      clearTimeout(turn.cancelTimer);
      if (this.turn === turn) this.turn = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.approval?.finish('deny');
    this.turn?.queue.end();
    this.failPending(new LocalAgentError('closed', 'agent closed'));
    const child = this.child;
    this.child = null;
    child?.killTree();
  }

  private ensureSession(): Promise<string> {
    if (this.closed) return Promise.reject(new LocalAgentError('closed', 'agent closed'));
    if (this.sessionId !== null && this.child !== null) return Promise.resolve(this.sessionId);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<string> {
    const child = this.options.spawn({
      command: this.options.command,
      args: this.options.args,
      cwd: this.options.cwd,
      ...(this.options.env !== undefined && { env: this.options.env }),
    });
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    // Some agents log plain text to stdout; anything that is not a JSON object is skipped.
    readLines(
      child.stdout,
      (line) => {
        if (this.child !== child) return;
        const message = parseJsonLine(line);
        if (message !== undefined) this.onMessage(child, message);
      },
      () => {
        if (this.child !== child) return;
        // A message was lost, so the session can no longer be followed: fail and restart it.
        this.child = null;
        this.sessionId = null;
        this.failPending(lineTooLongError());
        child.killTree();
      },
    );
    const onGone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.sessionId = null;
      this.failPending(new LocalAgentError('agent_failed', 'The agent exited'));
    };
    child.once('error', onGone);
    child.once('exit', onGone);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new LocalAgentError('agent_unavailable', 'The agent did not start in time')),
        this.options.startTimeoutMs ?? 30_000,
      ).unref(),
    );
    try {
      const init = await Promise.race([
        this.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        timeout,
      ]);
      const version = isRecord(init) ? init.protocolVersion : undefined;
      if (version !== ACP_PROTOCOL_VERSION) {
        throw new LocalAgentError('protocol_unsupported', 'The agent speaks another ACP version');
      }
      const capabilities =
        isRecord(init) &&
        isRecord(init.agentCapabilities) &&
        isRecord(init.agentCapabilities.promptCapabilities)
          ? init.agentCapabilities.promptCapabilities
          : {};
      this.promptCapabilities = {
        image: capabilities.image === true,
        embeddedContext: capabilities.embeddedContext === true,
      };
      const loaded = await this.loadSession(init, timeout);
      if (loaded !== undefined) {
        this.sessionId = loaded;
        return loaded;
      }
      const session = await Promise.race([
        this.request('session/new', { cwd: this.options.cwd, mcpServers: [] }),
        timeout,
      ]);
      const sessionId = isRecord(session) ? session.sessionId : undefined;
      if (typeof sessionId !== 'string') {
        throw new LocalAgentError('protocol_violation', 'The agent did not open a session');
      }
      this.sessionId = sessionId;
      if (this.options.resume !== undefined) this.newSession = true;
      return sessionId;
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        child.killTree();
      }
      throw error;
    }
  }

  /**
   * Loads the session to resume when the agent supports it. Undefined means start a new one: no
   * session to resume, no `loadSession` capability, or the agent refused it (it is not tried
   * again after a refusal).
   */
  private async loadSession(init: unknown, timeout: Promise<never>): Promise<string | undefined> {
    const sessionId = this.options.resume;
    if (sessionId === undefined || this.resumeFailed) return undefined;
    const capabilities =
      isRecord(init) && isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    if (capabilities.loadSession !== true) return undefined;
    try {
      await Promise.race([
        this.request('session/load', { sessionId, cwd: this.options.cwd, mcpServers: [] }),
        timeout,
      ]);
      return sessionId;
    } catch (error) {
      if (this.child === null) throw error;
      this.resumeFailed = true;
      return undefined;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (child === null) return Promise.reject(new LocalAgentError('agent_failed', 'not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeJsonLine(child, { jsonrpc: '2.0', id, method, params });
    });
  }

  private cancel(turn: Turn, sessionId: string): void {
    if (turn.cancelling || turn.queue.isEnded) return;
    turn.cancelling = true;
    this.approval?.finish('deny');
    if (this.child !== null) {
      writeJsonLine(this.child, {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId },
      });
    }
    // The agent should answer the prompt with stopReason "cancelled"; don't wait forever.
    turn.cancelTimer = setTimeout(() => this.finish(turn), this.options.cancelTimeoutMs ?? 5_000);
  }

  private finish(turn: Turn, error?: Error): void {
    this.approval?.finish('deny');
    clearTimeout(turn.cancelTimer);
    for (const id of turn.openTools) turn.queue.push({ type: 'tool.end', id, status: 'cancelled' });
    turn.openTools.clear();
    turn.queue.end(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private onMessage(child: ChildLike, message: Record<string, unknown>): void {
    const { id, method } = message;
    // A response to one of our requests.
    if (typeof id === 'number' && method === undefined) {
      const pending = this.pending.get(id);
      if (pending === undefined) return;
      this.pending.delete(id);
      if (isRecord(message.error))
        pending.reject(new LocalAgentError('agent_failed', 'The agent returned an error'));
      else pending.resolve(message.result);
      return;
    }
    if (typeof method !== 'string') return;
    const params = isRecord(message.params) ? message.params : {};
    // A request from the agent: only permission is supported; it is decided here, never run here.
    if (id !== undefined) {
      if (method === 'session/request_permission') {
        this.onPermission(child, id, params);
      } else {
        writeJsonLine(child, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not supported by Twring' },
        });
      }
      return;
    }
    if (method === 'session/update' && params.sessionId === this.sessionId) {
      this.onUpdate(isRecord(params.update) ? params.update : {});
    }
  }

  decide(id: string, decision: 'approve' | 'deny'): void {
    if (this.approval?.id === id) this.approval.finish(decision);
  }

  private onPermission(child: ChildLike, id: unknown, params: Record<string, unknown>): void {
    const reply = (outcome: Record<string, unknown>) =>
      writeJsonLine(child, { jsonrpc: '2.0', id, result: { outcome } });
    const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other';
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(String(o.kind)));
    const outcome = (decision: 'approve' | 'deny') => {
      const choice =
        decision === 'approve' ? pick(['allow_once']) : pick(['reject_once', 'reject_always']);
      return choice !== undefined && typeof choice.optionId === 'string'
        ? { outcome: 'selected', optionId: choice.optionId }
        : { outcome: 'cancelled' };
    };
    const turn = this.turn;
    if (turn === null || turn.cancelling || turn.queue.isEnded || this.closed) {
      reply(outcome('deny'));
      return;
    }
    if ((this.options.allowKinds ?? []).includes(kind)) {
      reply(outcome('approve'));
      return;
    }
    if (this.approval !== null) {
      reply(outcome('deny'));
      return;
    }
    const action = approvalAction(kind);
    const approval = approvalId();
    const timer = setTimeout(
      () => finish('deny'),
      turn.surface === 'text' ? APPROVAL_HOLD_MS + 5_000 : ACP_APPROVAL_TIMEOUT_MS,
    );
    const finish = (decision: 'approve' | 'deny') => {
      if (this.approval?.id !== approval) return;
      clearTimeout(timer);
      this.approval = null;
      reply(outcome(decision));
    };
    this.approval = { id: approval, finish };
    turn.queue.push({
      type: 'approval.required',
      id: approval,
      action,
      title: approvalTitle(toolCall.title, action),
    });
  }

  private onUpdate(update: Record<string, unknown>): void {
    const turn = this.turn;
    if (turn === null || turn.cancelling) return;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = isRecord(update.content) ? update.content : {};
        if (content.type === 'text' && typeof content.text === 'string' && content.text !== '')
          turn.queue.push({ type: 'text', text: content.text });
        if (content.type === 'image' && typeof content.data === 'string' && turn.imageCount < 5) {
          const kinds = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
          } as const;
          const mimeType = content.mimeType;
          if (mimeType !== 'image/jpeg' && mimeType !== 'image/png' && mimeType !== 'image/webp')
            return;
          // Reject malformed and oversized base64 before it can enter the event queue.
          if (
            content.data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(content.data)
          )
            return;
          const data = Buffer.from(content.data, 'base64');
          if (data.length === 0 || data.length > MAX_FILE_BYTES) return;
          turn.imageCount++;
          turn.queue.push({
            type: 'file',
            name: `image-${turn.imageCount}.${kinds[mimeType]}`,
            mimeType,
            data,
          });
        }
        return;
      }
      case 'tool_call': {
        const id = update.toolCallId;
        if (typeof id !== 'string') return;
        const title = typeof update.title === 'string' ? update.title : 'Working';
        const kind = typeof update.kind === 'string' ? update.kind : 'other';
        turn.openTools.add(id);
        turn.queue.push({
          type: 'tool.start',
          id,
          name: kind.slice(0, 128),
          label: kindLabel(kind, title),
        });
        this.maybeEndTool(turn, id, update.status);
        return;
      }
      case 'tool_call_update': {
        const id = update.toolCallId;
        if (typeof id === 'string') this.maybeEndTool(turn, id, update.status);
        return;
      }
      default:
        // Thoughts, plans, and mode changes are the agent's own business; nothing is spoken.
        return;
    }
  }

  private maybeEndTool(turn: Turn, id: string, status: unknown): void {
    if (!turn.openTools.has(id)) return;
    const mapped =
      status === 'completed'
        ? 'success'
        : status === 'failed'
          ? 'error'
          : status === 'cancelled'
            ? 'cancelled'
            : undefined;
    if (mapped === undefined) return;
    turn.openTools.delete(id);
    turn.queue.push({ type: 'tool.end', id, status: mapped });
  }
}

/** A short, generic label: tool titles can carry file paths or commands, which are not spoken. */
function kindLabel(kind: string, _title: string): string {
  switch (kind) {
    case 'read':
    case 'search':
      return 'Looking through files';
    case 'fetch':
      return 'Reading a web page';
    case 'edit':
    case 'delete':
    case 'move':
      return 'Editing files';
    case 'execute':
      return 'Running a command';
    case 'think':
      return 'Thinking';
    default:
      return 'Working';
  }
}
