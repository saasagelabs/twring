import http from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';

import {
  MAX_AGENT_DELTA_CHARS,
  MAX_REST_RESPONSE_BYTES,
  MAX_SSE_EVENT_BYTES,
  openAiChatEndpoint,
  type AdapterCapabilities,
  type AgentEvent,
  type UserTurn,
} from '@twring/contracts';

import type { AgentConnectionContext, TwringAgentAdapter } from './adapter';
import type { ResolvedAddress } from './endpoint-guard';
import { AdapterError } from './errors';
import { pinnedLookup } from './native-adapter';
import { AgentStreamGuard, MAX_TEXT_TURN_TEXT_CHARS } from './stream-guard';
import { SseParser, type SseEvent } from './sse-parser';

export interface OpenAiChatOptions {
  url: string;
  token?: string;
  model?: string;
  sessionKey: string;
  pinnedAddress?: ResolvedAddress;
  timeouts?: { connectMs?: number; idleMs?: number };
}

const violation = () => new AdapterError('protocol_violation', { retryable: false });
const instructions = (surface: UserTurn['surface']) =>
  surface === 'text'
    ? 'This message is from Twring chat. Reply in text. You remain responsible for your own tools and actions.'
    : 'This is a live Twring voice call. Reply conversationally and briefly. You remain responsible for your own tools and actions.';

function userContent(turn: UserTurn): string {
  const lines = (turn.attachments ?? []).map(
    (file) => `Attachment: ${file.name} (${file.mime_type}) ${file.url}`,
  );
  return [turn.text, ...lines].join('\n');
}

function contentOf(event: SseEvent): { done: true } | { done: false; content: string } {
  if (event.data === '[DONE]') return { done: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    throw violation();
  }
  if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed)) throw violation();
  const choices = parsed.choices;
  if (!Array.isArray(choices) || typeof choices[0] !== 'object' || choices[0] === null)
    throw violation();
  const delta: unknown = (choices[0] as { delta?: unknown }).delta;
  if (typeof delta !== 'object' || delta === null) throw violation();
  const content: unknown = (delta as { content?: unknown }).content;
  if (content === undefined || content === null) return { done: false, content: '' };
  if (typeof content !== 'string') throw violation();
  return { done: false, content };
}

/** One OpenAI chat completion per turn. The remote agent owns history keyed by `user`. */
export class OpenAiChatAdapter implements TwringAgentAdapter {
  readonly name = 'openai-chat';
  readonly capabilities: AdapterCapabilities = {
    streamingText: true,
    cancellation: true,
    resumableStream: false,
    activityEvents: false,
    toolEvents: false,
    approvals: false,
    conversationResume: false,
    serverInitiatedCalls: false,
  };
  private readonly endpoint: URL;
  private context: AgentConnectionContext | undefined;
  private closed = false;
  private readonly requests = new Set<http.ClientRequest>();

  constructor(private readonly options: OpenAiChatOptions) {
    try {
      this.endpoint = new URL(openAiChatEndpoint(options.url));
    } catch {
      throw new AdapterError('endpoint_rejected', { retryable: false });
    }
  }

