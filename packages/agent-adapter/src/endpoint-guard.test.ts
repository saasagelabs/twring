import { describe, expect, it } from 'vitest';

import { assertSafeAgentEndpoint, isBlockedAddress, type HostLookup } from './endpoint-guard';
import { isAdapterError } from './errors';

const resolvesTo =
  (...addresses: string[]): HostLookup =>
  () =>
    Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );

async function rejected(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    (e: unknown) => isAdapterError(e) && e.code === 'endpoint_rejected',
  );
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('assertSafeAgentEndpoint', () => {
  const production = { env: 'production' as const, lookup: resolvesTo('93.184.216.34') };

  it('accepts a public wss endpoint and pins the resolved address', async () => {
    const safe = await assertSafeAgentEndpoint('wss://agent.example.com:9443/cord', production);
    expect(safe.hostname).toBe('agent.example.com');
    expect(safe.pinned).toEqual({ address: '93.184.216.34', family: 4 });
  });

  it('requires TLS outside development', async () => {
    expect(await rejected(assertSafeAgentEndpoint('ws://agent.example.com', production))).toBe(
      true,
    );
    expect(
      await rejected(
        assertSafeAgentEndpoint('http://agent.example.com', { ...production, env: 'staging' }),
      ),
    ).toBe(true);
  });

  it('rejects credentials in the URL and other schemes', async () => {
    expect(await rejected(assertSafeAgentEndpoint('wss://u:p@agent.example.com', production))).toBe(
      true,
    );
    expect(await rejected(assertSafeAgentEndpoint('ftp://agent.example.com', production))).toBe(
      true,
    );
    expect(await rejected(assertSafeAgentEndpoint('not a url', production))).toBe(true);
  });

  it('rejects hosts where any resolved address is private', async () => {
    const lookup = resolvesTo('93.184.216.34', '10.0.0.5');
    expect(
      await rejected(assertSafeAgentEndpoint('wss://agent.example.com', { ...production, lookup })),
    ).toBe(true);
  });

  it('rejects private IP literals, including the metadata address', async () => {
    for (const url of ['wss://169.254.169.254', 'wss://[::1]', 'wss://127.0.0.1:8787']) {
      expect(await rejected(assertSafeAgentEndpoint(url, production))).toBe(true);
    }
  });

  it('allows localhost only in development', async () => {
    const dev = { env: 'development' as const, lookup: resolvesTo('127.0.0.1') };
    await expect(assertSafeAgentEndpoint('ws://localhost:8787', dev)).resolves.toMatchObject({
      pinned: { address: '127.0.0.1' },
    });
    await expect(assertSafeAgentEndpoint('ws://127.0.0.1:8787', dev)).resolves.toBeDefined();
    expect(
      await rejected(
        assertSafeAgentEndpoint('wss://localhost:8787', {
          env: 'production',
          lookup: resolvesTo('127.0.0.1'),
        }),
      ),
    ).toBe(true);
    // A non-allow-listed name resolving privately is still rejected in development.
    expect(
      await rejected(
        assertSafeAgentEndpoint('ws://internal.example.com', {
          ...dev,
          lookup: resolvesTo('10.0.0.1'),
        }),
      ),
    ).toBe(true);
  });

  it('rejects hosts that do not resolve', async () => {
    const lookup: HostLookup = () => Promise.reject(new Error('ENOTFOUND'));
    expect(
      await rejected(assertSafeAgentEndpoint('wss://nope.example.com', { ...production, lookup })),
    ).toBe(true);
  });
});
