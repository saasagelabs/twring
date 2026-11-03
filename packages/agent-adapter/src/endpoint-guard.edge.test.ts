import { describe, expect, it } from 'vitest';

import { assertSafeAgentEndpoint, isBlockedAddress, type HostLookup } from './endpoint-guard';
import { isAdapterError } from './errors';

// Verifier pass (Milestone 5): SSRF bypass forms against the agent endpoint guard.

const publicLookup: HostLookup = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

async function codeOf(url: string, lookup: HostLookup = publicLookup, env = 'production' as const) {
  try {
    await assertSafeAgentEndpoint(url, { env, lookup });
    return 'allowed';
  } catch (error) {
    return isAdapterError(error) ? error.code : 'threw';
  }
}

describe('assertSafeAgentEndpoint bypass forms (verifier)', () => {
  it.each([
    'wss://2130706433/', // decimal
    'wss://0177.0.0.1/', // octal
    'wss://0x7f.1/', // hex + short form
    'wss://127.1/',
    'wss://%31%32%37.0.0.1/', // percent-encoded
    'wss://１２７.0.0.1/', // full-width digits (IDNA-normalised)
    'wss://0/',
    'wss://[::]/',
    'wss://[::1]/',
    'wss://[::ffff:127.0.0.1]/',
    'wss://[0:0:0:0:0:ffff:7f00:1]/',
    'wss://[::ffff:a9fe:a9fe]/', // metadata, IPv4-mapped
    'wss://169.254.169.254/',
    'wss://[fd00::1]/',
    'wss://[fe80::1]/',
    'wss://[64:ff9b::a9fe:a9fe]/', // NAT64 well-known prefix
  ])('rejects the literal host in %s', async (url) => {
    expect(await codeOf(url)).toBe('endpoint_rejected');
  });

  it.each(['wss://user@example.com/', 'wss://:pw@example.com/', 'wss://evil.com@127.0.0.1/'])(
    'rejects userinfo in %s',
    async (url) => {
      expect(await codeOf(url)).toBe('endpoint_rejected');
    },
  );

  it('rejects a name with any private answer among public ones (round-robin rebinding)', async () => {
    const mixed: HostLookup = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:169.254.169.254', family: 6 },
      ]);
    expect(await codeOf('wss://agent.example.com/', mixed)).toBe('endpoint_rejected');
  });

  it('rejects "localhost." (trailing dot) outside development, and does not allowlist it in development', async () => {
    const loopback: HostLookup = () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
    expect(await codeOf('wss://localhost./', loopback)).toBe('endpoint_rejected');
    expect(await codeOf('ws://localhost./', loopback, 'development' as never)).toBe(
      'endpoint_rejected',
    );
  });

  it('pins the first validated address and never echoes host or path in the error', async () => {
    const safe = await assertSafeAgentEndpoint('wss://agent.example.com/x?token=abc', {
      env: 'production',
      lookup: publicLookup,
    });
    expect(safe.pinned).toEqual({ address: '93.184.216.34', family: 4 });
    try {
      await assertSafeAgentEndpoint('wss://secret-host.internal/path?token=abc', {
        env: 'production',
        lookup: () => Promise.resolve([{ address: '10.1.2.3', family: 4 }]),
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-host|token|abc|10\.1\.2\.3/);
    }
  });

  it('GAP: IPv6 forms that embed or front IPv4 are not treated as reserved', () => {
    // Not reachable as loopback on Windows or default Linux (IPv4-compatible/translated are
    // unrouted), but they are not "public" either; NAT64 local-use and 6to4 can front private IPv4.
    const reserved = [
      '::7f00:1', // IPv4-compatible ::127.0.0.1 (deprecated, RFC 4291)
      '::ffff:0:7f00:1', // IPv4-translated (RFC 2765)
      '64:ff9b:1::a9fe:a9fe', // NAT64 local-use prefix 64:ff9b:1::/48 (RFC 8215)
      '2002:a9fe:a9fe::1', // 6to4 embedding 169.254.169.254
      'fec0::1', // site-local (deprecated, still routed on some networks)
      '100::1', // discard-only (RFC 6666)
    ];
    expect(reserved.filter((a) => !isBlockedAddress(a))).toEqual([]);
  });
});
