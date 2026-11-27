import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectThreadSocket } from './socket';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    readonly url: string,
    _protocols?: string | string[] | null,
    readonly options?: { headers: Record<string, string> },
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  end(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const timers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

describe('thread socket', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeSocket.instances = [];
  });
  it('uses fresh headers, resends focus, ignores invalid frames, and backs off', async () => {
    vi.useFakeTimers();
    let token = 'one';
    const onFrame = vi.fn();
    const socket = connectThreadSocket({
      url: 'https://api.example.com/',
      headers: () => ({ authorization: token }),
      onFrame,
      onState: () => undefined,
      timers,
      WebSocketImpl: FakeSocket,
    });
    const first = FakeSocket.instances[0];
    expect(first.url).toBe('wss://api.example.com/v1/me/socket');
    socket.setFocus('agt_abcdefghij0123456789');
    first.open();
    first.onmessage?.({ data: '{"type":"unknown"}' });
    expect(onFrame).not.toHaveBeenCalled();
    first.end(1006);
    token = 'two';
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const second = FakeSocket.instances[1];
    expect(second.options?.headers.authorization).toBe('two');
    second.open();
    expect(second.sent).toEqual(first.sent);
    second.end(4401);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.instances).toHaveLength(3);
    FakeSocket.instances[2].open();
    await vi.advanceTimersByTimeAsync(60_000);
    FakeSocket.instances[2].end(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(4);
    socket.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('after 4409 tries once slowly, then waits for reconnect(), so devices never loop', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({}),
      onFrame: () => undefined,
      onState: (state) => states.push(state),
      timers,
      WebSocketImpl: FakeSocket,
    });
    FakeSocket.instances[0].end(4409);
    expect(states).toEqual(['stopped']);
    expect(socket.stopped()).toBe(true);
    // Nothing for 45 s, then one try.
    await vi.advanceTimersByTimeAsync(44_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(FakeSocket.instances).toHaveLength(2);
    // Pushed out again within 10 minutes: no more tries until the app is in front again.
    FakeSocket.instances[1].end(4409);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    socket.reconnect();
    expect(FakeSocket.instances).toHaveLength(3);
    expect(socket.stopped()).toBe(false);
    socket.close();
  });
  it('refreshes the token after a 401 and retries with backoff', async () => {
    vi.useFakeTimers();
    let token = 'old';
    const refreshAuth = vi.fn(() => {
      token = 'new';
      return Promise.resolve();
    });
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({ authorization: token }),
      refreshAuth,
      onFrame: () => undefined,
      onState: () => undefined,
      timers,
      WebSocketImpl: FakeSocket,
    });
    const first = FakeSocket.instances[0];
    first.onerror?.({ status: 401 });
    first.end(1006);
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1].options?.headers.authorization).toBe('new');
    // A second 401 backs off further instead of retrying at once.
    FakeSocket.instances[1].onerror?.({ message: 'Expected HTTP 101 response but was 401' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);
    socket.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reconnects a stopped socket but never opens a second one', () => {
    const states: string[] = [];
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({}),
      onFrame: () => undefined,
      onState: (state) => states.push(state),
      timers,
      WebSocketImpl: FakeSocket,
    });
    expect(socket.stopped()).toBe(false);
    FakeSocket.instances[0].end(4403);
    expect(socket.stopped()).toBe(true);
    socket.reconnect();
    expect(socket.stopped()).toBe(false);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[0].readyState).toBe(3);
    socket.close();
    expect(socket.stopped()).toBe(true);
  });
  it.each([4403])('stops on %i until reconnect is requested', async (code) => {
    vi.useFakeTimers();
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({}),
      onFrame: () => undefined,
      onState: () => undefined,
      timers,
      WebSocketImpl: FakeSocket,
    });
    FakeSocket.instances[0].end(code);
    await vi.runAllTimersAsync();
    expect(FakeSocket.instances).toHaveLength(1);
    socket.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
    socket.close();
  });
  it('retryNow skips a long backoff wait at once', async () => {
    vi.useFakeTimers();
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({}),
      onFrame: () => undefined,
      onState: () => undefined,
      timers,
      WebSocketImpl: FakeSocket,
    });
    for (let i = 0; i < 5; i++) {
      FakeSocket.instances.at(-1)?.end(1006);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    FakeSocket.instances.at(-1)?.end(1006);
    expect(FakeSocket.instances).toHaveLength(6);
    expect(vi.getTimerCount()).toBe(1);
    socket.retryNow();
    expect(FakeSocket.instances).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
    // Debounced: a second call within 1 s does nothing.
    FakeSocket.instances[6].end(1006);
    socket.retryNow();
    expect(FakeSocket.instances).toHaveLength(7);
    // The backoff starts again from 1 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(8);
    socket.close();
  });
  it('retryNow leaves a blocked, closed or open socket alone', () => {
    vi.useFakeTimers();
    const make = () =>
      connectThreadSocket({
        url: 'http://localhost:3000',
        requireSecureMedia: false,
        headers: () => ({}),
        onFrame: () => undefined,
        onState: () => undefined,
        timers,
        WebSocketImpl: FakeSocket,
      });
    const open = make();
    FakeSocket.instances[0].open();
    open.retryNow();
    expect(FakeSocket.instances).toHaveLength(1);
    open.close();
    open.retryNow({ networkChanged: true });
    expect(FakeSocket.instances).toHaveLength(1);
    const evicted = make();
    FakeSocket.instances[1].end(4409);
    evicted.retryNow({ networkChanged: true });
    expect(FakeSocket.instances).toHaveLength(2);
    expect(evicted.stopped()).toBe(true);
    evicted.close();
  });
  it.each([0, 1])(
    'retryNow on a network change replaces a socket in state %i once',
    async (ready) => {
      vi.useFakeTimers();
      const states: string[] = [];
      const socket = connectThreadSocket({
        url: 'http://localhost:3000',
        requireSecureMedia: false,
        headers: () => ({}),
        onFrame: () => undefined,
        onState: (state) => states.push(state),
        timers,
        WebSocketImpl: FakeSocket,
      });
      const old = FakeSocket.instances[0];
      if (ready === 1) old.open();
      socket.retryNow({ networkChanged: true });
      socket.retryNow({ networkChanged: true });
      expect(FakeSocket.instances).toHaveLength(2);
      expect(old.readyState).toBe(3);
      // The old socket's late close is ignored: no retry, no state change.
      const before = [...states];
      old.onclose?.({ code: 1006 });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(states).toEqual(before);
      socket.close();
    },
  );
  it('retryNow during a token refresh waits for the new token', async () => {
    vi.useFakeTimers();
    let token = 'old';
    let finish = () => undefined as void;
    const refreshAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            token = 'new';
            resolve();
          };
        }),
    );
    const socket = connectThreadSocket({
      url: 'http://localhost:3000',
      requireSecureMedia: false,
      headers: () => ({ authorization: token }),
      refreshAuth,
      onFrame: () => undefined,
      onState: () => undefined,
      timers,
      WebSocketImpl: FakeSocket,
    });
    FakeSocket.instances[0].onerror?.({ status: 401 });
    socket.retryNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(FakeSocket.instances).toHaveLength(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(FakeSocket.instances[1].options?.headers.authorization).toBe('new');
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    socket.close();
  });
});
