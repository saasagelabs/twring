import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { ConfigError, type CredentialKeys, type GatewayEnv } from '@twring/config/gateway';
import type { FastifyInstance } from 'fastify';

import { SELFHOST_PUBLIC_ROUTES, type Authenticator } from '../auth';
import type { PairingBook } from '../connectors/pairing';
import { CredentialCipher } from '../store/cipher';

import { buildAdminServer } from './admin';
import { pairingAuthenticator } from './auth';
import type { PushSender, RoutedPushSender } from '@twring/push';

import type { RingPhones } from '../ring/service';

import { serverIdentityFromKey } from './identity';
import { createSelfhostFileStores, type SelfhostStores } from './people';
import {
  cachedRingService,
  onceAnHour,
  RelayClient,
  relayKeyFromFile,
  type RelayClientOptions,
} from './relay-client';
import { relayRingPhones, RelayPushSender } from './relay-push';
import { PersonRemover } from './removal';
import type { SelfhostRoutesOptions } from './routes';

export type SelfhostEnv = Pick<
  GatewayEnv,
  | 'TWRING_MODE'
  | 'TWRING_SERVER_KEY_FILE'
  | 'TWRING_ADMIN_TOKEN'
  | 'TWRING_AUDIO'
  | 'TWRING_SPACE_ID'
  | 'TWRING_RELAY_URL'
  | 'TWRING_RELAY_KEY_FILE'
  | 'CORD_DATA_DIR'
  | 'CORD_PUBLIC_URL'
  | 'CORD_ENV'
>;

/** Everything self-hosted mode adds to the gateway. Hosted mode gets none of it. */
export interface SelfhostWiring {
  stores: SelfhostStores;
  /** Pass to `buildApp({ selfhost })`. */
  routes: Omit<SelfhostRoutesOptions, 'userFor'>;
  /** Routes a phone reaches before it has a device token. */
  publicRoutes: ReadonlySet<string>;
  authenticator: Authenticator;
  /** Twring's ring relay. Never built in hosted mode. */
  relay: RelayClient;
  /** The ring service's push sender: sealed pushes through the relay (FCM/APNs never). */
  push: RelayPushSender;
  /** The ring service's phones: each paired phone by its relay handle. */
  ringPhones: RingPhones;
  /** The loopback admin listener for the `twring` command (not yet listening). */
  adminServer(pairings: PairingBook): FastifyInstance;
}

/** Logged at most once an hour while the relay answers 401 (its registration is gone). */
export const UNREGISTERED_WARNING =
  'This server is no longer registered with the ring service. Run twring register.';

const KEY_HELP =
  'must be the Ed25519 private key (PKCS8 PEM) this server was installed with. Restore it from your backup, or re-run the installer.';

/** Reads the server key, failing with a message that names the setting and the path. */
async function readServerKey(file: string): Promise<KeyObject> {
  let pem: string;
  try {
    pem = await readFile(file, 'utf8');
  } catch {
    throw new ConfigError([`TWRING_SERVER_KEY_FILE (${file}) could not be read: it ${KEY_HELP}`]);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new ConfigError([
      `TWRING_SERVER_KEY_FILE (${file}) is not a private key: it ${KEY_HELP}`,
    ]);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ConfigError([
      `TWRING_SERVER_KEY_FILE (${file}) is not an Ed25519 key: it ${KEY_HELP}`,
    ]);
  }
  return key;
}

/**
 * The ring service's push sender, phone source and ring platforms. Self-hosted: the relay sender
 * and the paired phones with a relay handle, never FCM/APNs. Hosted: the FCM/APNs routed sender
 * (if configured) over the ring push registrations, exactly as before.
 */
