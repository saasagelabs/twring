import type { ProviderSocket, SocketFactory } from './socket';
import {
  VoiceProviderError,
  type SttEvent,
  type SttProvider,
  type SttSession,
  type TtsEvent,
  type TtsProvider,
  type TtsSession,
  type VoiceError,
} from './types';

/** Scriptable in-memory socket for provider adapter tests. */
export class FakeSocket implements ProviderSocket {
  readonly sent: (string | Uint8Array)[] = [];
  readonly headers: Record<string, string>;
  pings = 0;
  closedWith: number | undefined;
  private open = false;
  private listeners = {
    open: [] as (() => void)[],
    message: [] as ((data: string | Uint8Array) => void)[],
    close: [] as ((code: number, reason: string) => void)[],
    error: [] as ((error: Error) => void)[],
  };

  constructor(
    readonly url: string,
    headers: Record<string, string>,
  ) {
    this.headers = headers;
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  ping(): void {
    this.pings += 1;
  }

  close(code = 1000): void {
    if (this.closedWith !== undefined) return;
    this.closedWith = code;
    this.open = false;
    for (const listener of this.listeners.close) listener(code, '');
  }

  onOpen(listener: () => void): void {
    this.listeners.open.push(listener);
  }

  onMessage(listener: (data: string | Uint8Array) => void): void {
    this.listeners.message.push(listener);
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.listeners.close.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.listeners.error.push(listener);
  }

  // Test controls.
  acceptConnection(): void {
    this.open = true;
    for (const listener of this.listeners.open) listener();
  }

  rejectConnection(message: string): void {
    for (const listener of this.listeners.error) listener(new Error(message));
    this.close(1006);
  }

  receive(data: string | object | Uint8Array): void {
    const payload =
      data instanceof Uint8Array || typeof data === 'string' ? data : JSON.stringify(data);
    for (const listener of this.listeners.message) listener(payload);
  }

  /** The provider closes the connection (not us). */
  drop(code: number): void {
    this.open = false;
    this.closedWith = code;
    for (const listener of this.listeners.close) listener(code, 'server text that must not leak');
  }

  jsonSent(): unknown[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d): unknown => JSON.parse(d));
  }

  binarySent(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
  }
}

/** Factory that records every socket it creates; `auto` accepts connections immediately. */
export function fakeSocketFactory(auto = true): SocketFactory & { sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory = (url: string, headers: Record<string, string>): FakeSocket => {
    const socket = new FakeSocket(url, headers);
    sockets.push(socket);
    if (auto) queueMicrotask(() => socket.acceptConnection());
    return socket;
  };
  return Object.assign(factory, { sockets });
}

/** In-memory STT provider: records audio sent, lets tests emit provider events. */
export class FakeSttProvider implements SttProvider {
  readonly name = 'fake-stt';
  opens = 0;
  failNextOpen: VoiceError | undefined;
  samplesReceived = 0;
  closed = 0;
  private emit: ((event: SttEvent) => void) | undefined;

  open(onEvent: (event: SttEvent) => void): Promise<SttSession> {
    this.opens += 1;
    if (this.failNextOpen !== undefined) {
      const error = this.failNextOpen;
      this.failNextOpen = undefined;
      return Promise.reject(new VoiceProviderError(error));
    }
    this.emit = onEvent;
    return Promise.resolve({
      sendAudio: (samples) => {
        this.samplesReceived += samples.length;
      },
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }

  send(event: SttEvent): void {
    this.emit?.(event);
  }
}

/** In-memory TTS provider: records calls, lets tests deliver audio/done/errors. */
export class FakeTtsProvider implements TtsProvider {
  readonly name = 'fake-tts';
  opens = 0;
  failNextOpen: VoiceError | undefined;
  readonly calls: string[] = [];
  closed = 0;
  private emit: ((event: TtsEvent) => void) | undefined;

  open(onEvent: (event: TtsEvent) => void): Promise<TtsSession> {
    this.opens += 1;
    if (this.failNextOpen !== undefined) {
      const error = this.failNextOpen;
      this.failNextOpen = undefined;
      return Promise.reject(new VoiceProviderError(error));
    }
    this.emit = onEvent;
    return Promise.resolve({
      speak: (id, text) => this.calls.push(`speak ${id} ${text}`),
      flush: (id) => this.calls.push(`flush ${id}`),
      cancel: (id) => this.calls.push(`cancel ${id}`),
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
    });
  }

  send(event: TtsEvent): void {
    this.emit?.(event);
  }
}
