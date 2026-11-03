import { randomBytes } from 'node:crypto';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import QRCode from 'qrcode';
import { buildPairLink } from '@twring/contracts';

import { ADMIN_HOST, ADMIN_PORT } from './selfhost/admin';
import { loadServerIdentity } from './selfhost/identity';
import {
  RelayClient,
  relayKeyFromFile,
  RelayUnavailableError,
  type RelayFetch,
} from './selfhost/relay-client';

/**
 * The server side of the `twring` command (Ruling: admin listener):
 * `docker compose exec -T twring node dist/admin-cli.js <command>`. Prints the listener's JSON.
 *
 *   code admin|member        a pairing code for a new phone (also `code --admin`)
 *        --qr                with the pairing link and a terminal QR code (needs CORD_PUBLIC_URL)
 *   people [--removed]       people and their phones (--removed: removed, not yet purged)
 *   remove <person id> [--purge]  remove a person and their phones (--purge: all their data)
 *   status                   server id and counts
 *   first-admin              the id of the first admin with a paired phone (exit 1: none yet)
 *   connector-code <person>  a code that links a computer's agents for that person
 *
 * Offline commands talk to Twring's relay, not the admin listener, so the installer can run them
 * with `docker run` before the server starts (Ruling R3). They read `TWRING_RELAY_URL`,
 * `TWRING_SERVER_KEY_FILE` and `TWRING_RELAY_KEY_FILE`, and never print a key:
 *
 *   ip                                         this machine's public address, as the relay sees it
 *   register --email <e> --news yes|no [--address <a>]   register; stores the relay key (mode 600)
 *   address <address>                          the address the relay may probe
 *   unregister                                 delete this install and its records at the relay
 *   probe --address <a> --checks https,http,tcp7881,udp7882   reachability, as JSON
 */
const OFFLINE = new Set(['ip', 'register', 'address', 'probe', 'unregister']);
const PROBE_CHECKS = ['https', 'http', 'tcp7881', 'udp7882'] as const;
type ProbeCheck = (typeof PROBE_CHECKS)[number];

export async function runAdminCli(
  argv: readonly string[],
  deps: {
    token: string | undefined;
    fetch?: typeof fetch;
    out?: (text: string) => void;
    port?: number;
    /** Offline commands: the environment (TWRING_RELAY_URL and the key files). */
    env?: Record<string, string | undefined>;
    /** Offline commands: how the relay is reached (tests use a fake). */
    relayFetch?: RelayFetch;
  },
): Promise<number> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  if (OFFLINE.has(argv[0] ?? '')) return runOffline(argv, { ...deps, out });
  if (deps.token === undefined) {
    out('TWRING_ADMIN_TOKEN is not set.');
    return 2;
  }
  const [command, arg, flag] = argv;
  let method = 'GET';
  let path: string;
  let body: unknown;
  switch (command ?? '') {
    case 'code': {
      const words = argv.slice(1);
      const role = words.includes('admin') || words.includes('--admin') ? 'admin' : 'member';
      if (
        words.some((w) => !['admin', 'member', '--admin', '--qr'].includes(w)) ||
        words.length === 0
      ) {
        out('Usage: code admin|member [--qr]');
        return 2;
      }
      if (words.includes('--qr')) return pairingQr(role, deps, out);
      [method, path, body] = ['POST', '/admin/codes', { role }];
      break;
    }
    case 'people':
    case 'first-admin':
      path = arg === '--removed' ? '/admin/people?removed=1' : '/admin/people';
      break;
    case 'status':
      path = '/admin/status';
      break;
    case 'remove':
      if (arg === undefined) {
        out('Usage: remove <person id>');
        return 2;
      }
      [method, path] = [
        'DELETE',
        `/admin/people/${encodeURIComponent(arg)}${flag === '--purge' ? '?purge=1' : ''}`,
      ];
      break;
    case 'connector-code':
      if (arg === undefined) {
        out('Usage: connector-code <person id>');
        return 2;
      }
      [method, path, body] = ['POST', '/admin/connector-code', { person_id: arg }];
      break;
    default:
      out(
        'Commands: code admin|member, people, remove <id>, status, first-admin, connector-code <id>, ip, register, address, probe, unregister',
      );
      return 2;
  }
  const response = await (deps.fetch ?? fetch)(
    `http://${ADMIN_HOST}:${deps.port ?? ADMIN_PORT}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${deps.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  const text = await response.text();
  if (command === 'first-admin') {
    if (!response.ok) return 1;
    const id = firstAdminWithPhone(text);
    if (id === undefined) return 1;
    out(id);
    return 0;
  }
  if (text !== '') out(text);
  return response.ok ? 0 : 1;
}

async function listener(
  deps: { token: string | undefined; fetch?: typeof fetch; port?: number },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; text: string }> {
  const response = await (deps.fetch ?? fetch)(
    `http://${ADMIN_HOST}:${deps.port ?? ADMIN_PORT}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${deps.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  return { ok: response.ok, text: await response.text() };
}

/**
 * A pairing code with its link (`twring://pair?server=&code=&id=`) and the link as a terminal QR,
 * drawn here so the host needs nothing installed. The code is shown on purpose: it is what the
 * person types when they cannot scan.
 */