export function ringPushWiring(
  selfhost: Pick<SelfhostWiring, 'push' | 'ringPhones'> | undefined,
  routed: RoutedPushSender | undefined,
): { push?: PushSender; phones?: RingPhones; ringPlatforms?: readonly ('android' | 'ios')[] } {
  if (selfhost !== undefined) {
    return { push: selfhost.push, phones: selfhost.ringPhones, ringPlatforms: ['android', 'ios'] };
  }
  return routed === undefined ? {} : { push: routed, ringPlatforms: routed.ringPlatforms() };
}

/**
 * Builds the self-hosted parts (`TWRING_MODE=selfhost`), or undefined in hosted mode. Throws
 * `ConfigError` (which main reports and exits on) when the server key or credentials key is
 * missing or unusable.
 */
export async function buildSelfhost(
  env: SelfhostEnv,
  deps: {
    keys: CredentialKeys | undefined;
    /** Test seam: how the relay client is built. */
    relayClient?: (options: RelayClientOptions) => RelayClient;
    /** Where the "no longer registered" warning goes (main: the gateway log). */
    warn?: (line: string) => void;
  },
): Promise<SelfhostWiring | undefined> {
  if (env.TWRING_MODE !== 'selfhost') return undefined;
  if (deps.keys === undefined) {
    throw new ConfigError(['CORD_CREDENTIALS_KEY is required when TWRING_MODE=selfhost']);
  }
  if (env.TWRING_SERVER_KEY_FILE === undefined || env.TWRING_ADMIN_TOKEN === undefined) {
    throw new ConfigError([
      'TWRING_SERVER_KEY_FILE and TWRING_ADMIN_TOKEN are required when TWRING_MODE=selfhost',
    ]);
  }
  if (env.TWRING_RELAY_KEY_FILE === undefined) {
    throw new ConfigError(['TWRING_RELAY_KEY_FILE is required when TWRING_MODE=selfhost']);
  }
  const identity = serverIdentityFromKey(await readServerKey(env.TWRING_SERVER_KEY_FILE));
  const cipher = new CredentialCipher(deps.keys);
  const stores = createSelfhostFileStores(env.CORD_DATA_DIR, cipher);
  const remover = new PersonRemover(stores);
  const warnUnregistered = onceAnHour(
    deps.warn ??
      ((line) =>
        process.stderr.write(`${line}
`)),
  );
  const relay = (deps.relayClient ?? ((options) => new RelayClient(options)))({
    baseUrl: env.TWRING_RELAY_URL,
    relayKey: relayKeyFromFile(env.TWRING_RELAY_KEY_FILE),
    allowInsecureAudio: env.CORD_ENV === 'development',
    onUnregistered: () => {
      ringService.unregistered();
      warnUnregistered(UNREGISTERED_WARNING);
    },
  });
  const ringService = cachedRingService(relay);
  // A removed or deleted phone is forgotten at the relay too (best effort: its handle is already
  // gone here, so it gets no more pushes either way).
  stores.devices.onRelayHandlesDropped((handles) => {
    for (const handle of handles) void relay.removeDevice(handle).catch(() => undefined);
  });
  const adminToken = env.TWRING_ADMIN_TOKEN;
  return {
    stores,
    routes: {
      stores,
      remover,
      identity,
      serverName: new URL(env.CORD_PUBLIC_URL).hostname,
      audio: env.TWRING_AUDIO ?? 'own',
      spaceId: env.TWRING_SPACE_ID,
      ringService: ringService.provider,
      relayUrl: env.TWRING_RELAY_URL,
    },
    relay,
    push: new RelayPushSender({
      relay,
      devices: stores.devices,
      cipher,
      onRingState: ringService.record,
    }),
    ringPhones: relayRingPhones(stores.devices),
    publicRoutes: SELFHOST_PUBLIC_ROUTES,
    authenticator: pairingAuthenticator(stores.devices),
    adminServer: (pairings) =>
      buildAdminServer({
        token: adminToken,
        stores,
        remover,
        identity,
        spaceId: env.TWRING_SPACE_ID,
        pairings,
        ringService: ringService.provider,
      }),
  };
}
