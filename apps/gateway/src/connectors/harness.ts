import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadGatewayEnv } from '@twring/config/gateway';
import {
  agentSchema,
  claimResponseSchema,
  connectorEndpointUrl,
  pairingResponseSchema,
  pairResponseSchema,
  type PairResponse,
} from '@twring/contracts';
import { gatewayEnvFixture } from '@twring/test-fixtures';
import type { FastifyInstance, FastifyServerOptions, LightMyRequestResponse } from 'fastify';

import { savedAgentResolver } from '../agents/routes';
import { peopleSpace, sessionScopeKey, SharedAgents, threadAgentAccess } from '../agents/shared';
import { buildApp } from '../app';
import { AuthError, createRequestAuth, SELFHOST_PUBLIC_ROUTES } from '../auth';
import { buildAdminServer } from '../selfhost/admin';
import { pairingAuthenticator } from '../selfhost/auth';
import { serverIdentityFromKey } from '../selfhost/identity';
import { createSelfhostMemoryStores, type SelfhostStores } from '../selfhost/people';
import { PersonRemover } from '../selfhost/removal';
import { placeholderRingService } from '../selfhost/routes';
import { CredentialCipher, messageKeys } from '../store/cipher';
import { DailyLimits, type DailyAllowance, type DailyUsageRow } from '../calls/daily-limits';
import { CallRegistry } from '../calls/registry';
import { FakeTransport, ManualScheduler, recordingLogger } from '../calls/testing';
import type { PushOutcome, PushPayload, PushSender } from '@twring/push';
import { RingService } from '../ring/service';
import {
  DeviceRepository,
  InviteRepository,
  RingSettingsRepository,
  type InviteRecord,
  type RingStores,
} from '../ring/store';
import { MemoryCollection, type Collection } from '../store/collection';
import { createMemoryStores, type Stores } from '../store/repositories';
import { FileBlobStore } from '../files/blobs';
import { FileService } from '../files/service';
import { ThreadService } from '../threads/service';
import { SqliteThreadStore } from '../threads/store';
import { FakeSttProvider, FakeTtsProvider } from '../voice/testing';

import { ConnectorHub } from './hub';
import type { LinkBook } from './link-requests';
import { PairingBook } from './pairing';
import { connectorCallStatus, CONNECTOR_SOCKET_PATH } from './routes';
import { FAKE_AGENTS, startFakeConnector, type FakeConnectorOptions } from './testing';

/** A gateway with connectors mounted, listening on a free port. Test code only. */

export const TEST_KEYS = {
  currentVersion: 1,
  keys: new Map([[1, Buffer.alloc(32, 7).toString('base64')]]),
};