async function pairingQr(
  role: 'admin' | 'member',
  deps: {
    token: string | undefined;
    fetch?: typeof fetch;
    port?: number;
    env?: Record<string, string | undefined>;
  },
  out: (text: string) => void,
): Promise<number> {
  const server = (deps.env ?? process.env).CORD_PUBLIC_URL;
  if (server === undefined) {
    out('CORD_PUBLIC_URL is not set.');
    return 2;
  }
  const minted = await listener(deps, 'POST', '/admin/codes', { role });
  const status = await listener(deps, 'GET', '/admin/status');
  let code: unknown;
  let id: unknown;
  try {
    code = (JSON.parse(minted.text) as { code?: unknown }).code;
    id = (JSON.parse(status.text) as { server_id?: unknown }).server_id;
  } catch {
    code = undefined;
  }
  if (!minted.ok || !status.ok || typeof code !== 'string' || typeof id !== 'string') {
    out('The server did not give a code. Is it running?');
    return 1;
  }
  const link = buildPairLink({ server, code, serverId: id });
  out(await QRCode.toString(link, { type: 'terminal', small: true }));
  out(`Link: ${link}`);
  out(`Or type the address ${server} and code ${code} (valid 10 minutes).`);
  return 0;
}

/** The first admin who has at least one paired phone, from `GET /admin/people`. */
function firstAdminWithPhone(text: string): string | undefined {
  try {
    const { people } = JSON.parse(text) as {
      people?: { id?: unknown; role?: unknown; devices?: unknown }[];
    };
    const admin = (people ?? []).find(
      (p) =>
        p.role === 'admin' &&
        typeof p.id === 'string' &&
        Array.isArray(p.devices) &&
        p.devices.length > 0,
    );
    return admin?.id as string | undefined;
  } catch {
    return undefined;
  }
}

/** `--name value` pairs; a bare word is a positional. */
function options(argv: readonly string[]): { named: Map<string, string>; rest: string[] } {
  const named = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i]!;
    if (word.startsWith('--') && i + 1 < argv.length) {
      named.set(word.slice(2), argv[i + 1]!);
      i += 1;
    } else {
      rest.push(word);
    }
  }
  return { named, rest };
}

async function runOffline(
  argv: readonly string[],
  deps: {
    out: (text: string) => void;
    env?: Record<string, string | undefined>;
    relayFetch?: RelayFetch;
  },
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out;
  const [command, ...args] = argv;
  const { named, rest } = options(args);
  const keyFile = env.TWRING_RELAY_KEY_FILE;
  const relay = new RelayClient({
    baseUrl: env.TWRING_RELAY_URL ?? 'https://relay.twring.com',
    relayKey:
      keyFile === undefined
        ? () => Promise.reject(new Error('TWRING_RELAY_KEY_FILE is not set.'))
        : relayKeyFromFile(keyFile),
    ...(deps.relayFetch !== undefined && { fetch: deps.relayFetch }),
  });
  try {
    switch (command) {
      case 'ip':
        out(await relay.publicIp());
        return 0;
      case 'register': {
        const email = named.get('email');
        const news = named.get('news');
        const address = named.get('address');
        if (email === undefined || (news !== 'yes' && news !== 'no')) {
          out('Usage: register --email <email> --news yes|no [--address <address>]');
          return 2;
        }
        const serverKeyFile = env.TWRING_SERVER_KEY_FILE;
        if (serverKeyFile === undefined || keyFile === undefined) {
          out('TWRING_SERVER_KEY_FILE and TWRING_RELAY_KEY_FILE must be set.');
          return 2;
        }
        let identity;
        try {
          identity = await loadServerIdentity(serverKeyFile);
        } catch {
          out(`The server key (${serverKeyFile}) could not be read.`);
          return 1;
        }
        const install = await relay.registerInstall(
          { email, news: news === 'yes', ...(address !== undefined && { address }) },
          identity,
        );
        // Written beside, then renamed, so a crash never leaves half a key.
        const temporary = `${keyFile}.new`;
        await writeFile(temporary, `${install.relay_key}\n`, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, keyFile);
        out(
          JSON.stringify({
            server_id: identity.id,
            install_id: install.install_id,
            verified: install.verified,
            paid_until: install.paid_until,
          }),
        );
        return 0;
      }
      case 'unregister':
        await relay.deleteInstall();
        out('unregistered');
        return 0;
      case 'address': {
        const address = rest[0];
        if (address === undefined) {
          out('Usage: address <address>');
          return 2;
        }
        await relay.setAddress(address);
        out(address);
        return 0;
      }
      case 'probe': {
        const address = named.get('address');
        const checks = (named.get('checks') ?? '').split(',').filter((c) => c !== '');
        if (
          address === undefined ||
          checks.length === 0 ||
          !checks.every((c): c is ProbeCheck => (PROBE_CHECKS as readonly string[]).includes(c))
        ) {
          out('Usage: probe --address <address> --checks https,http,tcp7881,udp7882');
          return 2;
        }
        const result = await relay.probe({
          address,
          checks,
          nonce: randomBytes(16).toString('base64url'),
        });
        out(JSON.stringify(result.results));
        return 0;
      }
      case undefined:
      default:
        return 2;
    }
  } catch (error) {
    // RelayUnavailableError carries a path and status only, never a key or the relay's body.
    if (error instanceof RelayUnavailableError && error.reason !== undefined) {
      out(`${error.message} ${error.reason}`);
    } else {
      out(error instanceof Error ? error.message : 'The ring service could not be reached.');
    }
    return 3;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAdminCli(process.argv.slice(2), {
    token: process.env.TWRING_ADMIN_TOKEN,
  });
}
