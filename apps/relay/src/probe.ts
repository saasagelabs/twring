import { Resolver } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, isIP } from 'node:net';

import { probeEchoLine, type RelayProbeCheck } from '@twring/contracts';

/** Each check gives up after this long. */
export const PROBE_CHECK_TIMEOUT_MS = 4_000;
/** The largest `/v1/server` answer read during the HTTPS check. */
const MAX_SERVER_INFO_BYTES = 16 * 1024;

/** The eight 16-bit groups of an IPv6 address (already validated by `isIP`). */
export function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[2]!.split('.').map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** IPv4 ranges the relay never probes: [first octets as a 32-bit number, prefix length]. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
];

function v4Number(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

function publicV4(ip: string): boolean {
  const n = v4Number(ip);
  return BLOCKED_V4.every(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4Number(base);
    return n < start || n >= start + size;
  });
}

/**
 * Whether the relay may connect to `ip`: a public unicast address only. IPv6 must be global
 * unicast (2000::/3), which rules out loopback, unspecified, IPv4-mapped, ULA, link-local and
 * multicast; inside it, documentation, 6to4, Teredo and other IETF special ranges are refused.
 */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return publicV4(ip);
  if (family !== 6) return false;
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((group) => Number.isNaN(group))) return false;
  const [g0 = 0, g1 = 0] = g;
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // 2001::/23 (Teredo and protocol assignments)
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

/**
 * The host a registered address points at, or undefined when it is not one the probe accepts: an
 * https URL must parse and may name port 443 only (the HTTPS check never targets another port).
 */