  connect(context: AgentConnectionContext, signal: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new AdapterError('not_connected'));
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    this.context = context;
    return Promise.resolve();
  }

  async *sendTurn(turn: UserTurn, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.closed || this.context === undefined) throw new AdapterError('not_connected');
    if (signal.aborted) return;
    const body = JSON.stringify({
      model: this.options.model ?? 'default',
      stream: true,
      user: this.options.sessionKey,
      messages: [
        { role: 'system', content: instructions(turn.surface) },
        { role: 'user', content: userContent(turn) },
      ],
    });
    const queue: Array<
      | { kind: 'delta'; text: string }
      | { kind: 'end' }
      | { kind: 'aborted' }
      | { kind: 'error'; error: AdapterError }
    > = [];
    let wake: (() => void) | undefined;
    const push = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
      wake = undefined;
    };
    const request = (this.endpoint.protocol === 'https:' ? https : http).request(this.endpoint, {
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': String(Buffer.byteLength(body)),
        ...(this.options.token !== undefined && { Authorization: `Bearer ${this.options.token}` }),
      },
      ...(this.options.pinnedAddress && { lookup: pinnedLookup(this.options.pinnedAddress) }),
    });
    this.requests.add(request);
    let finished = false;
    let responded = false;
    // The callback runs later, after `fail` below is defined.
    const connectTimer = setTimeout(
      () => fail(new AdapterError('timeout')),
      this.options.timeouts?.connectMs ?? 10_000,
    );
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
    };
    const fail = (error: AdapterError) => {
      if (finished) return;
      finished = true;
      clear();
      request.destroy();
      push({ kind: 'error', error });
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fail(new AdapterError('timeout')),
        this.options.timeouts?.idleMs ?? 30_000,
      );
    };
    request.on('socket', (socket: Socket) => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else
        socket.once(this.endpoint.protocol === 'https:' ? 'secureConnect' : 'connect', () =>
          clearTimeout(connectTimer),
        );
    });
    request.on('response', (response) => {
      responded = true;
      clearTimeout(connectTimer);
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        fail(
          status === 401 || status === 403
            ? new AdapterError('auth_failed', { retryable: false, httpStatus: status })
            : new AdapterError('agent_error', { httpStatus: status }),
        );
        return;
      }
      if (
        (response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !==
        'text/event-stream'
      ) {
        fail(violation());
        return;
      }
      const parser = new SseParser({ maxEventBytes: MAX_SSE_EVENT_BYTES });
      let bytes = 0;
      let sawEvent = false;
      const deliver = (events: SseEvent[]) => {
        for (const event of events) {
          sawEvent = true;
          const result = contentOf(event);
          if (result.done) {
            finished = true;
            clear();
            push({ kind: 'end' });
            request.destroy();
            return;
          }
          if (result.content) push({ kind: 'delta', text: result.content });
        }
      };
      armIdle();
      response.on('data', (chunk: Buffer) => {
        if (finished) return;
        try {
          bytes += chunk.byteLength;
          if (bytes > MAX_REST_RESPONSE_BYTES) throw violation();
          armIdle();
          deliver(parser.push(chunk));
        } catch {
          fail(violation());
        }
      });
      response.on('end', () => {
        if (finished) return;
        try {
          deliver(parser.end());
          if (parser.truncated) throw violation();
          if (!sawEvent) throw violation();
          finished = true;
          clear();
          push({ kind: 'end' });
        } catch {
          fail(violation());
        }
      });
      response.on('close', () => {
        if (!finished) fail(new AdapterError('connection_lost'));
      });
    });
    request.on('error', () => {
      if (!finished) fail(new AdapterError(responded ? 'connection_lost' : 'connection_failed'));
    });
    const onAbort = () => {
      finished = true;
      clear();
      request.destroy();
      push({ kind: 'aborted' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.end(body);
    const guard = new AgentStreamGuard(
      turn.turnId,
      turn.surface === 'text' ? MAX_TEXT_TURN_TEXT_CHARS : undefined,
    );
    const messageId = `msg_${turn.turnId}`;
    let seq = 0;
    const next = () => ({ turn_id: turn.turnId, event_id: `openai_${++seq}`, seq });
    try {
      let started = false;
      for (;;) {
        if (queue.length === 0)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const item = queue.shift();
        if (item === undefined) continue;
        if (item.kind === 'error') throw item.error;
        if (item.kind === 'aborted') return;
        if (item.kind === 'end') {
          if (started) yield { ...next(), type: 'text.end', message_id: messageId };
          yield { ...next(), type: 'done', status: 'completed' };
          return;
        }
        if (!started) {
          started = true;
          yield { ...next(), type: 'text.start', message_id: messageId };
        }
        for (let from = 0; from < item.text.length; from += MAX_AGENT_DELTA_CHARS) {
          const part = item.text.slice(from, from + MAX_AGENT_DELTA_CHARS);
          const result = guard.accept({
            ...next(),
            type: 'text.delta',
            message_id: messageId,
            delta: part,
          });
          if (result.kind === 'violation') throw violation();
          if (result.kind === 'event') yield result.event;
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      clear();
      request.destroy();
      this.requests.delete(request);
    }
  }

  close(): Promise<void> {
    this.closed = true;
    for (const request of this.requests) request.destroy();
    return Promise.resolve();
  }
}
