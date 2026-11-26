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
  it('retries after 4409 with the normal backoff', async () => {
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
    expect(states).toEqual(['disconnected']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
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
});