export function probeTarget(address: string): string | undefined {
  if (!address.startsWith('https://')) return address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  // The URL class drops a default port, so any port left here is not 443.
  if (url.port !== '' || url.protocol !== 'https:') return undefined;
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

/** The network as the probe uses it. Every method gets an IP the guard already accepted. */
export interface ProbeNet {
  /** All addresses a hostname resolves to; `signal` cancels the lookup. */
  resolve(host: string, signal: AbortSignal): Promise<string[]>;
  /** True when a TCP connection to `ip:port` opens. */
  tcpConnect(ip: string, port: number, signal: AbortSignal): Promise<boolean>;
  /** The first datagram answered to `message` sent to `ip:port`, if any. */
  udpExchange(
    ip: string,
    port: number,
    message: string,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  /** An HTTP(S) GET to `ip` with SNI and Host set to `host`; redirects are never followed. */
  get(
    url: { scheme: 'http' | 'https'; ip: string; port: number; host: string; path: string },
    signal: AbortSignal,
  ): Promise<{ status: number; body: string }>;
}

export interface ProbeDeps {
  net: ProbeNet;
  /** An abort signal that fires after `ms`; tests fire it by hand. */
  timeout: (ms: number) => AbortSignal;
  /** Monotonic milliseconds, for the delay reported per check. */
  clock: () => number;
  /** Charges one probe to the target IP; false when that IP is over its budget. */
  allowTarget?: (ip: string) => boolean;
  /** Charges one probe to a hostname before it is resolved; false when it is over budget. */
  allowHost?: (host: string) => boolean;
}

export type ProbeOutcome =
  | { ok: true; results: Partial<Record<RelayProbeCheck, { ok: boolean; ms?: number }>> }
  | { ok: false; reason: 'invalid_address' | 'unresolved' | 'not_public' | 'busy' };

/** Settles when `signal` fires. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error('timeout'));
    signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
  });
}

/**
 * Probes an install's own registered address, never anything else. The name is resolved once and
 * every address it gives must be public; all checks then connect to that one validated IP (with
 * SNI and Host set to the name), so a second, rebinding lookup can never steer a check inside.
 */
export async function runProbe(
  deps: ProbeDeps,
  input: {
    address: string;
    serverId: string;
    checks: readonly RelayProbeCheck[];
    nonce: string;
  },
): Promise<ProbeOutcome> {
  const host = probeTarget(input.address);
  if (host === undefined) return { ok: false, reason: 'invalid_address' };
  let ips: string[];
  if (isIP(host) !== 0) {
    ips = [host];
  } else {
    // Charged before the lookup, so one name cannot make the relay resolve it without end.
    if (deps.allowHost !== undefined && !deps.allowHost(host.toLowerCase())) {
      return { ok: false, reason: 'busy' };
    }
    // A name server that never answers must not hold the probe: the lookup gets a check's time.
    const signal = deps.timeout(PROBE_CHECK_TIMEOUT_MS);
    const lookup = deps.net.resolve(host, signal);
    lookup.catch(() => undefined);
    try {
      ips = await Promise.race([lookup, aborted(signal)]);
    } catch {
      return { ok: false, reason: 'unresolved' };
    }
  }
  if (ips.length === 0) return { ok: false, reason: 'unresolved' };
  if (!ips.every(isPublicIp)) return { ok: false, reason: 'not_public' };
  // IPv4 first when the name has both: the echo and most home routers are surest there.
  const ip = ips.find((candidate) => isIP(candidate) === 4) ?? ips[0]!;
  if (deps.allowTarget !== undefined && !deps.allowTarget(ip)) {
    return { ok: false, reason: 'busy' };
  }
  const line = probeEchoLine(input.nonce);

  const one = async (check: RelayProbeCheck): Promise<boolean> => {
    // Checked again right before connecting: nothing may reach a non-public address.
    if (!isPublicIp(ip)) return false;
    const signal = deps.timeout(PROBE_CHECK_TIMEOUT_MS);
    const attempt = (async () => {
      switch (check) {
        case 'http': {
          await deps.net.get({ scheme: 'http', ip, port: 80, host, path: '/v1/server' }, signal);
          return true;
        }
        case 'https': {
          const answer = await deps.net.get(
            { scheme: 'https', ip, port: 443, host, path: '/v1/server' },
            signal,
          );
          if (answer.status !== 200) return false;
          const body = JSON.parse(answer.body) as { server_id?: unknown };
          return body.server_id === input.serverId;
        }
        case 'tcp7881':
          return deps.net.tcpConnect(ip, 7881, signal);
        case 'udp7882':
          return (await deps.net.udpExchange(ip, 7882, line, signal))?.trim() === line;
      }
    })();
    attempt.catch(() => undefined);
    let ok: boolean;
    try {
      ok = await Promise.race([attempt, aborted(signal)]);
    } catch {
      ok = false;
    }
    // A failure answers only when the timeout ends, so refused and filtered ports look alike.
    if (!ok) await whenAborted(signal);
    return ok;
  };

  const unique = [...new Set(input.checks)];
  const results: Partial<Record<RelayProbeCheck, { ok: boolean; ms?: number }>> = {};
  await Promise.all(
    unique.map(async (check) => {
      const started = deps.clock();
      const ok = await one(check);
      results[check] = ok
        ? { ok, ms: Math.max(0, Math.round(deps.clock() - started)) }
        : { ok: false };
    }),
  );
  return { ok: true, results };
}

/** The Host header for `host`: an IPv6 literal goes in brackets. */
function hostHeader(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** The part of `Resolver` the probe uses (a fake in tests). */
export interface ProbeResolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}

/**
 * A and AAAA records of `host`, through c-ares (never the libuv thread pool that `lookup` ties
 * up), cancelled when `signal` fires. Fails only when neither family answers.
 */
export async function resolveWith(
  resolver: ProbeResolver,
  host: string,
  signal: AbortSignal,
): Promise<string[]> {
  const onAbort = () => resolver.cancel();
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const answers = Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const [v4, v6] = await Promise.race([answers, aborted(signal)]);
    if (v4.status === 'rejected' && v6.status === 'rejected') throw v4.reason;
    return [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : []),
    ];
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** The real network. Connections go to the validated IP only, never to the name. */
export const nodeProbeNet: ProbeNet = {
  resolve(host, signal) {
    // One resolver per lookup, so cancelling it stops only this probe's queries.
    return resolveWith(new Resolver({ timeout: 2_000, tries: 1 }), host, signal);
  },
  tcpConnect(ip, port, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = connect({ host: ip, port });
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        socket.destroy();
        resolve(ok);
      };
      const onAbort = () => finish(false);
      if (signal.aborted) return finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('connect', () => {
        // Re-checked on the live socket: the peer must still be the public address asked for.
        finish(socket.remoteAddress !== undefined && isPublicIp(socket.remoteAddress));
      });
      socket.on('error', () => finish(false));
    });
  },
  udpExchange(ip, port, message, signal) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = createSocket(isIP(ip) === 6 ? 'udp6' : 'udp4');
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve(value);
      };
      const onAbort = () => finish(undefined);
      // Errors after settling (a late ICMP refusal) are swallowed, never thrown.
      socket.on('error', () => finish(undefined));
      if (signal.aborted) return finish(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      socket.on('message', (data, from) => {
        if (from.address === ip && from.port === port && data.length <= 128) {
          finish(data.toString('utf8'));
        }
      });
      socket.send(message, port, ip, (error) => {
        if (error) finish(undefined);
      });
    });
  },
  get(url, signal) {
    return new Promise((resolve, reject) => {
      const ipHost = isIP(url.host) !== 0;
      const options = {
        host: url.ip,
        port: url.port,
        path: url.path,
        method: 'GET',
        headers: { host: hostHeader(url.host), accept: 'application/json' },
        signal,
        agent: false as const,
      };
      const onResponse = (res: IncomingMessage) => {
        res.on('error', reject);
        if (url.scheme === 'http') {
          // Port 80 only has to answer: the status line is enough, the body is never read.
          resolve({ status: res.statusCode ?? 0, body: '' });
          res.destroy();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_SERVER_INFO_BYTES) res.destroy(new Error('too large'));
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      };
      const req =
        url.scheme === 'https'
          ? httpsRequest(
              // Certificate checked against the name (SNI too), while connecting to the IP.
              { ...options, ...(!ipHost && { servername: url.host }), rejectUnauthorized: true },
              onResponse,
            )
          : httpRequest(options, onResponse);
      req.on('error', reject);
      req.end();
    });
  },
};
