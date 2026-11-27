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
  /** Refreshes the access token after the server refused it; the retry waits for it. */
  refreshAuth?: () => Promise<unknown>;
  onFrame: (frame: ThreadSocketFrame) => void;
  onState: (state: SocketState) => void;
  requireSecureMedia?: boolean;
  timers?: Pick<OutboxTimers, 'setTimeout' | 'clearTimeout' | 'now'>;
  /** 0 to 1, for the backoff jitter; tests pass a fixed one. */
  random?: () => number;
  WebSocketImpl?: SocketConstructor;
}

/** After a 4409: one try 45 to 60 s later, again only once a socket stayed open 10 minutes. */
const EVICTION_RETRY_MS = 45_000;
const EVICTION_JITTER_MS = 15_000;
const EVICTION_SETTLED_MS = 10 * 60_000;

export function connectThreadSocket(options: ThreadSocketOptions): {
  setFocus(agentId: string | null): void;
  /** True after close() or a refusal (4403, 4409): only reconnect() opens it again. */
  stopped(): boolean;
  reconnect(): void;
  /**
   * Skips a backoff wait now (the app came to the front, or the network changed). With
   * networkChanged, a socket still connecting or open is replaced too: it may sit on the old network.
   */
  retryNow(options?: { networkChanged?: boolean }): void;
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
  let evictionRetried = false;
  let openedAt: number | undefined;
  let focus: string | null = null;
  let generation = 0;
  let refreshing: Promise<unknown> | undefined;
  let lastRetryNow: number | undefined;
  let lastNetworkRetry: number | undefined;
  const random = options.random ?? Math.random;
  const delays = [1_000, 2_000, 5_000, 10_000];
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
    openedAt = undefined;
    const ws = new WebSocketClass(url, null, { headers: options.headers() });
    socket = ws;
    ws.onopen = () => {
      if (current !== generation) return;
      openedAt = timers.now();
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
        // The token was refused (often a stale one after a long background): refresh, then retry.
        generation++;
        socket = undefined;
        ws.close();
        const pending = options.refreshAuth?.().catch(() => undefined);
        refreshing = pending;
        void pending?.then(() => {
          if (refreshing === pending) refreshing = undefined;
        });
        retryLater(pending);
      }
    };
    ws.onclose = (event) => {
      if (current !== generation || stopped) return;
      socket = undefined;
      // "Account data deleted" (4403) and "a newer socket took this one's place" (4409) wait for
      // reconnect(), which the app calls when it comes back to the front. Retrying a 4409 at once
      // would push out another device, which then does the same, round and round.
      if (event.code === 4403 || event.code === 4409) {
        clearTimers();
        blocked = true;
        options.onState('stopped');
        // One slow try after a 4409, so a phone left open gets back in once a dead socket has aged
        // out. A device pushed out again before it stayed 10 minutes waits for reconnect().
        const settled = openedAt !== undefined && timers.now() - openedAt >= EVICTION_SETTLED_MS;
        if (event.code === 4409 && (!evictionRetried || settled)) {
          evictionRetried = true;
          retryTimer = timers.setTimeout(
            () => {
              retryTimer = undefined;
              if (stopped || !blocked) return;
              blocked = false;
              connect();
            },
            EVICTION_RETRY_MS + Math.floor(random() * EVICTION_JITTER_MS),
          );
        }
        return;
      }
      retryLater();
    };
  };
  const retryLater = (before?: Promise<unknown>) => {
    clearTimers();
    options.onState('disconnected');
    const scheduled = generation;
    // +-20% so phones that lost the same network do not all come back in the same instant.
    const base = delays[Math.min(retryStep++, delays.length - 1)];
    const delay = Math.round(base * (0.8 + 0.4 * random()));
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      void Promise.resolve(before).then(() => {
        if (scheduled === generation) connect();
      });
    }, delay);
  };
  connect();
  return {
    stopped() {
      return stopped || blocked;
    },
    setFocus(agentId) {
      focus = agentId;
      sendFocus();
    },
    reconnect() {
      if (stopped) return;
      blocked = false;
      retryStep = 0;
      evictionRetried = false;
      clearTimers();
      generation++;
      socket?.close();
      connect();
    },
    retryNow({ networkChanged = false } = {}) {
      if (stopped || blocked) return;
      if (socket && !networkChanged) return;
      // Separate debounces: a foreground retry just before must not swallow a network change.
      const now = timers.now();
      const last = networkChanged ? lastNetworkRetry : lastRetryNow;
      if (last !== undefined && now - last < 1_000) return;
      if (networkChanged) lastNetworkRetry = now;
      else lastRetryNow = now;
      retryStep = 0;
      if (socket) {
        // Replaced, not reconnect(): the 4409 guard (evictionRetried, blocked) stays as it is.
        generation++;
        const old = socket;
        socket = undefined;
        old.close();
        // An open one was reported connected: the UI shows it reconnecting until the new one opens.
        if (openedAt !== undefined) options.onState('disconnected');
        connect();
        return;
      }
      const pending = refreshing;
      if (pending) {
        // Waits for the new token instead of being refused again with the stale one.
        clearTimers();
        const scheduled = generation;
        void pending.then(() => {
          if (scheduled === generation) connect();
        });
        return;
      }
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