export interface ConnectorGateway {
  app: FastifyInstance;
  stores: Stores;
  hub: ConnectorHub;
  pairings: PairingBook;
  socketUrl: string;
  /** With `calls`: the call registry, the daily allowance, and each call's fake media. */
  calls?: {
    registry: CallRegistry;
    daily: DailyLimits;
    transports: FakeTransport[];
    scheduler: ManualScheduler;
    stt: FakeSttProvider;
  };
  /** With `ring`: rings, devices, and invites (ADR-024) on a manual clock with a fake push. */
  ring?: {
    service: RingService;
    stores: RingStores;
    scheduler: ManualScheduler;
    clock: { ms: number };
    pushes: { token: string; data: PushPayload }[];
  };
  threads?: { service: ThreadService; store: SqliteThreadStore };
  /** With `selfhost`: paired-phone stores, the admin listener (not listening), and pairing. */
  selfhost?: {
    stores: SelfhostStores;
    admin: FastifyInstance;
    adminToken: string;
    /** Pairs a phone with a fresh code of `role`; requests with its token act as that person. */
    pair(role: 'admin' | 'member', name: string): Promise<PairResponse>;
  };
  /** Sends a request as `user` (none = unauthenticated). */
  send(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: { user?: string; body?: unknown; ip?: string; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>;
  /** Pairs a new computer for `user`; resolves its id and token. */
  pair(user: string): Promise<{ connectorId: string; token: string }>;
  /** Pairs and connects a fake connector for `user`. */
  connect(
    user: string,
    options?: Partial<FakeConnectorOptions>,
  ): Promise<{
    connectorId: string;
    token: string;
    connector: ReturnType<typeof startFakeConnector>;
  }>;
  /** Saves a `cord-connector` agent; resolves its id. */
  createAgent(user: string, connectorId: string, localAgent?: string): Promise<string>;
  close(): Promise<void>;
}

export interface ConnectorGatewayOptions {
  claimRatePerMinute?: number;
  socketRatePerMinute?: number;
  pairings?: PairingBook;
  links?: LinkBook;
  linkCreatePerHour?: number;
  linkGuessesPerHour?: number;
  heartbeatMs?: number;
  /** Mounts `POST /v1/calls` for saved agents (fake media and speech), with this allowance. */
  calls?: { allowance?: DailyAllowance };
  /** Mounts rings (ADR-024). `push: false` leaves push unconfigured. */
  ring?: {
    push?: false | ((token: string) => PushOutcome);
    invites?: Collection<InviteRecord>;
    /** Refuse rings when the owner has no Android phone (production behaviour). */
    requireRingPhone?: boolean;
    /** Platforms that can be rung (production: from the configured push services). */
    ringPlatforms?: ('android' | 'ios')[];
  };
  threads?: {
    sweepIntervalMs?: number;
    /** Mounts files (`FILES_ENABLED`), stored in a temporary folder. */
    files?: boolean;
    writeRatePerMinute?: number;
    readRatePerMinute?: number;
    messagesPerDay?: number;
  };
  /** The Fastify logger (default off), e.g. a stream to assert no request logs an error. */
  logger?: FastifyServerOptions['logger'];
  /** Self-hosted mode: pairing routes, and requests without `x-user` use a device token. */
  selfhost?: boolean;
}

const fileDirs: string[] = [];

export async function startConnectorGateway(
  options: ConnectorGatewayOptions = {},
): Promise<ConnectorGateway> {
  const stores = createMemoryStores(TEST_KEYS);
  const hub = new ConnectorHub({
    ...(options.heartbeatMs !== undefined && { heartbeatMs: options.heartbeatMs }),
    onHello: async (id, agents) =>
      (await stores.connectors.touch(id, agents, new Date())) !== undefined,
  });
  const pairings = options.pairings ?? new PairingBook();
  const selfhostStores = options.selfhost
    ? createSelfhostMemoryStores(new CredentialCipher(TEST_KEYS))
    : undefined;
  const pairingAuth = selfhostStores && pairingAuthenticator(selfhostStores.devices);
  const auth = createRequestAuth((request) => {
    const user = request.headers['x-user'];
    if (user === undefined && pairingAuth !== undefined) return pairingAuth(request);
    // Test stand-ins for the sign-in's name and email claims.
    const name = request.headers['x-user-name'];
    const email = request.headers['x-user-email'];
    return typeof user === 'string'
      ? Promise.resolve({
          id: user,
          ...(typeof name === 'string' && { name }),
          ...(typeof email === 'string' && { email }),
        })
      : Promise.reject(new AuthError(401, 'auth_required', 'Sign in to use Twring.'));
  }, selfhostStores && SELFHOST_PUBLIC_ROUTES);
  const remover = selfhostStores && new PersonRemover(selfhostStores);
  const identity = serverIdentityFromKey(generateKeyPairSync('ed25519').privateKey);
  const env = loadGatewayEnv(
    gatewayEnvFixture({
      GATEWAY_AUDIO_TEST_MODE: 'echo',
      ...(options.threads?.files === true && { THREADS_ENABLED: 'true', FILES_ENABLED: 'true' }),
    }),
  );
  const policy = { env: 'development' as const, connectors: hub };
  const shared =
    selfhostStores &&
    new SharedAgents(stores, peopleSpace(selfhostStores.people), sessionScopeKey(TEST_KEYS), hub);
  let calls: ConnectorGateway['calls'];
  if (options.calls !== undefined) {
    const scheduler = new ManualScheduler();
    const transports: FakeTransport[] = [];
    const stt = new FakeSttProvider();
    const daily = new DailyLimits(
      new MemoryCollection<DailyUsageRow>(),
      options.calls.allowance ?? { callSeconds: 0, calls: 0 },
    );
    const registry = new CallRegistry({
      env,
      liveKitUrl: 'wss://cord-test.livekit.invalid',
      rooms: {
        deleteRoom: () => Promise.resolve(),
        removeParticipant: () => Promise.resolve(),
        ping: () => Promise.resolve(),
      },
      tokens: {
        caller: () => Promise.resolve('caller-token'),
        gateway: () => Promise.resolve('gateway-token'),
      },
      transports: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      voice: { stt, tts: new FakeTtsProvider() },
      history: stores.history,
      scheduler,
      logger: recordingLogger(),
    });
    calls = { registry, daily, transports, scheduler, stt };
  }
  let ring: ConnectorGateway['ring'];
  if (options.ring !== undefined) {
    const scheduler = calls?.scheduler ?? new ManualScheduler();
    const clock = { ms: Date.parse('2026-10-01T09:00:00.000Z') };
    const pushes: { token: string; data: PushPayload }[] = [];
    const outcome = options.ring.push;
    const push: PushSender | undefined =
      outcome === false
        ? undefined
        : {
            send: (target, data) => {
              pushes.push({ token: target.token, data });
              return Promise.resolve(outcome?.(target.token) ?? 'sent');
            },
          };
    const ringStores: RingStores = {
      devices: new DeviceRepository(new MemoryCollection()),
      settings: new RingSettingsRepository(new MemoryCollection()),
      invites: new InviteRepository(options.ring.invites ?? new MemoryCollection()),
    };
    const registry = calls?.registry;
    const service = new RingService({
      stores: ringStores,
      history: stores.history,
      ...(push !== undefined && { push }),
      ...(options.ring.requireRingPhone === true && { requireRingPhone: true }),
      ...(options.ring.ringPlatforms !== undefined && {
        ringPlatforms: options.ring.ringPlatforms,
      }),
      inCall: (userId) => registry?.hasLiveCall(userId) ?? false,
      scheduler,
      now: () => new Date(clock.ms),
      logger: recordingLogger(),
    });
    ring = { service, stores: ringStores, scheduler, clock, pushes };
  }
  let threads: ConnectorGateway['threads'];
  let files: FileService | undefined;
  if (options.threads) {
    const store = new SqliteThreadStore(':memory:', new CredentialCipher(messageKeys(TEST_KEYS)));
    if (options.threads.files === true) {
      const dir = await mkdtemp(join(tmpdir(), 'twring-harness-files-'));
      fileDirs.push(dir);
      files = new FileService(store, new FileBlobStore(dir), TEST_KEYS, 'http://localhost:8080');
    }
    const service = new ThreadService({
      store,
      ...(files && { files }),
      ...threadAgentAccess(stores, policy, hub, shared),
      hasLiveCallToAgent: (userId, agentId) =>
        calls?.registry.hasLiveCallToAgent(userId, agentId) ?? false,
      ...(ring && { ring: ring.service }),
      notify: () => undefined,
      sweepIntervalMs: options.threads.sweepIntervalMs ?? 20,
    });
    await service.start();
    threads = { service, store };
  }
  const app = buildApp({
    env,
    ...(ring !== undefined && {
      ring: {
        stores: ring.stores,
        service: ring.service,
        connectorRatePerMinute: 1000,
        writeRatePerMinute: 1000,
      },
    }),
    onError: () => undefined,
    ...(shared && { sharedAgents: shared }),
    ...(files && {
      files: { service: files, agents: stores.agents, readRatePerMinute: 1000 },
    }),
    ...(selfhostStores &&
      remover && {
        selfhost: {
          stores: selfhostStores,
          remover,
          identity,
          serverName: 'home.example.com',
          audio: 'own' as const,
          spaceId: 'default',
          ringService: placeholderRingService,
          relayUrl: 'https://relay.example.test',
        },
      }),
    ...(options.logger !== undefined && { logger: options.logger }),
    auth,
    ...(calls !== undefined && {
      calls: {
        registry: calls.registry,
        createRatePerMinute: 1000,
        dailyLimits: calls.daily,
        resolveAgent: savedAgentResolver(stores, policy, auth.userFor, shared),
        connectorStatus: connectorCallStatus(stores.connectors, hub),
      },
    }),
    agents: {
      stores,
      policy,
      writeRatePerMinute: 1000,
      testRatePerMinute: 1000,
      testBudget: { connectTimeoutMs: 2_000, probeTimeoutMs: 2_000 },
    },
    me: { deleteRatePerMinute: 100 },
    ...(threads && {
      threads: {
        ...threads,
        writeRatePerMinute: options.threads?.writeRatePerMinute ?? 1000,
        readRatePerMinute: options.threads?.readRatePerMinute ?? 1000,
        messagesPerDay: options.threads?.messagesPerDay ?? 1000,
      },
    }),
    connectors: {
      hub,
      pairings,
      writeRatePerMinute: 1000,
      claimRatePerMinute: options.claimRatePerMinute ?? 1000,
      socketRatePerMinute: options.socketRatePerMinute ?? 1000,
      ...(options.links !== undefined && { links: options.links }),
      linkCreatePerHour: options.linkCreatePerHour ?? 1000,
      ...(options.linkGuessesPerHour !== undefined && {
        linkGuessesPerHour: options.linkGuessesPerHour,
      }),
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  const socketUrl = `ws://127.0.0.1:${port}${CONNECTOR_SOCKET_PATH}`;
  const open: ReturnType<typeof startFakeConnector>[] = [];

  const send: ConnectorGateway['send'] = (method, url, opts = {}) =>
    app.inject({
      method,
      url,
      remoteAddress: opts.ip ?? '203.0.113.9',
      headers: {
        ...(opts.user !== undefined && { 'x-user': opts.user }),
        ...opts.headers,
      },
      ...(opts.body !== undefined && { payload: opts.body as object }),
    });

  const pair: ConnectorGateway['pair'] = async (user) => {
    const pairing = pairingResponseSchema.parse(
      (await send('POST', '/v1/connectors/pairings', { user })).json(),
    );
    const claim = await send('POST', '/v1/connectors/claim', {
      body: { code: pairing.code, name: 'Test laptop', agents: FAKE_AGENTS },
    });
    const { connector_id: connectorId, token } = claimResponseSchema.parse(claim.json());
    return { connectorId, token };
  };

  const adminToken = 'admin-token-'.padEnd(40, 'x');
  const admin =
    selfhostStores &&
    remover &&
    buildAdminServer({
      token: adminToken,
      stores: selfhostStores,
      remover,
      identity,
      spaceId: 'default',
      pairings,
    });

  return {
    app,
    stores,
    ...(selfhostStores &&
      admin && {
        selfhost: {
          stores: selfhostStores,
          admin,
          adminToken,
          async pair(role: 'admin' | 'member', name: string) {
            const { code } = await selfhostStores.codes.mint(role, 'default');
            const res = await send('POST', '/v1/pair', {
              body: {
                code,
                display_name: name,
                device_name: 'Pixel 8',
                platform: 'android',
                seal_public_key: 'A'.repeat(43),
              },
            });
            if (res.statusCode !== 201) throw new Error(`pair failed: ${res.body}`);
            return pairResponseSchema.parse(res.json());
          },
        },
      }),
    hub,
    pairings,
    socketUrl,
    ...(calls !== undefined && { calls }),
    ...(ring !== undefined && { ring }),
    ...(threads !== undefined && { threads }),
    send,
    pair,
    async connect(user, connectorOptions = {}) {
      const paired = await pair(user);
      const connector = startFakeConnector({
        url: socketUrl,
        token: paired.token,
        ...connectorOptions,
      });
      open.push(connector);
      await connector.ready;
      return { ...paired, connector };
    },
    async createAgent(user, connectorId, localAgent = 'claude-code') {
      const res = await send('POST', '/v1/agents', {
        user,
        body: {
          name: 'Laptop Claude',
          protocol: 'cord-connector',
          endpoint_url: connectorEndpointUrl(connectorId, localAgent),
        },
      });
      if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
      return agentSchema.parse(res.json()).id;
    },
    async close() {
      for (const connector of open) connector.terminate();
      await calls?.registry.shutdown();
      ring?.service.close();
      await app.close();
      await admin?.close();
      threads?.service.stop();
      await threads?.store.close();
      for (const dir of fileDirs.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}
