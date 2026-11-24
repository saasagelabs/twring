import { describe, expect, it } from 'vitest';

import { loadOrCreateDeviceKey, nextSeq } from './device-key';
import { confirmPairing, loadTrusted, type TrustedDevice } from './pairing';
import { forgetPrivateDevice } from './private-chats';
import { scopedKeychain } from './scoped-keychain';
import { memoryStore } from './test-fixtures';

const computer: TrustedDevice = {
  id: 'dev_' + 'a'.repeat(20),
  kind: 'computer',
  name: 'Computer',
  public_key: 'A'.repeat(43),
  verified_at: '2026-11-25T00:00:00.000Z',
};

describe('private chat keys per server and account (P3c ruling 1)', () => {
  it('two scopes never see each other key, counter or trusted computers', async () => {
    const phone = memoryStore();
    const a = scopedKeychain(phone, 'hosted:user-a');
    const b = scopedKeychain(phone, 'selfhost:srv:person-b');
    const keyA = await loadOrCreateDeviceKey(a);
    const keyB = await loadOrCreateDeviceKey(b);
    expect(keyB.created).toBe(true);
    expect(keyB.deviceId).not.toBe(keyA.deviceId);
    expect(await nextSeq(a)).toBe(1);
    expect(await nextSeq(a)).toBe(2);
    expect(await nextSeq(b)).toBe(1);
    await confirmPairing({ store: a }, computer);
    expect(await loadTrusted(a)).toHaveLength(1);
    expect(await loadTrusted(b)).toEqual([]);
  });

  it('key names are valid keychain keys and never carry the scope itself', async () => {
    const phone = memoryStore();
    await loadOrCreateDeviceKey(scopedKeychain(phone, 'hosted:user@example.com'));
    for (const name of phone.m.keys()) {
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(name).not.toContain('example');
    }
  });

  it('sign-out of one scope leaves the other intact', async () => {
    const phone = memoryStore();
    const a = scopedKeychain(phone, 'hosted:user-a');
    const b = scopedKeychain(phone, 'hosted:user-b');
    await loadOrCreateDeviceKey(a);
    const keyB = await loadOrCreateDeviceKey(b);
    await nextSeq(b);
    await confirmPairing({ store: b }, computer);
    await nextSeq(a);
    await confirmPairing({ store: a }, computer);
    await forgetPrivateDevice(a);
    expect(await loadTrusted(a)).toEqual([]);
    expect((await loadOrCreateDeviceKey(b)).deviceId).toBe(keyB.deviceId);
    expect(await nextSeq(b)).toBe(2);
    expect(await loadTrusted(b)).toHaveLength(1);
  });

  it('the same scope gets the same keychain, so its counter lock is shared', () => {
    const phone = memoryStore();
    expect(scopedKeychain(phone, 's')).toBe(scopedKeychain(phone, 's'));
  });
});
