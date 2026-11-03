import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { conformanceTurn } from './conformance';
import {
  assertSafeAgentEndpoint,
  isBlockedAddress,
  isBlockedPort,
  type HostLookup,
} from './endpoint-guard';
import { isAdapterError } from './errors';
import { NativeWsAdapter } from './native-adapter';
import { RestSseAdapter } from './rest-sse-adapter';

// Milestone 10 SSRF review: the forms not already covered by endpoint-guard(.edge).test.ts, plus
// redirect and pinning behaviour of both launch adapters.

const publicLookup: HostLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

async function verdict(
  url: string,
  env: 'development' | 'staging' | 'production' = 'production',
  lookup: HostLookup = publicLookup,
): Promise<string> {
  try {
    await assertSafeAgentEndpoint(url, { env, lookup });
    return 'allowed';
  } catch (error) {
    return isAdapterError(error) ? error.code : 'threw';
  }
}

describe('isBlockedAddress: reserved ranges', () => {
  it.each([
    // 0.0.0.0/8 ("this network")
    '0.0.0.0',
    '0.1.2.3',
    '0.255.255.255',
    // cloud metadata: AWS/GCP/Azure/OCI IPv4, AWS IPv6 (fd00:ec2::254), Alibaba 100.100.100.200
    '169.254.169.254',
    '169.254.170.2', // ECS task metadata
    'fd00:ec2::254',
    '100.100.100.200',
    // link-local
    '169.254.0.1',
    'fe80::1',
    'fe80::1%eth0',
    'febf:ffff::1',
    // unspecified
    '::',
    '0:0:0:0:0:0:0:0',
    // multicast
    '224.0.0.1',
    '239.255.255.250',
    'ff02::1',
    'ff0e::1',
    // IPv4-mapped IPv6 in every spelling
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '0:0:0:0:0:ffff:a00:1',
    '0000:0000:0000:0000:0000:ffff:0a00:0001',
    '::FFFF:169.254.169.254',
    '0:0:0:0:0:ffff:169.254.169.254',
    // NAT64 (well-known and local-use) fronting private or metadata IPv4
    '64:ff9b::10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a00:1',
    // Teredo / 6to4 / documentation
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '2002:c0a8:101::1',
    '2001:db8::1',
    // documentation IPv4
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    // garbage
    '',
    '999.1.1.1',
    '::ffff:1.2.3',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '::ffff:8.8.8.8',
    '0:0:0:0:0:ffff:808:808',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888', // Google, not Teredo
  ])('allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('assertSafeAgentEndpoint: URL forms', () => {
  it.each([
    'https://2130706433/', // decimal 127.0.0.1
    'https://2852039166/', // decimal 169.254.169.254
    'https://0xa9fea9fe/', // hex 169.254.169.254
    'https://0xA9.0xFE.0xA9.0xFE/', // dotted hex
    'https://0251.0376.0251.0376/', // dotted octal
    'https://017700000001/', // octal 127.0.0.1
    'https://0.0.0.0/',
    'https://0/',
    'https://[::]/',
    'https://[0:0:0:0:0:0:0:0]/',
    'https://[fe80::1]/',
    'https://[fd00:ec2::254]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[64:ff9b::169.254.169.254]/',
    'https://224.0.0.1/',
    'https://[ff02::1]/',
    'https://100.100.100.200/',
  ])('rejects %s', async (url) => {
    expect(await verdict(url)).toBe('endpoint_rejected');
  });

  it('rejects names that resolve to metadata or link-local addresses', async () => {
    for (const address of ['169.254.169.254', 'fd00:ec2::254', 'fe80::1', '::ffff:a9fe:a9fe']) {
      const lookup: HostLookup = () =>
        Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]);
      expect(await verdict('https://metadata.example.com/', 'production', lookup)).toBe(
        'endpoint_rejected',
      );
    }
  });

  it.each([
    'https://user@agent.example.com/',
    'https://user:pass@agent.example.com/',
    'https://:pass@agent.example.com/',
    'wss://token@agent.example.com/cord',
    'https://127.0.0.1\\@agent.example.com/',
  ])('rejects userinfo in %s', async (url) => {
    expect(await verdict(url)).toBe('endpoint_rejected');
  });

  it('checks the host the WHATWG parser sees, which is the one the adapters connect to', async () => {
    // A backslash ends the authority for special schemes: the host is agent.example.com and
    // "@127.0.0.1" is path. Both the guard and node:http/ws use this same parse.
    const safe = await assertSafeAgentEndpoint('https://agent.example.com\\@127.0.0.1/', {
      env: 'production',
      lookup: publicLookup,
    });
    expect(safe.hostname).toBe('agent.example.com');
  });

  it.each([
    'file:///etc/passwd',
    'ftp://agent.example.com/',
    'gopher://agent.example.com:70/',
    'dict://agent.example.com:11211/',
    'ldap://agent.example.com/',
    'javascript:alert(1)',
    'data:text/plain,hi',
    'blob:https://agent.example.com/x',
    'chrome://settings',
  ])('rejects the scheme in %s', async (url) => {
    expect(await verdict(url, 'development')).toBe('endpoint_rejected');
  });

  it('requires https or wss outside development', async () => {
    for (const env of ['staging', 'production'] as const) {
      expect(await verdict('http://agent.example.com/', env)).toBe('endpoint_rejected');
      expect(await verdict('ws://agent.example.com/', env)).toBe('endpoint_rejected');
      expect(await verdict('https://agent.example.com/', env)).toBe('allowed');
      expect(await verdict('wss://agent.example.com/', env)).toBe('allowed');
    }
    expect(await verdict('http://agent.example.com/', 'development')).toBe('allowed');
  });

  it('allows ordinary ports and refuses ports of other services', async () => {
    for (const port of ['', '443', '8443', '9443', '3000', '8080']) {
      const url = `https://agent.example.com${port === '' ? '' : `:${port}`}/`;
      expect(await verdict(url), url).toBe('allowed');
    }
    for (const port of ['22', '25', '53', '6667', '10080']) {
      expect(await verdict(`https://agent.example.com:${port}/`), port).toBe('endpoint_rejected');
    }
    expect(await verdict('https://agent.example.com:0/')).toBe('endpoint_rejected');
    expect(await verdict('https://agent.example.com:65536/')).toBe('endpoint_rejected');
    expect(isBlockedPort('')).toBe(false);
    expect(isBlockedPort('443')).toBe(false);
  });

  it('checks every resolved address, not just the first (rebinding by round robin)', async () => {
    const lookup: HostLookup = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '0:0:0:0:0:ffff:7f00:1', family: 6 },
      ]);
    expect(await verdict('https://agent.example.com/', 'production', lookup)).toBe(
      'endpoint_rejected',
    );
  });

  it('re-resolves on every check, so a name rebound to a private address is caught', async () => {
    let answer = '93.184.216.34';
    const lookup: HostLookup = () => Promise.resolve([{ address: answer, family: 4 }]);
    expect(await verdict('https://agent.example.com/', 'production', lookup)).toBe('allowed');
    answer = '10.0.0.7';
    expect(await verdict('https://agent.example.com/', 'production', lookup)).toBe(
      'endpoint_rejected',
    );
  });
});

