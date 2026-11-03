import { promises as dns } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import { AdapterError } from './errors';

export type EndpointEnv = 'development' | 'staging' | 'production';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every address for a host name (injectable for tests). */
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EndpointGuardOptions {
  env: EndpointEnv;
  /** Hosts that may resolve to private addresses, honoured only in development. */
  allowPrivateHosts?: string[];
  lookup?: HostLookup;
  /** Bounds the DNS lookup; defaults to `DNS_LOOKUP_TIMEOUT_MS`. */
  lookupTimeoutMs?: number;
}

/** A host name that does not answer within this is treated as unresolvable. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The host name could not be looked up (no answer in time, or no such host). Still an
 * `endpoint_rejected` adapter error, so callers that only check the code keep failing closed; the
 * subclass lets setup screens say "check the address" rather than "not allowed".
 */
export class EndpointUnresolvableError extends AdapterError {
  constructor(detail: string) {
    super('endpoint_rejected', { detail, retryable: false });
  }
}

export function isEndpointUnresolvable(error: unknown): error is EndpointUnresolvableError {
  return error instanceof EndpointUnresolvableError;
}

export interface SafeEndpoint {
  url: URL;
  hostname: string;
  /**
   * The validated address to connect to. Connecting by this address (with the original host name
   * kept for Host/SNI) closes the DNS-rebinding gap between validation and connection; see
   * `NativeWsAdapterOptions.pinnedAddress`.
   */
  pinned: ResolvedAddress;
}

const DEFAULT_ALLOWED_PRIVATE = ['localhost', '127.0.0.1', '::1'];

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // unspecified / "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, and IPv4-compatible (::a.b.c.d, deprecated)
  ['::ffff:0:0:0', 96], // IPv4-translated / SIIT (RFC 2765)
  ['64:ff9b::', 96], // NAT64 can front private IPv4
  ['64:ff9b:1::', 48], // NAT64 local-use (RFC 8215)
  ['100::', 64], // discard-only (RFC 6666)
  ['2001::', 32], // Teredo embeds an IPv4 address
  ['2001:10::', 28], // ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 can embed private IPv4
  ['3fff::', 20], // documentation (RFC 9637)
  ['fec0::', 10], // site-local (deprecated)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/**
 * The 16 bytes of an IPv6 address in any textual form (compressed, expanded, or with a trailing
 * dotted IPv4 part), or undefined when it is not one. A `%zone` suffix is ignored.
 */
function ipv6Bytes(address: string): number[] | undefined {
  const text = address.split('%')[0]!;
  if (isIP(text) !== 6) return undefined;
  let head = text;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    head = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
    tail.push(...dotted[2]!.split('.').map(Number));
  }
  const wanted = 8 - tail.length / 2;
  const [left, right] = head.includes('::') ? head.split('::') : [head, undefined];
  const parse = (part: string | undefined) =>
    part === undefined || part === '' ? [] : part.split(':').map((g) => parseInt(g, 16));
  const leftGroups = parse(left);
  const rightGroups = parse(right);
  const fill = right === undefined ? 0 : wanted - leftGroups.length - rightGroups.length;
  const groups = [...leftGroups, ...Array<number>(Math.max(0, fill)).fill(0), ...rightGroups];
  if (groups.length !== wanted) return undefined;
  return [...groups.flatMap((g) => [g >> 8, g & 255]), ...tail];
}

/** True when `address` must never be the target of a server-side agent connection. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.split('%')[0]!);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true;
  // IPv4-mapped (::ffff:a.b.c.d) in any spelling: the connection goes to the IPv4 address.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return blocked.check(bytes.slice(12).join('.'), 'ipv4');
  }
  const canonical = Array.from({ length: 8 }, (_, i) =>
    ((bytes[2 * i]! << 8) | bytes[2 * i + 1]!).toString(16),
  ).join(':');
  return blocked.check(canonical, 'ipv6');
}

/**
 * Ports that are never an agent endpoint and are commonly abused to reach other services (the
 * WHATWG Fetch "bad port" list), plus port 0.
 */
const BLOCKED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** True when an agent endpoint may not use `port` (a URL's `port`; '' means the default). */
export function isBlockedPort(port: string): boolean {
  return port !== '' && BLOCKED_PORTS.has(Number(port));
}

const systemLookup: HostLookup = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/**
 * SSRF guard for a user-configured agent endpoint (SECURITY_AND_PRIVACY, AGENT_ADAPTER_SPEC §14).
 * TLS (`wss:`/`https:`) is required outside development; credentials in the URL are rejected; the
 * host is resolved and every resolved address must be public. In development only, hosts listed in
 * `allowPrivateHosts` (default localhost) may resolve privately. Errors never echo the URL.
 */
export async function assertSafeAgentEndpoint(
  raw: string | URL,
  options: EndpointGuardOptions,
): Promise<SafeEndpoint> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw reject('not a valid URL');
  }
  const secure = url.protocol === 'wss:' || url.protocol === 'https:';
  const plain = url.protocol === 'ws:' || url.protocol === 'http:';
  if (!secure && !plain) throw reject('unsupported scheme');
  if (!secure && options.env !== 'development') throw reject('TLS (wss/https) is required');
  if (url.username !== '' || url.password !== '') throw reject('credentials in the URL');
  if (isBlockedPort(url.port)) throw reject('port not allowed');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === '') throw reject('missing host');
  const allowList = (options.allowPrivateHosts ?? DEFAULT_ALLOWED_PRIVATE).map((h) =>
    h.toLowerCase(),
  );
  const privateAllowed = options.env === 'development' && allowList.includes(hostname);

  let addresses: ResolvedAddress[];
  const literal = isIP(hostname);
  if (literal !== 0) {
    addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  } else {
    addresses = await boundedLookup(
      options.lookup ?? systemLookup,
      hostname,
      options.lookupTimeoutMs ?? DNS_LOOKUP_TIMEOUT_MS,
    );
  }
  if (addresses.length === 0) throw new EndpointUnresolvableError('host did not resolve');
  if (!privateAllowed && addresses.some((a) => isBlockedAddress(a.address))) {
    throw reject('host resolves to a private or reserved address');
  }
  return { url, hostname, pinned: addresses[0]! };
}

async function boundedLookup(
  lookup: HostLookup,
  hostname: string,
  timeoutMs: number,
): Promise<ResolvedAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(
      () => rejectTimeout(new EndpointUnresolvableError('host lookup timed out')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      lookup(hostname).catch(() => {
        throw new EndpointUnresolvableError('host did not resolve');
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reject(detail: string): AdapterError {
  return new AdapterError('endpoint_rejected', { detail, retryable: false });
}
