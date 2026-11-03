import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '@twring/config/gateway';
import { RoutedPushSender } from '@twring/push';
import { afterEach, describe, expect, it } from 'vitest';

import { PairingBook } from '../connectors/pairing';

import { RelayClient, type RelayClientOptions } from './relay-client';
import { RelayPushSender } from './relay-push';
import { buildSelfhost, ringPushWiring, type SelfhostEnv } from './wiring';

const keys = { currentVersion: 1, keys: new Map([[1, Buffer.alloc(32, 5).toString('base64')]]) };
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function dir() {
  const d = await mkdtemp(join(tmpdir(), 'twring-wiring-'));
  dirs.push(d);
  return d;
}

function selfhostEnv(dataDir: string, keyFile: string): SelfhostEnv {
  return {
    TWRING_MODE: 'selfhost',
    TWRING_SERVER_KEY_FILE: keyFile,
    TWRING_ADMIN_TOKEN: 'a'.repeat(40),
    TWRING_AUDIO: 'own',
    TWRING_SPACE_ID: 'default',
    TWRING_RELAY_URL: 'https://relay.example.test',
    TWRING_RELAY_KEY_FILE: join(dataDir, 'relay.key'),
    CORD_DATA_DIR: dataDir,
    CORD_PUBLIC_URL: 'https://home.example.com',
    CORD_ENV: 'production',
  };
}

const built: RelayClientOptions[] = [];
const spy = (options: RelayClientOptions) => {
  built.push(options);
  return new RelayClient(options);
};

describe('buildSelfhost', () => {
  it('hosted mode builds nothing: no routes, no admin listener, no public pair routes', async () => {
    const d = await dir();
    const wiring = await buildSelfhost(
      { ...selfhostEnv(d, join(d, 'missing.key')), TWRING_MODE: 'hosted' },
      { keys, relayClient: spy },
    );
    expect(wiring).toBeUndefined();
    // Review Focus 4: hosted Twring never builds a relay client.
    expect(built).toEqual([]);
  });

  it('self-hosted mode pushes through the relay with the configured address and key file', async () => {
    const d = await dir();
    const keyFile = join(d, 'server.key');
    await writeFile(
      keyFile,
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    built.length = 0;
    const wiring = await buildSelfhost(selfhostEnv(d, keyFile), { keys, relayClient: spy });
    expect(built).toHaveLength(1);
    expect(built[0]!.baseUrl).toBe('https://relay.example.test');
    // Call audio from the relay must be wss:// outside development.
    expect(built[0]!.allowInsecureAudio).toBe(false);
    await writeFile(join(d, 'relay.key'), 'twr_secret\n');
    expect(await built[0]!.relayKey()).toBe('twr_secret');
    expect(wiring!.push).toBeInstanceOf(RelayPushSender);
    expect(wiring!.relay).toBeInstanceOf(RelayClient);
    expect(wiring!.routes.relayUrl).toBe('https://relay.example.test');
  });

  it('a 401 from the relay warns once and shows the ring service as unregistered', async () => {
    const d = await dir();
    const keyFile = join(d, 'server.key');
    await writeFile(
      keyFile,
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    built.length = 0;
    const warnings: string[] = [];
    const wiring = await buildSelfhost(selfhostEnv(d, keyFile), {
      keys,
      relayClient: spy,
      warn: (line) => warnings.push(line),
    });
    built[0]!.onUnregistered!();
    built[0]!.onUnregistered!();
    expect(warnings).toEqual([
      'This server is no longer registered with the ring service. Run twring register.',
    ]);
    expect(await wiring!.routes.ringService()).toEqual({ state: 'unregistered' });
  });

  it('self-hosted mode builds routes, public routes, the authenticator and the admin listener', async () => {
    const d = await dir();
    const keyFile = join(d, 'server.key');
    await writeFile(
      keyFile,
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }),
    );
    const wiring = await buildSelfhost(selfhostEnv(d, keyFile), { keys });
    expect(wiring).toBeDefined();
    expect([...wiring!.publicRoutes].sort()).toEqual(['/v1/pair', '/v1/server']);
    expect(typeof wiring!.authenticator).toBe('function');
    expect(wiring!.routes.serverName).toBe('home.example.com');
    const admin = wiring!.adminServer(new PairingBook());
    expect(admin).toBeDefined();
    const status = await admin.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: `Bearer ${selfhostEnv(d, keyFile).TWRING_ADMIN_TOKEN}` },
    });
    // The ring service as the routes report it, before the relay has ever answered.
    expect(status.json()).toMatchObject({ ring_service: await wiring!.routes.ringService() });
    await admin.close();
  });

  it.each([
    ['missing', undefined],
    ['garbled', 'not a key at all'],
    [
      'public-only',
      generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    ],
    [
      'not Ed25519',
      generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    ],
  ])('a %s server key file fails startup naming the setting and the path', async (_n, content) => {
    const d = await dir();
    const keyFile = join(d, 'server.key');
    if (content !== undefined) await writeFile(keyFile, content);
    const failure = await buildSelfhost(selfhostEnv(d, keyFile), { keys }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConfigError);
    const message = (failure as Error).message;
    expect(message).toContain('TWRING_SERVER_KEY_FILE');
    expect(message).toContain(keyFile);
    expect(message).not.toMatch(/ENOENT|DECODER/);
  });

  it('without the credentials key it fails startup with a config error', async () => {
    const d = await dir();
    await expect(
      buildSelfhost(selfhostEnv(d, join(d, 'x.key')), { keys: undefined }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('ringPushWiring', () => {
  const fcm = { send: () => Promise.resolve('sent' as const) };
  const routed = new RoutedPushSender({ android: fcm });

  it('hosted: FCM/APNs routed sender, ring push registrations, its platforms', () => {
    expect(ringPushWiring(undefined, routed)).toEqual({ push: routed, ringPlatforms: ['android'] });
    expect(ringPushWiring(undefined, undefined)).toEqual({});
  });

  it('self-hosted: the relay sender and paired phones, never the routed sender', () => {
    const push = { send: () => Promise.resolve('sent' as const) } as unknown as RelayPushSender;
    const ringPhones = () => Promise.resolve([]);
    expect(ringPushWiring({ push, ringPhones }, routed)).toEqual({
      push,
      phones: ringPhones,
      ringPlatforms: ['android', 'ios'],
    });
  });
});
