import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  MAX_SEAL_PLAINTEXT_BYTES,
  open,
  type MessagePush,
  type RelayPushRequest,
} from '@twring/contracts';
import { describe, expect, it } from 'vitest';

import { ManualScheduler, recordingLogger } from '../calls/testing';
import { RingService } from '../ring/service';
import {
  DeviceRepository,
  InviteRepository,
  RingSettingsRepository,
  type RingStores,
} from '../ring/store';
import { MemoryCollection } from '../store/collection';
import { CredentialCipher } from '../store/cipher';

import { createSelfhostMemoryStores, type PairedDeviceRecord } from './people';
import type { RelayPushResult } from './relay-client';
import { relayRingPhones, RelayPushSender } from './relay-push';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 3).toString('base64')]]) };
const cipher = new CredentialCipher(keys);
const NOW = Date.parse('2026-10-29T10:00:00.000Z');

async function setup(outcomes: Partial<Record<string, RelayPushResult>> = {}) {
  const stores = createSelfhostMemoryStores(cipher);
  const person = await stores.people.create({
    displayName: 'Asha',
    role: 'admin',
    spaceId: 'default',
  });
  const phones: { device: PairedDeviceRecord; phonePrivate: Uint8Array }[] = [];
  for (const [name, handle] of [
    ['Pixel', 'hdl_pixel'],
    ['iPhone', 'hdl_iphone'],
    ['Old', undefined],
  ] as const) {
    const pair = generateSealKeyPair();
    const { device } = await stores.devices.create({
      personId: person.id,
      name,
      platform: name === 'iPhone' ? 'ios' : 'android',
      sealPublicKey: base64urlEncode(pair.publicKey),
    });
    if (handle !== undefined) await stores.devices.setRelayHandle(device.id, handle);
    phones.push({ device, phonePrivate: pair.privateKey });
  }
  const sent: RelayPushRequest[] = [];
  const states: string[] = [];
  const relay = {
    push: (request: RelayPushRequest): Promise<RelayPushResult> => {
      sent.push(request);
      return Promise.resolve(outcomes[request.handle] ?? 'sent');
    },
  };
  const push = new RelayPushSender({
    relay,
    devices: stores.devices,
    cipher,
    now: () => new Date(NOW),
    onRingState: (state) => states.push(state),
  });
  const ringStores: RingStores = {
    devices: new DeviceRepository(new MemoryCollection()),
    settings: new RingSettingsRepository(new MemoryCollection()),
    invites: new InviteRepository(new MemoryCollection()),
  };
  const logger = recordingLogger();
  const service = new RingService({
    stores: ringStores,
    push,
    phones: relayRingPhones(stores.devices),
    requireRingPhone: true,
    ringPlatforms: ['android', 'ios'],
    inCall: () => false,
    scheduler: new ManualScheduler(),
    now: () => new Date(NOW),
    logger,
  });
  /** Opens a push the way the phone does: its private key and the server's public key. */
  const openFor = (request: RelayPushRequest): Record<string, unknown> => {
    const phone = phones.find((p) => p.device.id === deviceFor(request.handle))!;
    const key = deriveSealKey(
      phone.phonePrivate,
      base64urlDecode(phone.device.server_seal_public_key),
    );
    return JSON.parse(new TextDecoder().decode(open(key, request.sealed))) as Record<
      string,
      unknown
    >;
  };
  const deviceFor = (handle: string) =>
    phones.find((_p, i) => ['hdl_pixel', 'hdl_iphone'][i] === handle)!.device.id;
  const ring = async () => {
    const result = await service.ring({
      userId: person.id,
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Laptop Claude',
      reason: 'The build failed',
    });
    if (!('invite' in result)) throw new Error(`refused: ${result.refused}`);
    await service.idle();
    return result.invite;
  };
  return { stores, person, phones, sent, states, service, ring, openFor, push, logger };
}

