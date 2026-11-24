import { base64urlEncode, deviceIdFor } from '@twring/contracts';
import { describe, expect, it, vi } from 'vitest';

import { memoryStore } from './test-fixtures';
import { forgetDeviceKey, loadOrCreateDeviceKey, nextSeq } from './device-key';

describe('phone device key', () => {
  it('creates once and reloads the same key', async () => {
    const s = memoryStore();
    const a = await loadOrCreateDeviceKey(s);
    const b = await loadOrCreateDeviceKey(s);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.deviceId).toBe(a.deviceId);
    expect(base64urlEncode(b.privateKey)).toBe(base64urlEncode(a.privateKey));
  });

  it('derives the device id from the public key, as the computer does', async () => {
    const key = await loadOrCreateDeviceKey(memoryStore());
    expect(key.deviceId).toBe(deviceIdFor(key.publicKey));
  });

  it('treats a corrupt stored value as no key, never as a crash, and logs no key', async () => {
    const s = memoryStore();
    s.m.set('twring.e2e.device.v1', '{bad');
    const log = vi.fn();
    const key = await loadOrCreateDeviceKey(s, log);
    expect(key.created).toBe(true);
    expect(log).toHaveBeenCalledWith('e2e_device_key_reset');
    expect(JSON.stringify(log.mock.calls)).not.toContain(base64urlEncode(key.privateKey));
  });

  it('a replaced key clears the trusted computers: they sealed to a phone that is gone', async () => {
    const s = memoryStore();
    s.m.set('twring.e2e.device.v1', '{bad');
    s.m.set('twring.e2e.trusted.v1', '[]');
    await loadOrCreateDeviceKey(s);
    expect(s.m.has('twring.e2e.trusted.v1')).toBe(false);
    // A first key on a fresh phone touches nothing else.
    const fresh = memoryStore();
    fresh.m.set('twring.e2e.trusted.v1', '[]');
    await loadOrCreateDeviceKey(fresh);
    expect(fresh.m.has('twring.e2e.trusted.v1')).toBe(true);
  });

  it('forgets on sign-out', async () => {
    const s = memoryStore();
    await loadOrCreateDeviceKey(s);
    await nextSeq(s);
    await forgetDeviceKey(s);
    expect(s.m.size).toBe(0);
  });

  it('hands out each seq once and saves it before use', async () => {
    const s = memoryStore();
    expect(await nextSeq(s)).toBe(1);
    expect(await nextSeq(s)).toBe(2);
    s.m.set('twring.e2e.seq.v1', 'junk');
    await expect(nextSeq(s)).rejects.toThrow();
  });
});
