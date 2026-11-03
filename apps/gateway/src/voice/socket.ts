import WebSocket from 'ws';

/**
 * The slice of a WebSocket the provider adapters use. Real sockets come from `ws`; tests pass a
 * fake. Keeping this narrow is what keeps provider protocol code unit-testable.
 */
export interface ProviderSocket {
  send(data: string | Uint8Array): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: string | Uint8Array) => void): void;
  /** `code` is the WebSocket close code; `reason` is provider text, never shown to users. */
  onClose(listener: (code: number, reason: string) => void): void;
  onError(listener: (error: Error) => void): void;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => ProviderSocket;

/** Largest provider message accepted; bigger frames are a protocol error, not buffered. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/** How much of a refused handshake's answer is kept, and how long it is waited for. */
const REFUSAL_BODY_CHARS = 1024;
const REFUSAL_BODY_WAIT_MS = 2000;

/**
 * The provider answered the upgrade with an HTTP status instead of a socket. The message keeps
 * the `ws` wording ("Unexpected server response: 401") that the status mappers read; `body` is
 * the start of the provider's answer, for providers whose status alone is ambiguous. Never
 * shown to users.
 */
export class HandshakeRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Unexpected server response: ${status}`);
    this.name = 'HandshakeRefusedError';
  }
}

export const wsSocketFactory: SocketFactory = (url, headers) => {
  const socket = new WebSocket(url, { headers, maxPayload: MAX_PAYLOAD_BYTES });
  socket.on('unexpected-response', (_request, response) => {
    let body = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.emit('error', new HandshakeRefusedError(response.statusCode ?? 0, body));
      socket.terminate();
    };
    const timer = setTimeout(finish, REFUSAL_BODY_WAIT_MS);
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body = (body + chunk).slice(0, REFUSAL_BODY_CHARS);
    });
    response.on('end', finish);
    response.on('error', finish);
    response.on('close', finish);
  });
  return {
    send: (data) => socket.send(data),
    ping: () => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    },
    close: (code, reason) => socket.close(code, reason),
    get isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },
    onOpen: (listener) => socket.on('open', listener),
    onMessage: (listener) =>
      socket.on('message', (data, isBinary) => {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        listener(isBinary ? new Uint8Array(buffer) : buffer.toString('utf8'));
      }),
    onClose: (listener) => socket.on('close', (code, reason) => listener(code, reason.toString())),
    onError: (listener) => socket.on('error', listener),
  };
};

/** Resolves once the socket opens; rejects on error, early close, or abort. */
export function waitForOpen(socket: ProviderSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.close();
      reject(new Error('aborted'));
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () =>
      settle(() => {
        socket.close();
        reject(new Error('aborted'));
      });
    signal.addEventListener('abort', onAbort, { once: true });
    socket.onOpen(() => settle(resolve));
    socket.onError((error) => settle(() => reject(error)));
    socket.onClose((code) => settle(() => reject(new Error(`closed before open (${code})`))));
  });
}
