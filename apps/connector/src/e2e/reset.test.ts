import { describe, expect, it } from 'vitest';

import type { ConnectorConfig } from '../config';
import { ensureDeviceKey } from './keys';
import { resetLines, resetPrivateKey } from './reset';
import { baseConfig } from './test-fixtures';

const paired = (): ConnectorConfig => {
  const { config } = ensureDeviceKey(baseConfig);
  return {
    ...config,
    e2e: {
      ...config.e2e!,
      devices: [
        {
          id: `dev_${'p'.repeat(20)}`,
          kind: 'phone',
          name: 'Pixel',
          public_key: `${'p'.repeat(42)}A`,
          verified_at: '2026-11-24T00:00:00.000Z',
        },
      ],
      seq: 9,
    },
  };
};

describe('twring-connect private reset', () => {
  it('makes a new key, forgets trusted phones, and removes the old device on the server', async () => {
    const before = paired();
    const saved: ConnectorConfig[] = [];
    const calls: { url: string; method?: string; auth?: string }[] = [];
    const out = await resetPrivateKey({
      config: before,
      save: (c) => Promise.resolve(void saved.push(c)),
      fetch: ((url: string, init?: RequestInit) => {
        calls.push({
          url,
          method: init?.method,
          auth: (init?.headers as Record<string, string>).authorization,
        });
        return Promise.resolve(new Response(null, { status: 204 }));
      }) as typeof fetch,
    });
    expect(out.server).toBe('removed');
    expect(saved).toHaveLength(1);
    const e2e = saved[0]!.e2e!;
    expect(e2e.device_id).not.toBe(before.e2e!.device_id);
    expect(e2e.private_key).not.toBe(before.e2e!.private_key);
    expect(e2e.devices).toEqual([]);
    expect(calls).toEqual([
      {
        url: `https://api.twring.com/v1/e2e/computer/devices/${before.e2e!.device_id}`,
        method: 'DELETE',
        auth: `Bearer ${before.token}`,
      },
    ]);
  });

  it('still makes the new key when Twring cannot be reached, and says what to do', async () => {
    const out = await resetPrivateKey({
      config: paired(),
      save: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error('offline')),
    });
    expect(out.server).toBe('not_removed');
    expect(out.config.e2e).toBeDefined();
    const text = resetLines(out.server, 'twring-connect').join('\n');
    expect(text).toContain('remove the old computer under Devices');
    expect(text).toContain('node twring-connect.mjs private pair');
    expect(text).not.toContain('npx');
  });

  it('a crash while saving never reaches the server: the old device stays until the next try', async () => {
    let called = false;
    await expect(
      resetPrivateKey({
        config: paired(),
        save: () => Promise.reject(new Error('disk full')),
        fetch: () => {
          called = true;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      }),
    ).rejects.toThrow('disk full');
    expect(called).toBe(false);
  });

  it('private chats off on the server is not a removal', async () => {
    const out = await resetPrivateKey({
      config: paired(),
      save: () => Promise.resolve(),
      fetch: () =>
        Promise.resolve(Response.json({ error: { code: 'private_chats_off' } }, { status: 404 })),
    });
    expect(out.server).toBe('not_removed');
  });

  it('prints no key, old or new', async () => {
    const before = paired();
    const out = await resetPrivateKey({
      config: before,
      save: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    });
    expect(out.server).toBe('not_removed');
    const text = resetLines(out.server, 'twring-connect').join('\n');
    for (const secret of [before.e2e!.private_key, out.config.e2e!.private_key, before.token])
      expect(text).not.toContain(secret);
  });

  it('asks the server nothing when there was no key yet', async () => {
    let called = false;
    const out = await resetPrivateKey({
      config: baseConfig,
      save: () => Promise.resolve(),
      fetch: () => {
        called = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    expect(out.server).toBe('none');
    expect(called).toBe(false);
  });
});
