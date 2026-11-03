import { randomUUID } from 'node:crypto';

import { MAX_AGENT_DELTA_CHARS, type AgentEvent } from '@twring/contracts';

/** Voice labels for the tools this agent allows; anything else reads as generic work. */
export function toolDisplayLabel(toolName: string): string {
  switch (toolName) {
    case 'WebSearch':
      return 'Searching the web…';
    case 'WebFetch':
      return 'Reading a web page…';
    default:
      return 'Working…';
  }
}

export interface TurnMapperOptions {
  turnId: string;
  newEventId?: () => string;
}

type Block = { kind: 'text'; messageId: string } | { kind: 'tool' } | { kind: 'other' };

/**
 * Translates Claude Code `stream-json` stdout messages (with `--include-partial-messages`) into
 * Twring AgentEvents for one turn. Only text blocks are forwarded; thinking and tool input never are.
 * The turn ends at the `result` message, which `map` reports via `finished`.
 */
export class TurnMapper {
  private seq = 0;
  private started = false;
  private messageId = 'msg';
  private readonly blocks = new Map<number, Block>();
  private readonly openTools = new Set<string>();
  private readonly newEventId: () => string;
  finished = false;

  constructor(private readonly options: TurnMapperOptions) {
    this.newEventId = options.newEventId ?? (() => `evt_${randomUUID()}`);
  }

  /** Maps one parsed stdout message. Unknown or malformed shapes are ignored. */
  map(message: unknown): AgentEvent[] {
    if (this.finished || !isRecord(message)) return [];
    const out: AgentEvent[] = [];
    if (!this.started && message.type !== 'control_response') {
      this.started = true;
      out.push(this.event({ type: 'run.started' }));
    }
    switch (message.type) {
      case 'stream_event':
        if (isRecord(message.event) && message.parent_tool_use_id == null) {
          this.mapStreamEvent(message.event, out);
        }
        break;
      case 'user':
        this.mapToolResults(message, out);
        break;
      case 'result':
        this.finished = true;
        for (const id of this.openTools) {
          out.push(this.event({ type: 'tool.end', tool_call_id: id, status: 'cancelled' }));
        }
        this.openTools.clear();
        if (message.subtype === 'success' && message.is_error !== true) {
          out.push(this.event({ type: 'done', status: 'completed' }));
        } else {
          out.push(this.event({ type: 'error', code: 'claude_error', retryable: true }));
          out.push(this.event({ type: 'done', status: 'failed' }));
        }
        break;
      default:
        break;
    }
    return out;
  }

  /** Ends the turn as cancelled, closing any tool still running. */
  cancel(): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    const out: AgentEvent[] = [];
    for (const id of this.openTools) {
      out.push(this.event({ type: 'tool.end', tool_call_id: id, status: 'cancelled' }));
    }
    this.openTools.clear();
    out.push(this.event({ type: 'done', status: 'cancelled' }));
    return out;
  }

  /** Ends the turn as failed (the Claude process died or misbehaved). */
  fail(code: string): AgentEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return [
      this.event({ type: 'error', code, retryable: true }),
      this.event({ type: 'done', status: 'failed' }),
    ];
  }

  private mapStreamEvent(event: Record<string, unknown>, out: AgentEvent[]) {
    const index = typeof event.index === 'number' ? event.index : -1;
    switch (event.type) {
      case 'message_start':
        if (isRecord(event.message) && typeof event.message.id === 'string') {
          this.messageId = event.message.id.slice(0, 100);
        }
        this.blocks.clear();
        return;
      case 'content_block_start': {
        const block = isRecord(event.content_block) ? event.content_block : {};
        if (block.type === 'text') {
          const messageId = `${this.messageId}_${index}`;
          this.blocks.set(index, { kind: 'text', messageId });
          out.push(this.event({ type: 'text.start', message_id: messageId }));
          if (typeof block.text === 'string' && block.text !== '')
            this.pushText(messageId, block.text, out);
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name.slice(0, 128) : 'unknown';
          this.blocks.set(index, { kind: 'tool' });
          this.openTools.add(block.id);
          out.push(
            this.event({
              type: 'tool.start',
              tool_call_id: block.id,
              tool_name: name,
              display_label: toolDisplayLabel(name),
            }),
          );
        } else {
          this.blocks.set(index, { kind: 'other' });
        }
        return;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(index);
        const delta = isRecord(event.delta) ? event.delta : {};
        if (
          block?.kind === 'text' &&
          delta.type === 'text_delta' &&
          typeof delta.text === 'string'
        ) {
          this.pushText(block.messageId, delta.text, out);
        }
        return;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(index);
        if (block?.kind === 'text') {
          out.push(this.event({ type: 'text.end', message_id: block.messageId }));
        }
        return;
      }
      default:
        return;
    }
  }

  private mapToolResults(message: Record<string, unknown>, out: AgentEvent[]) {
    const inner = isRecord(message.message) ? message.message : {};
    if (!Array.isArray(inner.content)) return;
    for (const part of inner.content as unknown[]) {
      if (!isRecord(part) || part.type !== 'tool_result') continue;
      const id = part.tool_use_id;
      if (typeof id !== 'string' || !this.openTools.has(id)) continue;
      this.openTools.delete(id);
      out.push(
        this.event({
          type: 'tool.end',
          tool_call_id: id,
          status: part.is_error === true ? 'error' : 'success',
        }),
      );
    }
  }

  private pushText(messageId: string, text: string, out: AgentEvent[]) {
    for (let i = 0; i < text.length; i += MAX_AGENT_DELTA_CHARS) {
      out.push(
        this.event({
          type: 'text.delta',
          message_id: messageId,
          delta: text.slice(i, i + MAX_AGENT_DELTA_CHARS),
        }),
      );
    }
  }

  private event(fields: EventFields): AgentEvent {
    return {
      ...fields,
      event_id: this.newEventId(),
      turn_id: this.options.turnId,
      seq: this.seq++,
    };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventFields = DistributiveOmit<AgentEvent, 'event_id' | 'turn_id' | 'seq'>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
