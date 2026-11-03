import { threadSocketFrameSchema, type ThreadSocketFrame } from '@twring/contracts';

import type { OutboxTimers } from './outbox';

type SocketState = 'connected' | 'disconnected' | 'stopped';
type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
type SocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> },
) => SocketLike;

export interface ThreadSocketOptions {
  url: string;
  headers: () => Record<string, string>;
  onFrame: (frame: ThreadSocketFrame) => void;
  onState: (state: SocketState) => void;
  requireSecureMedia?: boolean;
  timers?: Pick<OutboxTimers, 'setTimeout' | 'clearTimeout' | 'now'>;
  WebSocketImpl?: SocketConstructor;
}

export function connectThreadSocket(options: ThreadSocketOptions): {
  setFocus(agentId: string | null): void;
  reconnect(): void;
  close(): void;
} {
  const url = `${options.url.replace(/\/+$/, '').replace(/^http/, 'ws')}/v1/me/socket`;
  if ((options.requireSecureMedia ?? true) && !url.startsWith('wss://'))
    throw new Error('secure phone socket required');
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
  const WebSocketClass = options.WebSocketImpl ?? (WebSocket as unknown as SocketConstructor);
  let socket: SocketLike | undefined;
  let retryTimer: unknown;
  let resetTimer: unknown;
  let stopped = false;
  let blocked = false;
  let retryStep = 0;
  let focus: string | null = null;
  let generation = 0;
  const delays = [1_000, 2_000, 5_000, 10_000, 30_000];
  const clearTimers = () => {
    if (retryTimer !== undefined) timers.clearTimeout(retryTimer);
    if (resetTimer !== undefined) timers.clearTimeout(resetTimer);
    retryTimer = resetTimer = undefined;
  };
  const sendFocus = () => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ type: 'focus', agent_id: focus }));
  };
  const connect = () => {
    if (stopped || blocked) return;
    clearTimers();
    const current = ++generation;
    const ws = new WebSocketClass(url, null, { headers: options.headers() });
    socket = ws;
    ws.onopen = () => {
      if (current !== generation) return;
      options.onState('connected');
      sendFocus();
      resetTimer = timers.setTimeout(() => {
        retryStep = 0;
        resetTimer = undefined;
      }, 60_000);
    };
    ws.onmessage = (event) => {
      if (current !== generation) return;
      try {
        const parsed = threadSocketFrameSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) options.onFrame(parsed.data);
      } catch {
        /* Invalid frames are ignored. */
      }
    };
    ws.onerror = (event) => {
      if (current !== generation) return;
      const status =
        typeof event === 'object' && event !== null && 'status' in event ? event.status : undefined;
      const detail =
        typeof event === 'object' && event !== null && 'message' in event
          ? event.message
          : undefined;
      if (status === 401 || (typeof detail === 'string' && /\b401\b/.test(detail))) {
        blocked = true;
        clearTimers();
        options.onState('stopped');
        ws.close();
      }
    };
    ws.onclose = (event) => {
      if (current !== generation || stopped) return;
      clearTimers();
      socket = undefined;
      if (blocked || event.code === 4403 || event.code === 4409) {
        blocked = true;
        options.onState('stopped');
        return;
      }
      options.onState('disconnected');
      const delay = delays[Math.min(retryStep++, delays.length - 1)];
      retryTimer = timers.setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, delay);
    };
  };
  connect();
  return {
    setFocus(agentId) {
      focus = agentId;
      sendFocus();
    },
    reconnect() {
      if (stopped) return;
      blocked = false;
      retryStep = 0;
      clearTimers();
      generation++;
      socket?.close();
      connect();
    },
    close() {
      stopped = true;
      generation++;
      clearTimers();
      socket?.close();
      socket = undefined;
      options.onState('stopped');
    },
  };
}
