import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  deviceRegistrationResponseSchema,
  generateSealKeyPair,
  MAX_SEAL_PLAINTEXT_BYTES,
  open,
  type MessagePush,
  type SealedEnvelope,
} from '@twring/contracts';
import {
  ApnsPushSender,
  FcmPushSender,
  RoutedPushSender,
  type ApnsTransport,
  type FetchFn,
} from '@twring/push';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { ManualScheduler, recordingLogger } from '../calls/testing';
import { startConnectorGateway, TEST_KEYS, type ConnectorGateway } from '../connectors/harness';
import { CredentialCipher } from '../store/cipher';
import { MemoryCollection } from '../store/collection';

import { RingService } from './service';
import {
  DeviceRepository,
  InviteRepository,
  RingSettingsRepository,
  type DeviceRecord,
  type RingStores,
} from './store';

/** Hosted message pushes sealed per phone (ADR-043 Phase B). */

const gateways: ConnectorGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()));
});

async function gateway() {
  const g = await startConnectorGateway({ ring: { push: false } });
  gateways.push(g);
  return g;
}

const phoneKeys = () => {
  const pair = generateSealKeyPair();
  return { ...pair, publicB64: base64urlEncode(pair.publicKey) };
};

const ANDROID = {
  fcm_token: 'fcm-token-sealedaaaaaaaaa',
  platform: 'android',
  app_variant: 'beta',
};

async function register(g: ConnectorGateway, body: Record<string, unknown>, user = 'alice') {
  return g.send('PUT', '/v1/me/devices/phone-seal-0001', { user, body });
}

describe('hosted device registration with a seal key', () => {
  it('stores the phone key and a sealed server key, and answers the server public key', async () => {
    const g = await gateway();
    const phone = phoneKeys();
    const res = await register(g, { ...ANDROID, seal_public_key: phone.publicB64 });
    expect(res.statusCode).toBe(200);
    const answer = deviceRegistrationResponseSchema.parse(res.json());
    expect(answer.seal_server_public_key).toBeDefined();

    const [row] = await g.ring!.stores.devices.list('alice');
    expect(row?.seal_public_key).toBe(phone.publicB64);
    expect(row?.server_seal_public_key).toBe(answer.seal_server_public_key);
    // The private half is kept only sealed.
    expect(row?.server_seal_private_key?.alg).toBe('aes-256-gcm');
    expect(JSON.stringify(row)).not.toMatch(/"server_seal_private_key":"/);
  });

  it('keeps the pair for the same key, replaces it for a new key', async () => {
    const g = await gateway();
    const phone = phoneKeys();
    const first = deviceRegistrationResponseSchema.parse(
      (await register(g, { ...ANDROID, seal_public_key: phone.publicB64 })).json(),
    );
    const again = deviceRegistrationResponseSchema.parse(
      (await register(g, { ...ANDROID, seal_public_key: phone.publicB64 })).json(),
    );
    expect(again.seal_server_public_key).toBe(first.seal_server_public_key);

    const next = phoneKeys();
    const replaced = deviceRegistrationResponseSchema.parse(
      (await register(g, { ...ANDROID, seal_public_key: next.publicB64 })).json(),
    );
    expect(replaced.seal_server_public_key).not.toBe(first.seal_server_public_key);
    const rows = await g.ring!.stores.devices.list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seal_public_key).toBe(next.publicB64);
  });

  it('a registration without a key removes the stored pair (204, as before)', async () => {
    const g = await gateway();
    await register(g, { ...ANDROID, seal_public_key: phoneKeys().publicB64 });
    const res = await register(g, ANDROID);
    expect(res.statusCode).toBe(204);
    const [row] = await g.ring!.stores.devices.list('alice');
    expect(row).toBeDefined();
    expect(row?.seal_public_key).toBeUndefined();
    expect(row?.server_seal_public_key).toBeUndefined();
    expect(row?.server_seal_private_key).toBeUndefined();
  });

  it('refuses a malformed key', async () => {
    const g = await gateway();
    const res = await register(g, { ...ANDROID, seal_public_key: 'short' });
    expect(res.statusCode).toBe(400);
  });

  it('removing the device and Delete my data remove the keys', async () => {
    const g = await gateway();
    await register(g, { ...ANDROID, seal_public_key: phoneKeys().publicB64 });
    expect(
      (await g.send('DELETE', '/v1/me/devices/phone-seal-0001', { user: 'alice' })).statusCode,
    ).toBe(204);
    expect(await g.ring!.stores.devices.list('alice')).toEqual([]);

    await register(g, { ...ANDROID, seal_public_key: phoneKeys().publicB64 });
    expect((await g.send('DELETE', '/v1/me/data', { user: 'alice' })).statusCode).toBe(200);
    expect(await g.ring!.stores.devices.list('alice')).toEqual([]);
  });
});

