import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeJwt, decodeProtectedHeader } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FCM_SCOPE,
  FcmPushSender,
  GOOGLE_TOKEN_URL,
  loadServiceAccount,
  type FetchFn,
  type ServiceAccount,
} from './fcm';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT: ServiceAccount = {
  project_id: 'cord-push',
  client_email: 'push@cord-push.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const RING = {
  type: 'cord.ring',
  invite_id: `inv_${'a'.repeat(26)}`,
  agent_id: `agt_${'a'.repeat(20)}`,
  agent_name: 'Laptop Claude',
  reason: 'The build failed',
  expires_at: '2026-10-01T09:00:30.000Z',
  server_time: '2026-10-01T09:00:00.000Z',
} as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fcm(sendAnswers: (() => Response)[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  let tokens = 0;
  const fetch: FetchFn = (url, init) => {
    calls.push({ url, init });
    if (url === GOOGLE_TOKEN_URL) {
      tokens += 1;
      return Promise.resolve(json(200, { access_token: `ya29.token${tokens}`, expires_in: 3600 }));
    }
    return Promise.resolve((sendAnswers.shift() ?? (() => json(200, { name: 'm' })))());
  };
  return { fetch, calls, tokenCount: () => tokens };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('FCM push', () => {
  it('sends message data at NORMAL priority with a one-day TTL', async () => {
    const f = fcm();
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, retryDelayMs: 0 });
    await sender.send(
      { token: 'device-token' },
      {
        type: 'cord.message',
        user_ref: 'a'.repeat(16),
        agent_id: RING.agent_id,
        agent_name: RING.agent_name,
        message_id: `msg_${'a'.repeat(20)}`,
        preview: 'Done',
        silent: '0',
      },
      { priority: 'normal', ttlSeconds: 86400 },
    );
    const body = JSON.parse(f.calls[1]!.init.body as string) as { message: { android: unknown } };
    expect(body.message.android).toEqual({ priority: 'NORMAL', ttl: '86400s' });
  });
  it('sends a data-only HIGH message with a 30 s TTL, authenticated by a signed JWT', async () => {
    const f = fcm();
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, retryDelayMs: 0 });
    expect(await sender.send({ token: 'device-token' }, RING)).toBe('sent');

    const [exchange, send] = f.calls;
    const form = new URLSearchParams(exchange!.init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion')!;
    expect(decodeProtectedHeader(assertion).alg).toBe('RS256');
    expect(decodeJwt(assertion)).toMatchObject({
      iss: ACCOUNT.client_email,
      aud: GOOGLE_TOKEN_URL,
      scope: FCM_SCOPE,
    });

    expect(send!.url).toBe('https://fcm.googleapis.com/v1/projects/cord-push/messages:send');
    expect((send!.init.headers as Record<string, string>).authorization).toBe('Bearer ya29.token1');
    const body = JSON.parse(send!.init.body as string) as { message: unknown };
    expect(body.message).toMatchObject({
      token: 'device-token',
      data: RING,
      android: { priority: 'HIGH', ttl: '30s' },
      // A background APNs push must be priority 5; Apple rejects 10 with push-type background.
      apns: { headers: { 'apns-priority': '5', 'apns-push-type': 'background' } },
    });
    expect(body.message).not.toHaveProperty('notification');
  });

  it('never sends the signed assertion to the file’s token_uri (verifier)', async () => {
    const f = fcm();
    const sender = new FcmPushSender({
      account: { ...ACCOUNT, token_uri: 'https://attacker.example/token' },
      fetch: f.fetch,
      retryDelayMs: 0,
    });
    expect(await sender.send({ token: 'device-token' }, RING)).toBe('sent');
    expect(f.calls.map((c) => new URL(c.url).origin)).toEqual([
      'https://oauth2.googleapis.com',
      'https://fcm.googleapis.com',
    ]);
    expect(f.calls.every((c) => c.init.redirect === 'error')).toBe(true);
  });

  it('caches the access token until 5 minutes before it expires', async () => {
    let now = 1_000_000;
    const f = fcm();
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, now: () => now });
    await Promise.all([sender.accessToken(), sender.accessToken()]);
    await sender.send({ token: 't' }, RING);
    expect(f.tokenCount()).toBe(1);
    now += 54 * 60_000;
    await sender.accessToken();
    expect(f.tokenCount()).toBe(1);
    now += 2 * 60_000; // 56 minutes: inside the 5 minute margin.
    expect(await sender.accessToken()).toBe('ya29.token2');
  });

  it('UNREGISTERED and invalid registration tokens are reported invalid', async () => {
    const unregistered = () =>
      json(404, {
        error: {
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      });
    const invalid = () =>
      json(400, {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'The registration token is not a valid FCM registration token',
        },
      });
    const badPayload = () =>
      json(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid data payload key' } });
    const f = fcm([unregistered, invalid, badPayload]);
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, retryDelayMs: 0 });
    expect(await sender.send({ token: 'a' }, RING)).toBe('invalid');
    expect(await sender.send({ token: 'b' }, RING)).toBe('invalid');
    expect(await sender.send({ token: 'c' }, RING)).toBe('failed');
  });

  it('SENDER_ID_MISMATCH (a token from another Firebase project) is reported invalid', async () => {
    const mismatch = () =>
      json(403, {
        error: {
          status: 'PERMISSION_DENIED',
          message: 'SenderId mismatch',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'SENDER_ID_MISMATCH',
            },
          ],
        },
      });
    const f = fcm([mismatch]);
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, retryDelayMs: 0 });
    expect(await sender.send({ token: 'a' }, RING)).toBe('invalid');
    expect(f.calls.filter((c) => c.url !== GOOGLE_TOKEN_URL)).toHaveLength(1);
  });

  it('retries a transient failure once, then gives up', async () => {
    const f = fcm([() => json(503, {}), () => json(200, {})]);
    const sender = new FcmPushSender({ account: ACCOUNT, fetch: f.fetch, retryDelayMs: 0 });
    expect(await sender.send({ token: 'a' }, RING)).toBe('sent');
    const g = fcm([() => json(500, {}), () => json(500, {}), () => json(200, {})]);
    const giveUp = new FcmPushSender({ account: ACCOUNT, fetch: g.fetch, retryDelayMs: 0 });
    expect(await giveUp.send({ token: 'a' }, RING)).toBe('failed');
    expect(g.calls.filter((c) => c.url !== GOOGLE_TOKEN_URL)).toHaveLength(2);
  });

  it('loads the service account file without echoing it in errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cord-fcm-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const good = join(dir, 'sa.json');
    await writeFile(good, JSON.stringify({ ...ACCOUNT, type: 'service_account' }));
    expect((await loadServiceAccount(good)).project_id).toBe('cord-push');
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ private_key: 'SECRET-KEY-MATERIAL' }));
    await expect(loadServiceAccount(bad)).rejects.toThrow(/not a service account key/);
    await expect(loadServiceAccount(bad)).rejects.not.toThrow(/SECRET/);
    await expect(loadServiceAccount(join(dir, 'missing.json'))).rejects.toThrow(/missing/);
  });
});
