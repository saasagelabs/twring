import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { E2eDeviceStore } from './devices-store';

const key = (n: number) => Buffer.alloc(32, n).toString('base64url');
const dev = (n: number) => ({
  id: `dev_${'abcdefghijklmnopqrstuvwxyz'[n]!.repeat(20)}`,
  kind: 'phone' as const,
  name: `Phone ${n}`,
  public_key: key(n),
});

describe('E2eDeviceStore', () => {
  let store: E2eDeviceStore;
  beforeEach(() => {
    store = new E2eDeviceStore(':memory:');
  });
  afterEach(() => store.close());

  it('adds and lists devices per account', () => {
    store.add('u1', dev(0));
    store.add('u2', dev(1));
    expect(store.list('u1').map((d) => d.id)).toEqual([dev(0).id]);
    expect(store.get('u1', dev(0).id)?.public_key).toBe(key(0));
    expect(store.get('u2', dev(0).id)).toBeUndefined();
  });
  it('refuses a sixth active device', () => {
    for (let i = 0; i < 5; i++) store.add('u1', dev(i));
    expect(() => store.add('u1', dev(5))).toThrow(/device_cap/);
  });
  it('frees a slot on revoke and hides the revoked device', () => {
    for (let i = 0; i < 5; i++) store.add('u1', dev(i));
    expect(store.revoke('u1', dev(0).id)).toBe(true);
    expect(store.revoke('u1', dev(0).id)).toBe(false);
    store.add('u1', dev(5));
    expect(store.list('u1')).toHaveLength(5);
    expect(store.get('u1', dev(0).id)).toBeUndefined();
  });
  it('removes everything on account delete', () => {
    store.add('u1', dev(0));
    expect(store.deleteAllForUser('u1')).toBe(1);
    expect(store.list('u1')).toEqual([]);
  });
  it('refuses a public key already active on the account', () => {
    store.add('u1', dev(0));
    expect(() => store.add('u1', { ...dev(1), public_key: key(0) })).toThrow(/duplicate_key/);
  });
  it('re-adding the same device is a no-op, a revoked id never comes back', () => {
    const first = store.add('u1', dev(0));
    expect(store.add('u1', dev(0))).toEqual(first);
    expect(() => store.add('u1', { ...dev(0), public_key: key(9) })).toThrow(/device_conflict/);
    store.revoke('u1', dev(0).id);
    expect(() => store.add('u1', dev(0))).toThrow(/device_conflict/);
  });
  it('keeps pairing offers for one claim, scoped to the account', () => {
    const offer = store.createOffer('u1', {
      connectorId: 'con_1',
      connectorDeviceId: dev(2).id,
      connectorPublicKey: key(2),
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(store.offer('u2', offer.id)).toBeUndefined();
    const claim = {
      phone_device_id: dev(3).id,
      phone_public_key: key(3),
      phone_name: 'Pixel',
      mac: 'm',
    };
    expect(store.claimOffer('u1', offer.id, claim)).toBe('claimed');
    expect(store.claimOffer('u1', offer.id, claim)).toBe('already_claimed');
    expect(store.offer('u1', offer.id)?.claim).toEqual(claim);
  });
  it('migrates twice without losing rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'twring-e2e-'));
    try {
      const path = join(dir, 'e2e.db');
      const a = new E2eDeviceStore(path);
      a.add('u1', dev(0));
      a.close();
      const b = new E2eDeviceStore(path);
      expect(b.list('u1')).toHaveLength(1);
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