describe('RelayPushSender through the ring service', () => {
  it('a ring sends one sealed relay push per phone with a handle; the phone opens it', async () => {
    const { sent, ring, openFor } = await setup();
    const invite = await ring();
    expect(sent.map((r) => r.handle).sort()).toEqual(['hdl_iphone', 'hdl_pixel']);
    for (const request of sent) {
      expect(request.kind).toBe('ring');
      expect(request.priority).toBe('high');
      expect(JSON.stringify(request)).not.toContain('Laptop Claude');
      expect(JSON.stringify(request)).not.toContain('The build failed');
      const opened = openFor(request);
      expect(opened).toMatchObject({
        type: 'cord.ring',
        invite_id: invite.id,
        agent_name: 'Laptop Claude',
        reason: 'The build failed',
        kind: 'ring',
        id: invite.id,
        issued_at: new Date(NOW).toISOString(),
      });
    }
  });

  it('a phone sealed for one device does not open with another phone key', async () => {
    const { sent, ring, phones } = await setup();
    await ring();
    const pixelRequest = sent.find((r) => r.handle === 'hdl_pixel')!;
    const iphone = phones[1]!;
    const wrongKey = deriveSealKey(
      iphone.phonePrivate,
      base64urlDecode(iphone.device.server_seal_public_key),
    );
    expect(() => open(wrongKey, pixelRequest.sealed)).toThrow();
  });

  it('a person whose only phone has no handle is refused no_ring_phone at once', async () => {
    const { stores, service, sent } = await setup();
    const lone = await stores.people.create({
      displayName: 'Lo',
      role: 'member',
      spaceId: 'default',
    });
    await stores.devices.create({
      personId: lone.id,
      name: 'New',
      platform: 'android',
      sealPublicKey: base64urlEncode(generateSealKeyPair().publicKey),
    });
    const result = await service.ring({
      userId: lone.id,
      agentId: `agt_${'a'.repeat(20)}`,
      agentName: 'Laptop Claude',
      reason: 'x',
    });
    expect(result).toEqual({ refused: 'no_ring_phone' });
    expect(sent).toHaveLength(0);
  });

  it('a phone that lost its handle after listing is skipped', async () => {
    const { push, phones } = await setup();
    expect(
      await push.send(
        { token: phones[2]!.device.id, platform: 'android' },
        { type: 'cord.ring_cancel', invite_id: `inv_${'a'.repeat(26)}`, status: 'answered' },
      ),
    ).toBe('skipped');
  });

  it('a handle another phone holds is refused, so a ring is never sealed to the wrong phone', async () => {
    const { stores, phones, person } = await setup();
    const other = await stores.people.create({
      displayName: 'B',
      role: 'member',
      spaceId: 'default',
    });
    const { device } = await stores.devices.create({
      personId: other.id,
      name: 'B',
      platform: 'android',
      sealPublicKey: base64urlEncode(generateSealKeyPair().publicKey),
    });
    expect(await stores.devices.setRelayHandle(device.id, 'hdl_pixel')).toBe('taken');
    expect((await stores.devices.get(device.id))?.relay_handle).toBeUndefined();
    // The same phone sending its own handle again is fine.
    expect(await stores.devices.setRelayHandle(phones[0]!.device.id, 'hdl_pixel')).toBe('set');
    expect(person.id).not.toBe(other.id);
  });

  it('the push is sealed for the device named in the target, found by id', async () => {
    const { push, sent, openFor, phones } = await setup();
    await push.send(
      { token: phones[1]!.device.id, platform: 'ios' },
      { type: 'cord.ring_cancel', invite_id: `inv_${'a'.repeat(26)}`, status: 'answered' },
    );
    expect(sent[0]!.handle).toBe('hdl_iphone');
    expect(openFor(sent[0]!)).toMatchObject({ kind: 'ring_cancel' });
  });

  it('an invalid for an old handle does not clear the handle the phone sent since', async () => {
    const { stores, phones, person } = await setup();
    const listed = await relayRingPhones(stores.devices)(person.id);
    await stores.devices.setRelayHandle(phones[0]!.device.id, 'hdl_pixel_new');
    const pixel = listed.find((p) => p.target.token === phones[0]!.device.id)!;
    await pixel.forget();
    expect((await stores.devices.get(phones[0]!.device.id))?.relay_handle).toBe('hdl_pixel_new');
    expect(await stores.devices.clearRelayHandle(phones[0]!.device.id, 'hdl_pixel')).toBe(false);
  });

  it('relay invalid clears that phone handle only', async () => {
    const { stores, ring, phones } = await setup({ hdl_pixel: 'invalid' });
    await ring();
    expect((await stores.devices.get(phones[0]!.device.id))?.relay_handle).toBeUndefined();
    expect((await stores.devices.get(phones[1]!.device.id))?.relay_handle).toBe('hdl_iphone');
  });

  it.each(['paused', 'expired'] as const)('relay %s records the ring service state', async (s) => {
    const { ring, states, stores, phones } = await setup({ hdl_pixel: s, hdl_iphone: s });
    await ring();
    expect(states).toContain(s);
    expect((await stores.devices.get(phones[0]!.device.id))?.relay_handle).toBe('hdl_pixel');
  });

  it('relay failed keeps the handle', async () => {
    const { ring, stores, phones } = await setup({ hdl_pixel: 'failed' });
    await ring();
    expect((await stores.devices.get(phones[0]!.device.id))?.relay_handle).toBe('hdl_pixel');
  });

  it('a missed ring goes as missed_call, an ended ring as ring_cancel', async () => {
    const { push, sent, openFor, phones } = await setup();
    const id = `inv_${'b'.repeat(26)}`;
    await push.send(
      { token: phones[0]!.device.id, platform: 'android' },
      { type: 'cord.ring_cancel', invite_id: id, status: 'missed', agent_name: 'Laptop Claude' },
    );
    await push.send(
      { token: phones[0]!.device.id, platform: 'android' },
      { type: 'cord.ring_cancel', invite_id: id, status: 'answered' },
    );
    expect(sent.map((r) => r.kind)).toEqual(['missed_call', 'ring_cancel']);
    expect(openFor(sent[0]!)).toMatchObject({ kind: 'missed_call', id, status: 'missed' });
  });

  it('a long message is trimmed to fit the seal, never thrown', async () => {
    const { push, sent, openFor, phones } = await setup();
    const message: MessagePush = {
      type: 'cord.message',
      user_ref: '0123456789abcdef',
      agent_id: `agt_${'a'.repeat(20)}`,
      agent_name: 'N'.repeat(3000),
      message_id: `msg_${'c'.repeat(26)}`,
      preview: 'p'.repeat(120),
      silent: '0',
    };
    expect(
      await push.send({ token: phones[0]!.device.id, platform: 'android' }, message, {
        priority: 'normal',
        ttlSeconds: 86400,
      }),
    ).toBe('sent');
    const request = sent[0]!;
    expect(request).toMatchObject({ kind: 'message', priority: 'normal', ttl_seconds: 3600 });
    const opened = openFor(request);
    expect(opened).toMatchObject({ kind: 'message', id: message.message_id });
    expect(new TextEncoder().encode(JSON.stringify(opened)).length).toBeLessThanOrEqual(
      MAX_SEAL_PLAINTEXT_BYTES,
    );
  });

  it('a removed phone loses its handle and gets no more sealed pushes', async () => {
    const { stores, ring, sent, phones } = await setup();
    await stores.devices.remove(phones[0]!.device.id);
    expect((await stores.devices.get(phones[0]!.device.id))?.relay_handle).toBeUndefined();
    await ring();
    expect(sent.map((r) => r.handle)).toEqual(['hdl_iphone']);
  });

  it('a removed person loses every handle; Delete my data likewise', async () => {
    const { stores, person, phones } = await setup();
    const dropped: string[] = [];
    stores.devices.onRelayHandlesDropped((handles) => dropped.push(...handles));
    await stores.devices.removeAllFor(person.id);
    for (const phone of phones) {
      expect((await stores.devices.get(phone.device.id))?.relay_handle).toBeUndefined();
    }
    expect(dropped.sort()).toEqual(['hdl_iphone', 'hdl_pixel']);
    await stores.devices.deleteAllFor(person.id);
    expect(dropped).toHaveLength(2);
  });

  it('Delete my data drops the handles of phones still paired', async () => {
    const { stores, person } = await setup();
    const dropped: string[] = [];
    stores.devices.onRelayHandlesDropped((handles) => dropped.push(...handles));
    await stores.devices.deleteAllFor(person.id);
    expect(dropped.sort()).toEqual(['hdl_iphone', 'hdl_pixel']);
  });
});