describe('launch adapters: redirects and pinning', () => {
  let server: Server | undefined;
  const hits: string[] = [];
  afterEach(async () => {
    hits.length = 0;
    if (server !== undefined) {
      server.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = undefined;
    }
  });

  /** A server that answers every request with a redirect to a private address. */
  async function redirectingServer(): Promise<number> {
    server = createServer((req: IncomingMessage, res) => {
      hits.push(req.url ?? '');
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    server.on('upgrade', (req: IncomingMessage, socket) => {
      hits.push(req.url ?? '');
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: ws://169.254.169.254/latest/\r\nContent-Length: 0\r\n\r\n',
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  const ctx = { callId: 'call_1', sessionId: 'sess_1' };

  /** Connects, sends one turn, and returns what the turn failed with (undefined if it did not). */
  async function turnFailure(adapter: RestSseAdapter, turnId: string): Promise<unknown> {
    await adapter.connect(ctx, new AbortController().signal);
    const events: unknown[] = [];
    try {
      for await (const event of adapter.sendTurn(
        conformanceTurn(turnId),
        new AbortController().signal,
      )) {
        events.push(event);
      }
      return undefined;
    } catch (error) {
      return error;
    } finally {
      await adapter.close();
    }
  }

  it('the REST adapter does not follow a redirect', async () => {
    const port = await redirectingServer();
    const adapter = new RestSseAdapter({ url: `http://127.0.0.1:${port}/cord/turns` });
    const failure = await turnFailure(adapter, 't_redirect');
    expect(isAdapterError(failure) && failure.code).toBe('agent_error');
    expect(hits).toEqual(['/cord/turns']);
  });

  it('the native adapter does not follow a redirect', async () => {
    const port = await redirectingServer();
    const adapter = new NativeWsAdapter({
      url: `ws://127.0.0.1:${port}/cord`,
      timeouts: { connectMs: 2_000 },
    });
    const failure = await adapter.connect(ctx, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await adapter.close();
    expect(isAdapterError(failure)).toBe(true);
    expect(hits).toEqual(['/cord']);
  });

  it('the native adapter always asks ws not to follow redirects', async () => {
    let seen: { followRedirects?: boolean } | undefined;
    const adapter = new NativeWsAdapter({
      url: 'wss://agent.example.com/cord',
      timeouts: { connectMs: 50 },
      socketFactory: (_url, options) => {
        seen = options;
        throw new Error('stop here');
      },
    });
    await adapter.connect(ctx, new AbortController().signal).catch(() => undefined);
    await adapter.close();
    expect(seen?.followRedirects).toBe(false);
  });

  it('connects to the pinned address, never re-resolving the name', async () => {
    server = createServer((req, res) => {
      hits.push(req.headers.host ?? '');
      res.writeHead(401).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // `.invalid` never resolves (RFC 2606), so reaching the server proves the pinned address won.
    const adapter = new RestSseAdapter({
      url: `http://rebind.invalid:${port}/cord/turns`,
      pinnedAddress: { address: '127.0.0.1', family: 4 },
    });
    const failure = await turnFailure(adapter, 't_pin');
    expect(isAdapterError(failure) && failure.code).toBe('auth_failed');
    expect(hits).toEqual([`rebind.invalid:${port}`]);
  });
});

describe('assertSafeAgentEndpoint: M10 verifier forms', () => {
  it.each([
    'https://[fe80::1%25eth0]/', // zone id: WHATWG refuses it, so no adapter can reach it either
    'https://[fe80::1%eth0]/',
    'https://[::ffff:127.0.0.1]/', // mapped loopback, dotted
    'https://[::ffff:7f00:1]/', // mapped loopback, hex
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://[::127.0.0.1]/', // IPv4-compatible loopback
    'https://[::1]/',
    'https://0x7f.1/',
    'https://127.1/',
    'https://2130706433/',
    'https://127.0.0.1./', // trailing dot on an IPv4 literal
    'wss://0x7f.1/cord',
    'wss://[::ffff:a9fe:a9fe]/cord',
  ])('rejects %s in production', async (url) => {
    expect(await verdict(url)).toBe('endpoint_rejected');
  });

  it('a trailing-dot name is resolved like any other, and its private answer refused', async () => {
    const seen: string[] = [];
    const lookup: HostLookup = (host) => {
      seen.push(host);
      return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    };
    expect(await verdict('https://localhost./', 'production', lookup)).toBe('endpoint_rejected');
    // Development allows `localhost`, but not a spelling the allow-list does not name.
    expect(await verdict('https://localhost./', 'development', lookup)).toBe('endpoint_rejected');
    expect(seen).toEqual(['localhost.', 'localhost.']);
  });

  it('mixed answers are refused whichever address comes first', async () => {
    for (const answers of [
      [
        { address: '10.1.2.3', family: 4 as const },
        { address: '93.184.216.34', family: 4 as const },
      ],
      [
        { address: '2606:4700:4700::1111', family: 6 as const },
        { address: 'fd12::1', family: 6 as const },
      ],
      [
        { address: '93.184.216.34', family: 4 as const },
        { address: '::ffff:169.254.169.254', family: 6 as const },
      ],
    ]) {
      const lookup: HostLookup = () => Promise.resolve(answers);
      expect(await verdict('https://agent.example.com/', 'production', lookup)).toBe(
        'endpoint_rejected',
      );
    }
  });

  it('an AAAA-only answer is checked and pinned as IPv6', async () => {
    const lookup: HostLookup = () =>
      Promise.resolve([{ address: '2606:4700:4700::1111', family: 6 }]);
    const safe = await assertSafeAgentEndpoint('wss://agent.example.com/cord', {
      env: 'production',
      lookup,
    });
    expect(safe.pinned).toEqual({ address: '2606:4700:4700::1111', family: 6 });
    const blocked: HostLookup = () => Promise.resolve([{ address: 'fe80::1%eth0', family: 6 }]);
    expect(await verdict('wss://agent.example.com/cord', 'production', blocked)).toBe(
      'endpoint_rejected',
    );
  });

  it('refuses bad ports on ws and wss URLs, and treats an explicit default port as default', async () => {
    for (const url of [
      'wss://agent.example.com:22/cord',
      'wss://agent.example.com:25/cord',
      'wss://agent.example.com:0/cord',
    ]) {
      expect(await verdict(url), url).toBe('endpoint_rejected');
    }
    expect(await verdict('ws://agent.example.com:6667/cord', 'development')).toBe(
      'endpoint_rejected',
    );
    expect(await verdict('wss://agent.example.com:443/cord')).toBe('allowed');
    expect(await verdict('ws://agent.example.com:80/cord', 'development')).toBe('allowed');
  });
});
