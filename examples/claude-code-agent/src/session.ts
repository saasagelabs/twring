import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import type { AgentEvent } from '@twring/contracts';

import type { ClaudeChild, SpawnClaude } from './claude-command';
import { isRecord, TurnMapper } from './mapper';

export interface ClaudeSessionOptions {
  spawnClaude: SpawnClaude;
  /** Receives every AgentEvent for this session's turns, in order. */
  emit(event: AgentEvent): void;
  /** Timing-only log lines; never user or model text. */
  log?(line: string): void;
  /** Spawn → initialize response. */
  initTimeoutMs?: number;
  /** Interrupt → the interrupted turn's `result`; after this the process is replaced. */
  interruptTimeoutMs?: number;
  newEventId?: () => string;
}

interface PendingTurn {
  turnId: string;
  text: string;
}

interface ActiveTurn {
  turnId: string;
  mapper: TurnMapper;
  startedAt: number;
  sawText: boolean;
  cancelling: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
}

/**
 * One call's Claude Code process. The process is spawned once at `start()` (during the call
 * handshake), keeps the conversation across turns, runs one turn at a time, and is killed with its
 * whole process tree on `close()`. Cancels use the stream-json `interrupt` control request, which
 * keeps the process and its memory; if Claude does not wind the turn down in time the process is
 * replaced and conversation memory is lost.
 */
export class ClaudeSession {
  private child: ClaudeChild | null = null;
  private starting: Promise<void> | null = null;
  private pendingInit: { id: string; resolve(): void; reject(error: Error): void } | null = null;
  private active: ActiveTurn | null = null;
  private readonly queue: PendingTurn[] = [];
  private closed = false;
  private readonly initTimeoutMs: number;
  private readonly interruptTimeoutMs: number;

  constructor(private readonly options: ClaudeSessionOptions) {
    this.initTimeoutMs = options.initTimeoutMs ?? 30_000;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? 5_000;
  }

  /** Spawns Claude Code and resolves once it has answered the initialize control request. */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('session closed'));
    if (this.child !== null && this.starting === null) return Promise.resolve();
    this.starting ??= this.spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  userTurn(turnId: string, text: string): void {
    if (this.closed) return;
    this.queue.push({ turnId, text });
    this.pump();
  }

  cancel(turnId: string): void {
    const queued = this.queue.findIndex((t) => t.turnId === turnId);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.emitAll(new TurnMapper({ turnId, newEventId: this.options.newEventId }).cancel());
      return;
    }
    const active = this.active;
    if (active === null || active.turnId !== turnId || active.cancelling) return;
    active.cancelling = true;
    this.write({
      type: 'control_request',
      request_id: `int_${randomUUID()}`,
      request: { subtype: 'interrupt' },
    });
    active.interruptTimer = setTimeout(() => {
      if (this.active !== active) return;
      this.options.log?.('interrupt timed out; replacing the Claude process (memory lost)');
      this.emitAll(active.mapper.cancel());
      this.killChild();
      this.finishTurn();
    }, this.interruptTimeoutMs);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    if (this.active !== null) {
      clearTimeout(this.active.interruptTimer);
      this.active = null;
    }
    this.killChild();
  }

  private async spawn(): Promise<void> {
    const t0 = Date.now();
    const child = this.options.spawnClaude();
    this.child = child;
    child.stdin.on('error', () => undefined);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (this.child !== child) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      this.onMessage(parsed);
    });
    child.once('error', () => this.onExit(child));
    child.once('exit', () => this.onExit(child));

    const id = `init_${randomUUID()}`;
    const ready = new Promise<void>((resolve, reject) => {
      this.pendingInit = { id, resolve, reject };
    });
    this.write({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } });
    const timer = setTimeout(
      () => this.pendingInit?.reject(new Error('Claude Code did not initialize in time')),
      this.initTimeoutMs,
    );
    try {
      await ready;
      this.options.log?.(`claude ready: spawn→init ${Date.now() - t0} ms`);
    } catch (error) {
      if (this.child === child) this.killChild();
      throw error;
    } finally {
      clearTimeout(timer);
      this.pendingInit = null;
    }
  }

  private onMessage(message: unknown) {
    if (!isRecord(message)) return;
    if (message.type === 'control_response') {
      const response = isRecord(message.response) ? message.response : {};
      if (this.pendingInit !== null && response.request_id === this.pendingInit.id) {
        if (response.subtype === 'success') this.pendingInit.resolve();
        else this.pendingInit.reject(new Error('Claude Code refused to initialize'));
      }
      return;
    }
    const active = this.active;
    if (active === null) return;
    if (active.cancelling) {
      // Nothing more is forwarded for an interrupted turn; its `result` closes it as cancelled.
      if (message.type === 'result') {
        this.emitAll(active.mapper.cancel());
        this.finishTurn();
      }
      return;
    }
    const events = active.mapper.map(message);
    if (!active.sawText && events.some((e) => e.type === 'text.delta')) {
      active.sawText = true;
      this.options.log?.(`turn first text ${Date.now() - active.startedAt} ms`);
    }
    this.emitAll(events);
    if (active.mapper.finished) this.finishTurn();
  }

  private onExit(child: ClaudeChild) {
    if (this.child !== child) return;
    this.child = null;
    this.pendingInit?.reject(new Error('Claude Code exited during startup'));
    const active = this.active;
    if (active !== null) {
      this.emitAll(
        active.cancelling ? active.mapper.cancel() : active.mapper.fail('claude_exited'),
      );
      this.finishTurn();
    }
  }

  private finishTurn() {
    const active = this.active;
    if (active === null) return;
    clearTimeout(active.interruptTimer);
    this.options.log?.(`turn done ${Date.now() - active.startedAt} ms`);
    this.active = null;
    this.pump();
  }

  private pump() {
    if (this.closed || this.active !== null || this.starting !== null) return;
    const next = this.queue[0];
    if (next === undefined) return;
    if (this.child === null) {
      // The previous process died or was replaced; a fresh one starts without memory.
      this.start().then(
        () => this.pump(),
        () => {
          const failed = this.queue.shift();
          if (failed !== undefined) {
            this.emitAll(
              new TurnMapper({
                turnId: failed.turnId,
                newEventId: this.options.newEventId,
              }).fail('claude_unavailable'),
            );
          }
          this.pump();
        },
      );
      return;
    }
    this.queue.shift();
    this.active = {
      turnId: next.turnId,
      mapper: new TurnMapper({ turnId: next.turnId, newEventId: this.options.newEventId }),
      startedAt: Date.now(),
      sawText: false,
      cancelling: false,
    };
    this.write({
      type: 'user',
      message: { role: 'user', content: next.text },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  private write(message: unknown) {
    const child = this.child;
    if (child === null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private killChild() {
    const child = this.child;
    this.child = null;
    child?.killTree();
  }

  private emitAll(events: AgentEvent[]) {
    for (const event of events) this.options.emit(event);
  }
}
