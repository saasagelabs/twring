import {
  agentSttKeyterms,
  cartesiaConfig,
  ConfigError,
  credentialKeys,
  deepgramConfig,
  liveKitConfig,
  loadGatewayEnv,
  type GatewayEnv,
} from '@twring/config/gateway';

import { statfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { pino } from 'pino';

import { savedAgentResolver } from './agents/routes';
import { peopleSpace, sessionScopeKey, SharedAgents, threadAgentAccess } from './agents/shared';
import { VoiceSampleCache, createOwnKeySample, sampleSynthesizer } from './agents/voice-samples';
import { createTtsRouter } from './agents/tts-router';
import { voiceList } from './agents/voices';
import { buildApp, type ReadinessCheck } from './app';
import { createRequestAuth, selectAuthenticator, mcpAuthenticator } from './auth';
import { startAdminListener } from './selfhost/admin';
import { buildSelfhost, ringPushWiring } from './selfhost/wiring';
import { createBetaMembers } from './beta/members';
import {
  createInviteService,
  inviteCodeRecordSchema,
  redemptionRecordSchema,
} from './beta/invites';
import { ConnectorHub } from './connectors/hub';
import { PairingBook } from './connectors/pairing';
import { connectorCallStatus } from './connectors/routes';
import { agentFactoryFor } from './calls/agents';
import { DailyLimits, dailyUsageRowSchema, utcDay } from './calls/daily-limits';
import { systemScheduler } from './calls/scheduler';
import {
  createLiveKitCalls,
  disposeLiveKit,
  type CallAudioSource,
  type LiveKitCalls,
} from './livekit';
import { createLoggerOptions, setLogTap } from './logger';
import { createCallStt } from './voice/call-stt';
import { createDeepgramStt } from './voice/deepgram-stt';
import { createPrerecordedTranscriber } from './voice/deepgram-prerecorded';
import { createXaiTranscriber } from './voice/xai-rest';
import { createDeepgramTts } from './voice/deepgram-tts';
import {
  ownDeepgramKeyOnly,
  serverXaiCallVoice,
  serverXaiKey,
  serverXaiSampleRouter,
} from './voice/server-xai-voice';
import { createSpeechResolver, type ResolvedSpeech } from './voice/speech-resolver';
import { toSafeError } from './redact';
import { AppleSignInRevoker } from './apple-signin';
import { RefusalCounter, refusalRowSchema } from './calls/refusal-counter';
import { watchConcurrency } from './notify/concurrency-watch';
import { watchDisk } from './notify/disk-watch';
import { EventAlerts, WAVE_ONE_RULES } from './notify/event-alerts';
import {
  FEEDBACK_DIGEST_EVERY_MS,
  FeedbackDigest,
  loadDigestMark,
  readFeedbackFile,
  readNotesFile,
  saveDigestMark,
} from './notify/feedback-digest';
import { gracefulShutdown, watchLiveCalls } from './shutdown';
import { createOwnerAlert } from './notify/owner-alert';
import {
  ApnsPushSender,
  FcmPushSender,
  loadApnsKey,
  loadServiceAccount,
  RoutedPushSender,
  type PushSender,
} from '@twring/push';
import { RingService } from './ring/service';
import {
  DeviceRepository,
  deviceRecordSchema,
  InviteRepository,
  inviteRecordSchema,
  RingSettingsRepository,
  ringSettingsRecordSchema,
  type RingStores,
} from './ring/store';
import { flushSentry, initSentry } from './sentry';
import { JsonFileCollection } from './store/collection';
import { waitlistRecordSchema } from './waitlist/routes';
import { createResendNotifier, createResendSender } from './waitlist/notify';
import {
  APPROVALS_EVERY_MS,
  DIGEST_EVERY_MS,
  InviteFlow,
  readApprovalsFile,
} from './waitlist/invite-flow';
import { createFileStores } from './store/repositories';
import { EncryptedSpeechKeyVault } from './store/speech-keys';
import { CredentialCipher, messageKeys } from './store/cipher';
import { ThreadService } from './threads/service';
import { PhoneSocketHub } from './threads/socket';
import { SqliteThreadStore } from './threads/store';
import { AvatarStore } from './agents/avatars';
import { FileBlobStore } from './files/blobs';
import { FileService } from './files/service';

function loadEnvOrExit(): GatewayEnv {
  try {
    return loadGatewayEnv(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnvOrExit();
const storeLogger = pino(createLoggerOptions(env)).child({ component: 'store' });
const sentryEnabled = initSentry(env);

// The call stack logs through its own pino instance with the same options (redaction,
// serializers) as Fastify's, so it can exist before the app that serves its routes.
const livekit = liveKitConfig(env);
const deepgram = deepgramConfig(env);
const cartesia = cartesiaConfig(env);
const callsLogger = pino(createLoggerOptions(env)).child({ component: 'calls' });
const tts =
  deepgram &&
  createTtsRouter({
    deepgram,
    cartesia,
    cartesiaDefaults: { ttsModel: env.CARTESIA_TTS_MODEL, ttsSpeed: env.CARTESIA_TTS_SPEED },
    logger: callsLogger,
    onCartesiaFallback: (voiceId) =>
      callsLogger.warn(
        { event: 'tts_voice_fallback', voice_id: voiceId },
        'CARTESIA_API_KEY not set: Cartesia voices fall back to the default Deepgram voice',
      ),
  });
// Self-hosted with only an xAI key: calls listen and speak on the server's xAI key, except where
// a person's own key (or the server's Cartesia key) speaks, as on hosted.
const xaiKey = serverXaiKey(env);
// The Deepgram settings without a server key: the empty key is never sent, since every use below
// asks for the person's own Deepgram key first (`serverXaiListensOnDeepgram`, `serverXaiTtsSide`,
// `createOwnKeySample`, `ownDeepgramKeyOnly`).
const sttSettings = deepgram ?? deepgramConfig({ ...env, DEEPGRAM_API_KEY: '' })!;
const xaiSttSettings = {
  endpointingMs: env.XAI_STT_ENDPOINTING_MS,
  ...(env.XAI_STT_SMART_TURN !== undefined && { smartTurn: env.XAI_STT_SMART_TURN }),
  ...(env.XAI_STT_SMART_TURN_TIMEOUT_MS !== undefined && {
    smartTurnTimeoutMs: env.XAI_STT_SMART_TURN_TIMEOUT_MS,
  }),
};
const xaiOwnKeyTts =
  xaiKey !== undefined
    ? createTtsRouter({
        deepgram: { apiKey: '', ttsModel: env.DEEPGRAM_TTS_MODEL },
        cartesia,
        cartesiaDefaults: { ttsModel: env.CARTESIA_TTS_MODEL, ttsSpeed: env.CARTESIA_TTS_SPEED },
      })
    : undefined;
const xaiCallVoice =
  xaiKey !== undefined && xaiOwnKeyTts !== undefined
    ? serverXaiCallVoice({
        apiKey: xaiKey,
        stt: xaiSttSettings,
        ownKeys: {
          stt: createCallStt({
            deepgram: sttSettings,
            xai: xaiSttSettings,
            keyterms: (agentTerms, agentName) =>
              agentSttKeyterms(sttSettings, agentTerms, agentName),
          }),
          tts: xaiOwnKeyTts,
        },
        logger: callsLogger,
      })
    : undefined;
// Voice samples on such a server: Grok voices on its xAI key; any other voice only on a person's
// own key.
const xaiSamples =
  xaiKey !== undefined && xaiOwnKeyTts !== undefined
    ? serverXaiSampleRouter(xaiKey, xaiOwnKeyTts)
    : undefined;
const createAgent = agentFactoryFor(env);
const keys = credentialKeys(env);
// Saved agents need the credentials key; config requires it outside development.
const stores = keys && createFileStores(env.CORD_DATA_DIR, keys);
// Created below the call registry so the history hook can refer to the finished service.
// eslint-disable-next-line prefer-const
let threadService: ThreadService | undefined;
// Service alerts to the owner (wave 1): sent through Resend, once per subject a day.
const ownerAlert =
  env.OWNER_ALERT_TO && env.RESEND_API_KEY && env.WAITLIST_NOTIFY_FROM
    ? createOwnerAlert({
        apiKey: env.RESEND_API_KEY,
        from: env.WAITLIST_NOTIFY_FROM,
        to: env.OWNER_ALERT_TO,
        log: pino(createLoggerOptions(env)).child({ component: 'alerts' }),
      })
    : undefined;
// Failing calls, pushes, server errors and computers dropping together reach the owner by email
// (wave 1, track 2.2): every log line is counted in 5-minute windows.
const eventAlerts =
  ownerAlert &&
  new EventAlerts({
    rules: WAVE_ONE_RULES,
    alert: (subject, text) => void ownerAlert(subject, text, { repeatAfterMs: 60 * 60_000 }),
  });
if (eventAlerts) setLogTap((level, fields) => eventAlerts.record(level, fields));
// A data file with a few rows that no longer match keeps working; the rows are set aside in
// `<file>.rejected` (review finding 3). The next save leaves them out of the live file, so the
// owner hears about it, not just the log.
EncryptedSpeechKeyVault.onSettingsUnreadable = () => {
  storeLogger.warn({ event: 'speech_settings_unreadable' }, 'speech settings unreadable');
};
JsonFileCollection.onRowsSkipped = (file, count) => {
  storeLogger.warn({ event: 'store_rows_skipped', file: basename(file), count }, 'rows set aside');
  void ownerAlert?.(
    `Twring: data rows set aside (${basename(file)})`,
    `${count} row(s) in ${basename(file)} could not be read and were moved to ` +
      `${basename(file)}.rejected in ${env.CORD_DATA_DIR}. The people they belong to may be ` +
      'missing an agent, a phone or a setting until the rows are repaired and put back.',
  );
};
// Per-user daily allowance, counted in its own file (needs no credentials key), and the
// service-wide daily cap that guards cost (SERVICE_DAILY_CALL_SECONDS).
const dailyLimits = new DailyLimits(
  new JsonFileCollection(join(env.CORD_DATA_DIR, 'daily-usage.json'), dailyUsageRowSchema),
  { callSeconds: env.DAILY_CALL_SECONDS_PER_USER, calls: env.DAILY_CALLS_PER_USER },
  () => new Date(),
  {
    callSeconds: env.SERVICE_DAILY_CALL_SECONDS,
    onThreshold: (used, cap) =>
      void ownerAlert?.(
        "Twring: 80% of today's call minutes used",
        `Calls today have used ${Math.round(used / 60)} of ${Math.round(cap / 60)} minutes ` +
          '(SERVICE_DAILY_CALL_SECONDS). At the cap, new calls are refused until midnight UTC. ' +
          'Raise the cap in /etc/cord/gateway.env and restart if this is expected growth.',
      ),
  },
);
// Computers paired with `cord-connect` dial in here (ADR-023); only with saved agents configured.
const connectorLogger = pino(createLoggerOptions(env)).child({ component: 'connectors' });
const connectorHub = new ConnectorHub({
  ...(env.THREADS_ENABLED && keys && stores && { features: ['messages'] }),
  logger: connectorLogger,
  onHello: async (connectorId, agents) =>
    stores !== undefined &&
    (await stores.connectors.touch(connectorId, agents, new Date())) !== undefined,
});
const pairings = new PairingBook();
// Self-hosted only (TWRING_MODE=selfhost): people, paired phones and pairing codes. Hosted Twring
// gets undefined, so its routes, auth and listeners stay as they were. A bad server key is a
// configuration error: reported plainly, then exit.
async function loadSelfhostOrExit() {
  try {
    return await buildSelfhost(env, {
      keys,
      warn: (line) => connectorLogger.warn({ event: 'relay_unregistered' }, line),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}
`);
      process.exit(1);
    }
    throw error;
  }
}
const selfhost = await loadSelfhostOrExit();
const endpointPolicy = { env: env.CORD_ENV, connectors: connectorHub };
// Self-hosted only: server agents shared with the space, each person in their own session.
const sharedAgents =
  selfhost && stores && keys
    ? new SharedAgents(
        stores,
        peopleSpace(selfhost.stores.people),
        sessionScopeKey(keys),
        connectorHub,
      )
    : undefined;
// Whose speech keys each person's calls, voice notes, Listen and samples use (BYOK).
const speechResolver = createSpeechResolver({
  enabled: env.SPEECH_KEYS_ENABLED,
  ...(stores && { vault: stores.speechKeys }),
  ...(deepgram && { deepgram }),
  ...(cartesia && { cartesia }),
  ...(xaiKey !== undefined && { xai: { apiKey: xaiKey } }),
});
// With the switch off nothing below takes a resolver, so every path behaves as before BYOK, except
// on a server on its own xAI key, whose voice notes, Listen and voices need the resolver for it.
const ownSpeech =
  (env.SPEECH_KEYS_ENABLED && stores !== undefined) || xaiKey !== undefined
    ? speechResolver
    : undefined;
// Call audio: the server's own LiveKit (hosted, and self-hosted `own`), or Twring's through the
// relay (self-hosted `twring`). Chosen here once; the server never switches by itself.
const callAudioSource: CallAudioSource | undefined =
  selfhost !== undefined && env.TWRING_AUDIO === 'twring'
    ? { kind: 'twring', relay: selfhost.relay }
    : livekit && { kind: 'own', config: livekit, selfhost: selfhost !== undefined };
const calls: LiveKitCalls | undefined =
  callAudioSource &&
  createLiveKitCalls(callAudioSource, {
    env,
    scheduler: systemScheduler,
    logger: callsLogger,
    ...(createAgent && { createAgent }),
    ...(deepgram &&
      tts && {
        voice: {
          stt: createDeepgramStt({
            apiKey: deepgram.apiKey,
            model: deepgram.sttModel,
            languageHints: deepgram.sttLanguageHints,
            keyterms: deepgram.sttKeyterms,
            eotThreshold: deepgram.sttEotThreshold,
            eotTimeoutMs: deepgram.sttEotTimeoutMs,
          }),
          tts: createDeepgramTts({ apiKey: deepgram.apiKey, model: deepgram.ttsModel }),
        },
        sttForKeyterms: createCallStt({
          deepgram,
          xai: {
            endpointingMs: env.XAI_STT_ENDPOINTING_MS,
            ...(env.XAI_STT_SMART_TURN !== undefined && { smartTurn: env.XAI_STT_SMART_TURN }),
            ...(env.XAI_STT_SMART_TURN_TIMEOUT_MS !== undefined && {
              smartTurnTimeoutMs: env.XAI_STT_SMART_TURN_TIMEOUT_MS,
            }),
          },
          keyterms: (agentTerms, agentName) => agentSttKeyterms(deepgram, agentTerms, agentName),
        }),
        ttsForVoice: (voiceId: string, speech?: ResolvedSpeech) => tts.forCall(voiceId, speech),
      }),
    ...xaiCallVoice,
    ...(stores && {
      history: {
        record: async (userId: string, item: Parameters<typeof stores.history.record>[1]) => {
          await stores.history.record(userId, item);
          if (threadService) await threadService.recordCall(userId, item);
        },
        list: (userId: string, limit: number) => stores.history.list(userId, limit),
        usageRollup: (userId: string, sinceDay?: string) =>
          stores.history.usageRollup(userId, sinceDay),
        deleteAllForUser: (userId: string) => stores.history.deleteAllForUser(userId),
      },
    }),
    onCallFinished: ({ ownerId, startedAt, durationS }) =>
      dailyLimits.addCallSeconds(ownerId, utcDay(startedAt), durationS),
  });
// The owner hears when live calls near CALL_MAX_CONCURRENT: time to plan a bigger server.
if (calls !== undefined && ownerAlert !== undefined) {
  watchConcurrency({
    count: () => calls.registry.activeCount,
    limit: env.CALL_MAX_CONCURRENT,
    alert: (live, limit) =>
      void ownerAlert(
        'Twring: calls near the limit',
        `${live} calls were live at once (limit ${limit}, CALL_MAX_CONCURRENT). New calls are ` +
          'refused at the limit. Plan a bigger server, or measure it again with scripts/load-test.ts.',
      ),
  });
}

// The owner hears when the data disk runs low: a full disk stops every save and upload.
if (ownerAlert !== undefined) {
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  watchDisk({
    path: env.CORD_DATA_DIR,
    statfs: (path) => statfs(path),
    alert: ({ freeBytes, totalBytes }) =>
      void ownerAlert(
        'Twring: disk space low',
        `The data disk (${env.CORD_DATA_DIR}) has ${gb(freeBytes)} GB free of ${gb(totalBytes)} GB. ` +
          'When it fills, saves and uploads fail. Free space (old backups in /var/backups/cord) ' +
          'or grow the disk.',
      ),
    onError: (error) =>
      storeLogger.warn(
        { event: 'disk_check_failed', err: toSafeError(error) },
        'disk check failed',
      ),
  });
}

// The agent rings its owner (ADR-024). Invites survive a restart; push is optional.
const ringLogger = pino(createLoggerOptions(env)).child({ component: 'ring' });
const ringStores: RingStores = {
  devices: new DeviceRepository(
    new JsonFileCollection(join(env.CORD_DATA_DIR, 'devices.json'), deviceRecordSchema),
  ),
  settings: new RingSettingsRepository(
    new JsonFileCollection(join(env.CORD_DATA_DIR, 'ring-settings.json'), ringSettingsRecordSchema),
  ),
  invites: new InviteRepository(
    new JsonFileCollection(join(env.CORD_DATA_DIR, 'ring-invites.json'), inviteRecordSchema),
  ),
};
let androidPush: PushSender | undefined;
if (env.FCM_SERVICE_ACCOUNT_FILE !== undefined) {
  try {
    androidPush = new FcmPushSender({
      account: await loadServiceAccount(env.FCM_SERVICE_ACCOUNT_FILE),
    });
  } catch (error) {
    ringLogger.warn({ event: 'push_unconfigured', err: toSafeError(error) }, 'FCM not loaded');
  }
} else {
  ringLogger.warn(
    { event: 'push_unconfigured' },
    'FCM_SERVICE_ACCOUNT_FILE not set: rings are not pushed',
  );
}
// iPhones: APNs straight from the gateway.
let iosPush: ApnsPushSender | undefined;
if (env.APNS_KEY_FILE !== undefined && env.APNS_KEY_ID && env.APNS_TEAM_ID) {
  try {
    iosPush = new ApnsPushSender({
      keyPem: await loadApnsKey(env.APNS_KEY_FILE),
      keyId: env.APNS_KEY_ID,
      teamId: env.APNS_TEAM_ID,
      bundleId: env.APNS_BUNDLE_ID,
      environment: env.APNS_ENV,
    });
  } catch (error) {
    ringLogger.warn({ event: 'apns_unconfigured', err: toSafeError(error) }, 'APNs not loaded');
  }
}
const routedPush =
  androidPush !== undefined || iosPush !== undefined
    ? new RoutedPushSender({
        ...(androidPush !== undefined && { android: androidPush }),
        ...(iosPush !== undefined && { ios: iosPush }),
      })
    : undefined;
// Self-hosted servers ring through Twring's relay, sealed; hosted Twring uses FCM/APNs as before.
const ringPush = ringPushWiring(selfhost, routedPush);
// Sign in with Apple: ends an Apple account's sign-in when it is deleted (app-store-sign-in.md).
let appleRevoker: AppleSignInRevoker | undefined;
if (
  env.APPLE_SIGNIN_KEY_FILE !== undefined &&
  env.APPLE_SIGNIN_KEY_ID &&
  env.APPLE_SIGNIN_TEAM_ID
) {
  try {
    appleRevoker = new AppleSignInRevoker({
      keyPem: await loadApnsKey(env.APPLE_SIGNIN_KEY_FILE),
      keyId: env.APPLE_SIGNIN_KEY_ID,
      teamId: env.APPLE_SIGNIN_TEAM_ID,
      clientId: env.APPLE_SIGNIN_CLIENT_ID,
    });
  } catch (error) {
    ringLogger.warn(
      { event: 'apple_signin_unconfigured', err: toSafeError(error) },
      'Sign in with Apple key not loaded',
    );
  }
}
const ringService = new RingService({
  stores: ringStores,
  ...(stores && { history: stores.history }),
  ...ringPush,
  // With push on, a ring nobody could receive is refused so the agent messages instead.
  requireRingPhone: true,
  inCall: (userId) => calls?.registry.hasLiveCall(userId) ?? false,
  scheduler: systemScheduler,
  logger: ringLogger,
  onSettled: async (invite) => {
    if (threadService && invite.status !== 'pending') {
      await threadService.recordRing({ ...invite, status: invite.status });
      await threadService.pushSettledResult(invite);
    }
  },
});

const threadDbPath = env.CORD_THREADS_DB ?? join(env.CORD_DATA_DIR, 'threads.db');
// Every /v1 route and phone upgrade uses the same verified user (ADR-021).
const auth = createRequestAuth(
  selectAuthenticator(env, selfhost && { authenticator: selfhost.authenticator }),
  selfhost?.publicRoutes,
);
const threadStore =
  env.THREADS_ENABLED && keys && stores
    ? new SqliteThreadStore(threadDbPath, new CredentialCipher(messageKeys(keys)))
    : undefined;
const fileService =
  env.FILES_ENABLED && threadStore && keys
    ? new FileService(
        threadStore,
        new FileBlobStore(join(env.CORD_DATA_DIR, 'files')),
        keys,
        env.CORD_PUBLIC_URL,
        pino(createLoggerOptions(env)).child({ component: 'files' }),
      )
    : undefined;
const phoneSocketHub = threadStore
  ? new PhoneSocketHub({
      auth,
      ratePerMinute: env.PHONE_SOCKET_RATE_PER_MINUTE,
      trustProxy: env.TRUST_PROXY,
      log: pino(createLoggerOptions(env)).child({ component: 'phone_socket' }),
    })
  : undefined;
threadService =
  threadStore && stores
    ? new ThreadService({
        store: threadStore,
        ...(fileService && { files: fileService }),
        fileFetchEnv: env.CORD_ENV,
        ...threadAgentAccess(stores, endpointPolicy, connectorHub, sharedAgents),
        hasLiveCallToAgent: (userId, agentId) =>
          calls?.registry.hasLiveCallToAgent(userId, agentId) ?? false,
        ring: ringService,
        isFocused: (userId, agentId) => phoneSocketHub?.isFocused(userId, agentId) ?? false,
        notify: (userId, frame) => phoneSocketHub?.publish(userId, frame),
        log: pino(createLoggerOptions(env)).child({ component: 'threads' }),
      })
    : undefined;
if (threadService) await threadService.start();
if (fileService) await fileService.sweep();
const fileSweepTimer =
  fileService &&
  setInterval(
    () =>
      void fileService
        .sweep()
        .catch((error: unknown) =>
          callsLogger.warn(
            { event: 'file_sweep_failed', error: error instanceof Error ? error.name : 'unknown' },
            'file_sweep_failed',
          ),
        ),
    6 * 60 * 60_000,
  );
fileSweepTimer?.unref();
await ringService.recover();

const readinessChecks: ReadinessCheck[] = [];
const ownRooms = calls?.rooms;
if (ownRooms !== undefined) readinessChecks.push({ name: 'livekit', check: () => ownRooms.ping() });

const notifyVars = ['RESEND_API_KEY', 'WAITLIST_NOTIFY_TO', 'WAITLIST_NOTIFY_FROM'] as const;
const missingNotifyVars = notifyVars.filter((key) => env[key] === undefined);
const notifyLog = pino(createLoggerOptions(env));
if (missingNotifyVars.length > 0 && missingNotifyVars.length < notifyVars.length) {
  notifyLog.warn(
    { event: 'waitlist_notify_incomplete', missing: missingNotifyVars },
    'waitlist notification is not configured',
  );
}
const notifier =
  env.RESEND_API_KEY && env.WAITLIST_NOTIFY_TO && env.WAITLIST_NOTIFY_FROM
    ? createResendNotifier({
        apiKey: env.RESEND_API_KEY,
        to: env.WAITLIST_NOTIFY_TO,
        from: env.WAITLIST_NOTIFY_FROM,
        log: notifyLog,
      })
    : undefined;
const inviteStores = env.BETA_MEMBERS_FILE
  ? {
      codesFile: join(env.CORD_DATA_DIR, 'invite-codes.json'),
      autoCodes: new JsonFileCollection(
        join(env.CORD_DATA_DIR, 'invite-auto-codes.json'),
        inviteCodeRecordSchema,
      ),
      redemptions: new JsonFileCollection(
        join(env.CORD_DATA_DIR, 'invite-redemptions.json'),
        redemptionRecordSchema,
      ),
    }
  : undefined;
const inviteService =
  env.BETA_MEMBERS_FILE && inviteStores
    ? createInviteService({
        members: createBetaMembers(env.BETA_MEMBERS_FILE),
        ...inviteStores,
        autoAdmitPerDay: env.AUTO_ADMIT_PER_DAY,
      })
    : undefined;
const waitlistRecords = new JsonFileCollection(
  join(env.CORD_DATA_DIR, 'waitlist.json'),
  waitlistRecordSchema,
);
// Wave 1 invites: one combined email of new requests to the owner,
// and the owner's approvals turned into invite emails. Without the invite gate, each request
// still sends its own email.
const inviteFlow =
  env.RESEND_API_KEY && env.WAITLIST_NOTIFY_TO && env.WAITLIST_NOTIFY_FROM && inviteService
    ? new InviteFlow({
        records: waitlistRecords,
        ownerTo: env.WAITLIST_NOTIFY_TO,
        send: createResendSender({
          apiKey: env.RESEND_API_KEY,
          from: env.INVITE_FROM ?? env.WAITLIST_NOTIFY_FROM,
          log: notifyLog,
        }),
        letIn: (email) => inviteService.letIn(email),
        isMember: (email) => inviteService.isMember(email),
        autoInvitePerDay: env.AUTO_ADMIT_PER_DAY,
        readApprovals: () =>
          readApprovalsFile(join(env.CORD_DATA_DIR, 'invite-approvals.json'), () =>
            notifyLog.warn(
              { event: 'invite_approvals_invalid' },
              'invite-approvals.json is invalid',
            ),
          ),
        links: {
          ...(env.TWRING_DOWNLOAD_URL && { android: env.TWRING_DOWNLOAD_URL }),
          ...(env.TWRING_TESTFLIGHT_URL && { iphone: env.TWRING_TESTFLIGHT_URL }),
        },
      })
    : undefined;
const onNewSignup = inviteFlow === undefined ? notifier : undefined;
if (inviteFlow !== undefined) {
  const every = (ms: number, run: () => Promise<void>, event: string) => {
    let busy = false;
    setInterval(() => {
      if (busy) return;
      busy = true;
      run()
        .catch((error: unknown) => notifyLog.warn({ event, err: toSafeError(error) }, event))
        .finally(() => (busy = false));
    }, ms).unref();
  };
  every(DIGEST_EVERY_MS, () => inviteFlow.sendDigest(), 'invite_digest_failed');
  every(APPROVALS_EVERY_MS, () => inviteFlow.processApprovals(), 'invite_approvals_failed');
  notifyLog.info({ event: 'invite_flow_enabled' }, 'invite flow enabled');
} else if (onNewSignup) {
  notifyLog.info({ event: 'waitlist_notify_enabled' }, 'waitlist notification enabled');
}
// Post-call notes and ratings of 3 stars or fewer reach the owner every hour.
if (env.RESEND_API_KEY && env.WAITLIST_NOTIFY_TO && env.WAITLIST_NOTIFY_FROM) {
  const markFile = join(env.CORD_DATA_DIR, 'feedback-digest.json');
  const feedbackDigest = new FeedbackDigest({
    to: env.WAITLIST_NOTIFY_TO,
    readRows: () => readFeedbackFile(join(env.CORD_DATA_DIR, 'call-feedback.json')),
    readNotes: () => readNotesFile(join(env.CORD_DATA_DIR, 'app-notes.json')),
    loadMark: () => loadDigestMark(markFile),
    saveMark: (at) => saveDigestMark(markFile, at),
    send: createResendSender({
      apiKey: env.RESEND_API_KEY,
      from: env.WAITLIST_NOTIFY_FROM,
      log: notifyLog,
    }),
    agentName: async (userId, agentId) => (await stores?.agents.get(userId, agentId))?.name,
    onReadError: (source, error) =>
      notifyLog.warn(
        { event: 'feedback_digest_read_failed', source, err: toSafeError(error) },
        'feedback_digest_read_failed',
      ),
  });
  let digestBusy = false;
  const runDigest = () => {
    if (digestBusy) return;
    digestBusy = true;
    feedbackDigest
      .run()
      .catch((error: unknown) =>
        notifyLog.warn(
          { event: 'feedback_digest_failed', err: toSafeError(error) },
          'feedback_digest_failed',
        ),
      )
      .finally(() => (digestBusy = false));
  };
  runDigest();
  setInterval(runDigest, FEEDBACK_DIGEST_EVERY_MS).unref();
}

// Deepgram voice notes: on the server key, or on a server with none (its own xAI key) only on a
// person's own Deepgram key.
const deepgramNotes =
  deepgram || xaiKey !== undefined
    ? createPrerecordedTranscriber(deepgram?.apiKey ?? '', fetch, undefined, (status) =>
        notifyLog.warn(
          { event: 'voice_note_keyterms_refused', status },
          'voice note words refused by the provider; transcribed without them',
        ),
      )
    : undefined;
const voiceNotes = deepgramNotes && (deepgram ? deepgramNotes : ownDeepgramKeyOnly(deepgramNotes));
const app = buildApp({
  env,
  ...(inviteStores && { invites: inviteStores }),
  waitlist: {
    records: waitlistRecords,
    allowedOrigins: env.WAITLIST_ALLOWED_ORIGINS,
    ...(onNewSignup && { onNewSignup }),
  },
  logger: createLoggerOptions(env),
  readinessChecks,
  auth,
  ...(selfhost && { selfhost: selfhost.routes }),
  ...(sharedAgents && { sharedAgents }),
  ...(env.CONNECTOR_MCP_ENABLED &&
    env.SUPABASE_URL && {
      mcp: { authenticate: mcpAuthenticator({ supabaseUrl: env.SUPABASE_URL }) },
    }),
  calls: {
    registry: calls?.registry,
    createRatePerMinute: env.CALL_CREATE_RATE_PER_MINUTE,
    readRatePerMinute: env.API_READ_RATE_PER_MINUTE,
    // Production calls always go to a saved agent; the test line is for development and staging.
    allowTestLine: env.CORD_ENV !== 'production',
    dailyLimits,
    refusals: new RefusalCounter(
      new JsonFileCollection(join(env.CORD_DATA_DIR, 'call-refusals.json'), refusalRowSchema),
    ),
    ...(stores && {
      resolveAgent: savedAgentResolver(stores, endpointPolicy, auth.userFor, sharedAgents),
      connectorStatus: connectorCallStatus(stores.connectors, connectorHub),
    }),
    speech: speechResolver,
  },
  agents: {
    stores,
    policy: endpointPolicy,
    writeRatePerMinute: env.AGENT_WRITE_RATE_PER_MINUTE,
    testRatePerMinute: env.AGENT_TEST_RATE_PER_MINUTE,
    readRatePerMinute: env.API_READ_RATE_PER_MINUTE,
    testsEnabled: env.AGENT_TESTS_ENABLED,
    cartesiaVoices: cartesia !== undefined,
    ...(xaiKey !== undefined && { serverXaiVoices: true }),
    ...(ownSpeech && { speech: ownSpeech }),
    ...(keys && { avatars: new AvatarStore(env.CORD_DATA_DIR, keys) }),
  },
  ...(threadService &&
    threadStore && {
      threads: {
        service: threadService,
        ...(phoneSocketHub && { socketHub: phoneSocketHub }),
        store: threadStore,
        writeRatePerMinute: env.THREAD_WRITE_RATE_PER_MINUTE,
        readRatePerMinute: env.THREAD_READ_RATE_PER_MINUTE,
        messagesPerDay: env.THREAD_MESSAGES_PER_DAY,
        ...(voiceNotes && { transcribeVoiceNote: voiceNotes }),
        // A person's own keys (BYOK), including xAI listening on their own xAI key, and the
        // server's own xAI key on a self-hosted server without Deepgram.
        ...(ownSpeech && {
          speech: ownSpeech,
          transcribeWithXai: createXaiTranscriber(fetch, undefined, (status) =>
            notifyLog.warn(
              { event: 'voice_note_keyterms_refused', provider: 'xai', status },
              'voice note words refused by the provider; transcribed without them',
            ),
          ),
        }),
        // Voice notes hear the agent's words (owner's and agent-added) and name, as its calls do.
        ...(stores && {
          wordsFor: async (userId: string, agentId: string) => {
            // Only the keyterm settings are read here, never the API key: hosted Twring passes
            // its real Deepgram config (`deepgram` is set), and a server without Deepgram gets
            // the same keyterm defaults from the keyless config above.
            const agent = await stores.agents.get(userId, agentId);
            return agentSttKeyterms(sttSettings, agent?.keyterms ?? [], agent?.name);
          },
        }),
      },
    }),
  ...(fileService &&
    stores && {
      files: {
        service: fileService,
        agents: stores.agents,
        readRatePerMinute: env.API_READ_RATE_PER_MINUTE,
      },
    }),
  ...(threadService &&
    threadStore && {
      messageSpeech: {
        ...(deepgram && { deepgram: { apiKey: deepgram.apiKey } }),
        ...(cartesia && { cartesia }),
        cartesiaDefaults: { ttsModel: env.CARTESIA_TTS_MODEL, ttsSpeed: env.CARTESIA_TTS_SPEED },
        ...(ownSpeech && { speech: ownSpeech }),
      },
    }),
  me: {
    deleteRatePerMinute: env.DATA_DELETE_RATE_PER_MINUTE,
    ...(appleRevoker !== undefined && { appleRevoker }),
  },
  speechKeys: {
    enabled: env.SPEECH_KEYS_ENABLED,
    writeRatePerMinute: env.SPEECH_KEY_WRITE_RATE_PER_MINUTE,
  },
  usage: { dailyLimits, readRatePerMinute: env.API_READ_RATE_PER_MINUTE },
  publicPages: {
    operatorName: env.CORD_OPERATOR_NAME,
    ...(env.CORD_OPERATOR_URL !== undefined && { operatorUrl: env.CORD_OPERATOR_URL }),
    supportEmail: env.CORD_SUPPORT_EMAIL,
  },
  connectors: {
    hub: connectorHub,
    pairings,
    writeRatePerMinute: env.AGENT_WRITE_RATE_PER_MINUTE,
    claimRatePerMinute: env.CONNECTOR_CLAIM_RATE_PER_MINUTE,
    socketRatePerMinute: env.CONNECTOR_SOCKET_RATE_PER_MINUTE,
  },
  ring: {
    stores: ringStores,
    service: ringService,
    connectorRatePerMinute: env.CONNECTOR_SOCKET_RATE_PER_MINUTE,
    writeRatePerMinute: env.AGENT_WRITE_RATE_PER_MINUTE,
  },
  ...((tts ?? xaiSamples) && {
    voiceSamples: {
      samples: new VoiceSampleCache(
        join(env.CORD_DATA_DIR, 'voice-samples'),
        sampleSynthesizer((tts ?? xaiSamples)!),
      ),
      ratePerMinute: env.VOICE_SAMPLE_RATE_PER_MINUTE,
      enabled: env.VOICE_SAMPLES_ENABLED,
      offered: (voiceId) =>
        voiceList({
          cartesia: cartesia !== undefined,
          ...(xaiKey !== undefined && { xaiServer: true }),
        }).voices.some((v) => v.id === voiceId),
      // A voice the server cannot make is sampled with the person's own key, never cached.
      ...(ownSpeech && {
        ownKeySample: createOwnKeySample(ownSpeech, (tts ?? xaiSamples)!),
      }),
    },
  }),
});
if (stores === undefined) {
  app.log.warn(
    'CORD_CREDENTIALS_KEY not set: /v1/agents will answer 503 (development only; see docs/DEVELOPMENT.md)',
  );
}
if (calls === undefined) {
  app.log.warn('LIVEKIT_* not set: /v1/calls will answer 503 (development only)');
}

// The deploy script waits for this to read 0 before restarting.
if (calls !== undefined) {
  const liveCallsFile = join(env.CORD_DATA_DIR, 'live-calls');
  watchLiveCalls({
    count: () => calls.registry.activeCount,
    write: (text) => writeFile(liveCallsFile, text),
  });
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    // New calls are refused first ("Twring is updating"), live calls are ended cleanly (rooms
    // closed, history saved), and only then does the HTTP server stop.
    await gracefulShutdown({
      drain: () => {
        // Our own shutdown disconnects every computer: not something to alert about.
        eventAlerts?.stop();
        calls?.registry.drain();
      },
      liveCalls: () => calls?.registry.activeCount ?? 0,
      endCalls: async () => {
        if (calls === undefined) return;
        await calls.registry.shutdown();
        await disposeLiveKit();
      },
      closeServer: () => app.close(),
      closeRest: async () => {
        threadService?.stop();
        if (fileSweepTimer) clearInterval(fileSweepTimer);
        await threadStore?.close();
        ringService.close();
        if (adminServer) await adminServer.close();
        await flushSentry();
      },
    });
  } finally {
    process.exit(0);
  }
}
process.once('SIGINT', (signal) => void shutdown(signal));
process.once('SIGTERM', (signal) => void shutdown(signal));

// The `twring` command's admin listener: loopback only, self-hosted only.
const adminServer = selfhost?.adminServer(pairings);

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  if (adminServer) await startAdminListener(adminServer);
  if (threadService) app.log.info({ db: basename(threadDbPath) }, 'threads enabled');
  app.log.info(
    { sentry: sentryEnabled, calls: calls !== undefined, auth: env.AUTH_MODE },
    'gateway ready',
  );
} catch (error) {
  app.log.fatal({ err: error }, 'failed to start');
  await flushSentry();
  process.exit(1);
}
