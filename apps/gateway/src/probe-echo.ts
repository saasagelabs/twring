import { createSocket, type Socket as UdpSocket, type SocketType } from 'node:dgram';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

import { PROBE_ECHO_PATTERN } from '@twring/contracts';

/**
 * The reachability echo (Ruling: echo probe): `node dist/probe-echo.js` listens on 7881/tcp and
 * 7882/udp while LiveKit is stopped, so the relay can prove both ports reach this machine. It
 * answers only a well-formed `twring-probe <nonce>` line, ignores everything else, and exits by
 * itself after its lifetime so it never lingers on the ports.
 */

/** The longest input looked at: the probe line plus a CRLF. Anything longer is ignored. */
const MAX_LINE_BYTES = 'twring-probe '.length + 64 + 2;
/** A TCP connection that has not sent its line in this long is dropped. */
const TCP_IDLE_MS = 4_000;
export const DEFAULT_LIFETIME_MS = 120_000;

/** The reply to `input`, or undefined when it is not exactly one probe line. */
export function echoReply(input: Buffer): string | undefined {
  if (input.length > MAX_LINE_BYTES) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return undefined;
  }
  const line = text.replace(/\r?\n$/, '');
  return PROBE_ECHO_PATTERN.test(line) ? `${line}\n` : undefined;
}

export interface ProbeEcho {
  tcpPort: number;
  udpPort: number;
  close(): Promise<void>;
  /** Settles once both listeners are closed (by `close` or the lifetime). */
  closed: Promise<void>;
}

/** Bind errors that mean this host has no IPv6, so the dual-stack `::` cannot be used. */
const NO_IPV6_CODES = new Set(['EAFNOSUPPORT', 'EADDRNOTAVAIL']);

interface Listeners {
  tcp: Server;
  udp: UdpSocket;
  sockets: Set<Socket>;
}

async function listen(
  host: string,
  tcpPort: number,
  udpPort: number,
  createUdpSocket: (type: SocketType) => UdpSocket,
): Promise<Listeners> {
  const v6 = host.includes(':');
  const sockets = new Set<Socket>();
  const tcp: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(TCP_IDLE_MS, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) {
        if (buffered.length > MAX_LINE_BYTES) socket.destroy();
        return;
      }
      const reply = echoReply(buffered.subarray(0, newline + 1));
      if (reply === undefined || newline + 1 !== buffered.length) {
        socket.destroy();
        return;
      }
      socket.end(reply);
    });
  });
  const udp = createUdpSocket(v6 ? 'udp6' : 'udp4');
  udp.on('message', (data, from) => {
    const reply = echoReply(data);
    if (reply !== undefined) udp.send(reply, from.port, from.address);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen({ port: tcpPort, host, ipv6Only: false }, () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(udpPort, host, () => resolve());
    });
  } catch (error) {
    // Release whatever did bind, so a retry on another address can take the ports.
    await new Promise<void>((resolve) => (tcp.listening ? tcp.close(() => resolve()) : resolve()));
    try {
      udp.close();
    } catch {
      // Never bound.
    }
    throw error;
  }
  // A reply to a vanished sender (ICMP unreachable) must not crash the echo.
  udp.on('error', () => undefined);
  return { tcp, udp, sockets };
}

export async function startProbeEcho(
  options: {
    host?: string;
    tcpPort?: number;
    udpPort?: number;
    lifetimeMs?: number;
    /** Runs `run` after `ms`; returns a cancel function. Tests fire it by hand. */
    setTimer?: (ms: number, run: () => void) => () => void;
    /** Creates the UDP socket. Tests use it to simulate a host without IPv6. */
    createUdpSocket?: (type: SocketType) => UdpSocket;
  } = {},
): Promise<ProbeEcho> {
  const tcpPort = options.tcpPort ?? 7881;
  const udpPort = options.udpPort ?? 7882;
  const createUdp =
    options.createUdpSocket ?? ((type: SocketType) => createSocket({ type, ipv6Only: false }));
  let listeners: Listeners;
  if (options.host !== undefined) {
    listeners = await listen(options.host, tcpPort, udpPort, createUdp);
  } else {
    // `::` with dual stack answers IPv4 (as mapped addresses) and IPv6 on one socket each. A host
    // with IPv6 turned off refuses `::`, so it gets IPv4 only.
    try {
      listeners = await listen('::', tcpPort, udpPort, createUdp);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !NO_IPV6_CODES.has(code)) throw error;
      listeners = await listen('0.0.0.0', tcpPort, udpPort, createUdp);
    }
  }
  const { tcp, udp, sockets } = listeners;

  let finish: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => (finish = resolve));
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      cancel();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => udp.close(() => resolve())),
      ]);
      finish();
    })();
    return closing;
  };
  const setTimer =
    options.setTimer ??
    ((ms, run) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const cancel = setTimer(options.lifetimeMs ?? DEFAULT_LIFETIME_MS, () => void close());

  return {
    tcpPort: (tcp.address() as AddressInfo).port,
    udpPort: udp.address().port,
    close,
    closed,
  };
}

/** Seconds to stay up, from `TWRING_PROBE_ECHO_SECONDS` (1..600), else 120. */
export function lifetimeFromEnv(value: string | undefined): number {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 600
    ? seconds * 1000
    : DEFAULT_LIFETIME_MS;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const echo = await startProbeEcho({
    lifetimeMs: lifetimeFromEnv(process.env.TWRING_PROBE_ECHO_SECONDS),
  });
  process.stdout.write(`probe echo listening on 7881/tcp and 7882/udp\n`);
  const stop = () => void echo.close();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await echo.closed;
}
