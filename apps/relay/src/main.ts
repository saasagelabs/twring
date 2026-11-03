import { ApnsPushSender, FcmPushSender, loadApnsKey, loadServiceAccount } from '@twring/push';
import { pino } from 'pino';

import { buildApp } from './app';
import { ConfigError, loadRelayEnv } from './config';
import { openRelayDb } from './db';
import { createResendSender, createSkippingSender } from './email';
import { loadPartners } from './installs';
import { createLoggerOptions } from './logger';
import type { RelaySenders } from './push';

async function main(): Promise<void> {
  const env = loadRelayEnv(process.env);
  const log = pino(createLoggerOptions(env));
  const db = openRelayDb(env.RELAY_DB_FILE);
  const partners =
    env.RELAY_PARTNER_TOKENS_FILE === undefined
      ? []
      : await loadPartners(env.RELAY_PARTNER_TOKENS_FILE);
  const email =
    env.RELAY_RESEND_API_KEY === undefined
      ? createSkippingSender(log)
      : createResendSender({ apiKey: env.RELAY_RESEND_API_KEY, from: env.RELAY_EMAIL_FROM, log });
  const senders: RelaySenders = {};
  if (env.RELAY_FCM_SERVICE_ACCOUNT_FILE !== undefined) {
    const fcm = new FcmPushSender({
      account: await loadServiceAccount(env.RELAY_FCM_SERVICE_ACCOUNT_FILE),
    });
    senders.fcm = (token, data, options) => fcm.sendData(token, data, options);
  } else {
    log.warn({ event: 'push_unconfigured' }, 'No FCM service account: Android phones get no rings');
  }
  let apns: ApnsPushSender | undefined;
  if (env.RELAY_APNS_KEY_FILE !== undefined && env.RELAY_APNS_KEY_ID && env.RELAY_APNS_TEAM_ID) {
    apns = new ApnsPushSender({
      keyPem: await loadApnsKey(env.RELAY_APNS_KEY_FILE),
      keyId: env.RELAY_APNS_KEY_ID,
      teamId: env.RELAY_APNS_TEAM_ID,
      bundleId: env.RELAY_APNS_BUNDLE_ID,
      environment: env.RELAY_APNS_ENV,
    });
    const sender = apns;
    senders.apns = {
      bundleId: env.RELAY_APNS_BUNDLE_ID,
      send: (request) => sender.sendRequest(request),
    };
  } else {
    log.warn({ event: 'apns_unconfigured' }, 'No APNs key: iPhones get no rings');
  }
  const app = await buildApp({ env, db, email, partners, senders });

  const stop = async () => {
    await app.close();
    apns?.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop());
  process.once('SIGINT', () => void stop());

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('The relay failed to start:', error instanceof Error ? error.name : 'unknown');
  }
  process.exit(1);
});
