import { describe, expect, it } from 'vitest';

import { ensureDeviceKey, nextSeq } from './keys';
import { baseConfig } from './test-fixtures';

describe('connector device key', () => {
  it('creates a key once and keeps it', () => {
    const a = ensureDeviceKey(baseConfig);
    expect(a.created).toBe(true);
    expect(a.config.e2e!.device_id).toMatch(/^dev_[a-z2-7]{20}$/);
    expect(a.config.e2e!.devices).toEqual([]);
    const b = ensureDeviceKey(a.config);
    expect(b.created).toBe(false);
    expect(b.config.e2e!.public_key).toBe(a.config.e2e!.public_key);
    expect(b.config.e2e!.private_key).toBe(a.config.e2e!.private_key);
  });

  it('gives each install its own key', () => {
    expect(ensureDeviceKey(baseConfig).config.e2e!.public_key).not.toBe(
      ensureDeviceKey(baseConfig).config.e2e!.public_key,
    );
  });

  it('increments seq monotonically', () => {
    let c = ensureDeviceKey(baseConfig).config;
    const first = nextSeq(c);
    c = first.config;
    expect(first.seq).toBe(1);
    expect(nextSeq(c).seq).toBe(first.seq + 1);
  });

  it('refuses a seq without a device key', () => {
    expect(() => nextSeq(baseConfig)).toThrow();
  });
});
