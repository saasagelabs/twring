import {
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  type E2eDevice,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import {
  CAP_HINT,
  devicesState,
  listDevices,
  reconcileTrusted,
  removeCopy,
  removeDevice,
  syncTrusted,
} from './devices';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';
import { createPhoneContext, sealOutgoing } from './sealed-thread';
import { memoryStore } from './test-fixtures';

const CON = `con_${'a'.repeat(20)}`;
const at = '2026-11-20T10:00:00.000Z';

function device(kind: 'phone' | 'computer', extra: Partial<E2eDevice> = {}): E2eDevice {
  const pub = generateSealKeyPair().publicKey;
  return {
    id: deviceIdFor(pub),
    kind,
    name: kind === 'phone' ? 'Pixel' : 'Laptop',
    public_key: base64urlEncode(pub),
    added_at: at,
    ...extra,
  };
}
const trustedOf = (d: E2eDevice, connector?: string): TrustedDevice => ({
  id: d.id,
  kind: d.kind,
  name: d.name,
  public_key: d.public_key,
  verified_at: at,
  ...(connector !== undefined && { connector_id: connector }),
});
const fakeApi = (devices: E2eDevice[]) => ({ list: () => Promise.resolve({ devices }) });
const five = () => [
  device('phone'),
  device('phone'),
  device('computer'),
  device('computer'),
  device('phone'),
];

describe('devices screen (Task 26)', () => {
  it('blocks adding a sixth device with a clear next step', async () => {
    const s = await devicesState(fakeApi(five()));
    expect(s.canAdd).toBe(false);
    expect(s.hint).toBe('Remove a device to add a new one.');
    expect(s.count).toBe('5 of 5 devices');
  });

  it('shows active devices with kind, added date and this phone; revoked ones are left out', async () => {
    const me = device('phone');
    const gone = device('phone', { revoked_at: '2026-11-21T00:00:00.000Z' });
    const s = await devicesState(fakeApi([me, device('computer'), gone]), me.id);
    expect(s.canAdd).toBe(true);
    expect(s.hint).toBeUndefined();
    expect(s.count).toBe('2 of 5 devices');
    expect(s.devices.map((d) => [d.kind, d.thisPhone, d.added])).toEqual([
      ['Phone', true, '2026-11-20'],
      ['Computer', false, '2026-11-20'],
    ]);
    expect(CAP_HINT).toBe('Remove a device to add a new one.');
  });

  it('refuses an answer that is not a device list', async () => {
    await expect(
      listDevices({ list: () => Promise.resolve({ devices: [{ id: 'x' }] }) }),
    ).rejects.toThrow();
  });

  it('asks in plain words before removing', () => {
    expect(removeCopy({ name: 'Pixel', kind: 'Phone', thisPhone: true }).body).toContain(
      'forgets its private chat keys',
    );
    expect(removeCopy({ name: 'Laptop', kind: 'Computer', thisPhone: false }).body).toContain(
      'stop until you pair it again',
    );
  });
});

describe('removing a device (Task 30, P4 rulings 1 and 3)', () => {
  it('stops wrapping to a removed phone at once', async () => {
    const store = memoryStore();
    const computer = device('computer');
    const phone2 = device('phone');
    await saveTrusted(store, [trustedOf(computer, CON), trustedOf(phone2)]);
    const removed: string[] = [];
    await removeDevice(
      {
        api: { remove: (id) => Promise.resolve(void removed.push(id)) },
        store,
        forgetSelf: () => Promise.reject(new Error('not this phone')),
      },
      phone2.id,
    );
    expect(removed).toEqual([phone2.id]);
    const me = generateSealKeyPair();
    let seq = 0;
    const ctx = createPhoneContext({
      accountId: CON,
      agentId: 'claude-code',
      me: { deviceId: deviceIdFor(me.publicKey), ...me },
      trusted: await loadTrusted(store),
      nextSeq: () => ++seq,
    });
    const env = sealOutgoing(ctx, { text: 'x' });
    expect(env.keys.map((k) => k.device)).not.toContain(phone2.id);
    expect(env.keys.map((k) => k.device)).toContain(computer.id);
  });

  it('removing this phone goes through the forget path', async () => {
    const store = memoryStore();
    let forgot = 0;
    await removeDevice(
      {
        api: { remove: () => Promise.resolve() },
        store,
        selfId: 'dev_me',
        forgetSelf: () => Promise.resolve(void forgot++),
      },
      'dev_me',
    );
    expect(forgot).toBe(1);
  });

  it('keeps everything when the server refuses the removal', async () => {
    const store = memoryStore();
    const phone2 = device('phone');
    await saveTrusted(store, [trustedOf(phone2)]);
    await expect(
      removeDevice(
        {
          api: { remove: () => Promise.reject(new Error('offline')) },
          store,
          forgetSelf: () => Promise.resolve(),
        },
        phone2.id,
      ),
    ).rejects.toThrow();
    expect((await loadTrusted(store)).map((d) => d.id)).toEqual([phone2.id]);
  });

  it('drops devices the server marks revoked whenever it reads the list', async () => {
    const store = memoryStore();
    const computer = device('computer');
    const phone2 = device('phone');
    await saveTrusted(store, [trustedOf(computer, CON), trustedOf(phone2)]);
    const after = await syncTrusted(store, [
      { ...computer, connector_id: CON },
      { ...phone2, revoked_at: '2026-11-25T00:00:00.000Z' },
    ]);
    expect(after.map((d) => d.id)).toEqual([computer.id]);
    expect((await loadTrusted(store)).map((d) => d.id)).toEqual([computer.id]);
  });

  it('a revoked device re-listed active by a hostile server is not trusted again', async () => {
    const store = memoryStore();
    const computer = device('computer');
    const phone2 = device('phone');
    await saveTrusted(store, [trustedOf(computer, CON), trustedOf(phone2)]);
    await syncTrusted(store, [{ ...phone2, revoked_at: '2026-11-25T00:00:00.000Z' }]);
    const again = await syncTrusted(store, [phone2, { ...computer, connector_id: CON }]);
    expect(again.map((d) => d.id)).toEqual([computer.id]);
  });

  it('a device missing from the list is never dropped', () => {
    const phone2 = device('phone');
    expect(reconcileTrusted([trustedOf(phone2)], []).trusted).toHaveLength(1);
  });
});

describe('binding older computers (ruling)', () => {
  it('binds an unbound computer from the list only when id and key match', () => {
    const computer = device('computer');
    const swapped = { ...computer, public_key: device('computer').public_key, connector_id: CON };
    expect(
      reconcileTrusted([trustedOf(computer)], [swapped]).trusted[0].connector_id,
    ).toBeUndefined();
    const out = reconcileTrusted([trustedOf(computer)], [{ ...computer, connector_id: CON }]);
    expect(out.trusted[0].connector_id).toBe(CON);
    expect(out.bound).toBe(1);
  });

  it('never rebinds a computer that already has a connector id', () => {
    const computer = device('computer');
    const other = `con_${'b'.repeat(20)}`;
    const out = reconcileTrusted(
      [trustedOf(computer, CON)],
      [{ ...computer, connector_id: other }],
    );
    expect(out.trusted[0].connector_id).toBe(CON);
  });
});