const MESSAGE: MessagePush = {
  type: 'cord.message',
  user_ref: '0123456789abcdef',
  agent_id: `agt_${'a'.repeat(20)}`,
  agent_name: 'Hermes',
  message_id: `msg_${'a'.repeat(20)}`,
  preview: 'Done. All tests pass.',
  silent: '0',
};

const NOW = Date.parse('2026-11-24T10:00:00.000Z');

function stores(cipher = new CredentialCipher(TEST_KEYS)): RingStores {
  return {
    devices: new DeviceRepository(
      new MemoryCollection<DeviceRecord>(),
      cipher,
      () => new Date(NOW),
    ),
    settings: new RingSettingsRepository(new MemoryCollection()),
    invites: new InviteRepository(new MemoryCollection()),
  };
}

function service(ringStores: RingStores, push: RoutedPushSender) {
  const logger = recordingLogger();
  const s = new RingService({
    stores: ringStores,
    history: {
      record: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
      deleteAllForUser: () => Promise.resolve(0),
      usageRollup: () => Promise.resolve([]),
    },
    push,
    inCall: () => false,
    scheduler: new ManualScheduler(),
    now: () => new Date(NOW),
    logger,
  });
  return { s, logger };
}

/** The real FCM and APNs senders, with the network faked. */
function senders() {
  const fcmBodies: Record<string, string>[] = [];
  const fetch: FetchFn = (url, init) => {
    if (url.includes('oauth2')) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 }), { status: 200 }),
      );
    }
    const parsed = JSON.parse(init.body as string) as { message: { data: Record<string, string> } };
    fcmBodies.push(parsed.message.data);
    return Promise.resolve(new Response('{"name":"m"}', { status: 200 }));
  };
  const apnsRequests: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const transport: ApnsTransport = {
    post: (_host, _path, headers, body) => {
      apnsRequests.push({ headers, body: JSON.parse(body) as Record<string, unknown> });
      return Promise.resolve({ status: 200, body: '' });
    },
    close: () => undefined,
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const push = new RoutedPushSender({
    android: new FcmPushSender({
      account: {
        project_id: 'twring-test',
        client_email: 'push@twring-test.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      },
      fetch,
      retryDelayMs: 0,
    }),
    ios: new ApnsPushSender(
      {
        keyPem,
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        bundleId: 'com.twring.app',
        environment: 'sandbox',
      },
      transport,
      { retryDelayMs: 0 },
    ),
  });
  return { push, fcmBodies, apnsRequests };
}

async function keyedDevice(
  ringStores: RingStores,
  deviceId: string,
  platform: 'android' | 'ios',
): Promise<Uint8Array> {
  const phone = phoneKeys();
  const serverKey = await ringStores.devices.upsert({
    fcm_token: `fcm-token-${deviceId}aaaaaaaaaa`,
    platform,
    app_variant: 'beta',
    ...(platform === 'ios' && { apns_token: 'b'.repeat(64) }),
    seal_public_key: phone.publicB64,
    user_id: 'alice',
    device_id: deviceId,
    updated_at: new Date(NOW).toISOString(),
  });
  return deriveSealKey(phone.privateKey, base64urlDecode(serverKey!));
}

function opened(key: Uint8Array, sealed: string): Record<string, unknown> {
  const plaintext = open(key, JSON.parse(sealed) as SealedEnvelope);
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

describe('hosted message pushes', () => {
  it('an Android phone with a key gets a data-only sealed push it can open', async () => {
    const ringStores = stores();
    const key = await keyedDevice(ringStores, 'phone-android-01', 'android');
    const { push, fcmBodies } = senders();
    const { s, logger } = service(ringStores, push);

    expect(await s.pushMessage('alice', MESSAGE)).toBe(1);
    expect(fcmBodies).toHaveLength(1);
    const data = fcmBodies[0]!;
    // Outside the seal: only the redacted push's routing ids, for the "New message" fallback.
    expect(Object.keys(data).sort()).toEqual([
      'agent_id',
      'kind',
      'message_id',
      'sealed',
      'silent',
      'type',
      'user_ref',
    ]);
    expect(data).toMatchObject({ type: 'cord.sealed', kind: 'message' });
    expect(JSON.stringify(data)).not.toContain('Hermes');
    expect(JSON.stringify(data)).not.toContain('All tests pass');
    expect(opened(key, data.sealed!)).toMatchObject({
      type: 'cord.message',
      kind: 'message',
      id: MESSAGE.message_id,
      agent_name: 'Hermes',
      preview: 'Done. All tests pass.',
      issued_at: new Date(NOW).toISOString(),
    });
    // Logs carry no key, preview or envelope.
    const logged = JSON.stringify(logger.events);
    expect(logged).not.toContain('All tests pass');
    expect(logged).not.toContain(data.sealed!.slice(10, 40));
    s.close();
  });

  it('an iPhone with a key gets the fixed alert, mutable, with the envelope', async () => {
    const ringStores = stores();
    const key = await keyedDevice(ringStores, 'phone-ios-0001', 'ios');
    const { push, apnsRequests } = senders();
    const { s } = service(ringStores, push);

    await s.pushMessage('alice', MESSAGE);
    expect(apnsRequests).toHaveLength(1);
    const { headers, body } = apnsRequests[0]!;
    expect(headers['apns-collapse-id']).toBe(MESSAGE.message_id);
    expect(body).toMatchObject({
      aps: { alert: { body: 'New message' }, 'mutable-content': 1 },
      type: 'cord.message',
      message_id: MESSAGE.message_id,
    });
    expect(body).not.toHaveProperty('agent_name');
    expect(opened(key, body.sealed as string)).toMatchObject({ agent_name: 'Hermes' });
    s.close();
  });

  it('a phone without a key gets the redacted push', async () => {
    const ringStores = stores();
    await ringStores.devices.upsert({
      fcm_token: 'fcm-token-oldphoneaaaaaaaaaa',
      platform: 'android',
      app_variant: 'beta',
      user_id: 'alice',
      device_id: 'phone-old-00001',
      updated_at: new Date(NOW).toISOString(),
    });
    const { push, fcmBodies } = senders();
    const { s } = service(ringStores, push);
    await s.pushMessage('alice', MESSAGE);
    expect(fcmBodies[0]).toMatchObject({ type: 'cord.message', preview: 'New message' });
    expect(fcmBodies[0]).not.toHaveProperty('sealed');
    s.close();
  });

  it('a server key that cannot be opened still sends the redacted push', async () => {
    const writer = stores();
    await keyedDevice(writer, 'phone-android-02', 'android');
    const rows = await writer.devices.list('alice');
    // The store keys changed: the sealed server key no longer opens.
    const otherKeys = {
      currentVersion: 1,
      keys: new Map([[1, Buffer.alloc(32, 9).toString('base64')]]),
    };
    const collection = new MemoryCollection<DeviceRecord>();
    await collection.update(() => ({ items: rows, result: undefined }));
    const reader: RingStores = {
      ...stores(),
      devices: new DeviceRepository(collection, new CredentialCipher(otherKeys)),
    };
    const { push, fcmBodies } = senders();
    const { s } = service(reader, push);
    expect(await s.pushMessage('alice', MESSAGE)).toBe(1);
    expect(fcmBodies).toEqual([
      expect.objectContaining({ type: 'cord.message', preview: 'New message' }),
    ]);
    s.close();
  });

  it('a very long name and a 4,000-character message are trimmed to fit, never skipped', async () => {
    const ringStores = stores();
    const key = await keyedDevice(ringStores, 'phone-android-03', 'android');
    const { push, fcmBodies } = senders();
    const { s } = service(ringStores, push);
    const long: MessagePush = {
      ...MESSAGE,
      agent_name: 'N'.repeat(500),
      preview: 'x'.repeat(4000),
    };
    expect(await s.pushMessage('alice', long)).toBe(1);
    const data = fcmBodies[0]!;
    expect(data.type).toBe('cord.sealed');
    const inner = opened(key, data.sealed!);
    expect(inner).toMatchObject({ id: MESSAGE.message_id, kind: 'message' });
    expect(new TextEncoder().encode(JSON.stringify(inner)).length).toBeLessThanOrEqual(
      MAX_SEAL_PLAINTEXT_BYTES,
    );
    expect((inner.preview as string).length).toBeLessThan(4000);
    s.close();
  });

  it('concurrent registrations for one device leave the pair the last answer gave', async () => {
    const ringStores = stores();
    const phones = [phoneKeys(), phoneKeys(), phoneKeys()];
    const answers = await Promise.all(
      phones.map((phone) =>
        ringStores.devices.upsert({
          ...ANDROID,
          platform: 'android',
          seal_public_key: phone.publicB64,
          user_id: 'alice',
          device_id: 'phone-race-0001',
          updated_at: new Date(NOW).toISOString(),
        }),
      ),
    );
    const rows = await ringStores.devices.list('alice');
    expect(rows).toHaveLength(1);
    const index = phones.findIndex((p) => p.publicB64 === rows[0]!.seal_public_key);
    expect(index).toBeGreaterThanOrEqual(0);
    // The stored server key is the one answered to the phone whose key is stored.
    expect(rows[0]!.server_seal_public_key).toBe(answers[index]);
  });
});
