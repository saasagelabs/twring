import { generateKeyPairSync } from 'node:crypto';

import type { MessagePush, RingCancelPush, RingPush } from '@twring/contracts';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { apnsRequestFor, ApnsPushSender, type ApnsResponse, type ApnsTransport } from './apns';
import type { PushSender } from './fcm';
import { RoutedPushSender } from './routed';

const BUNDLE = 'com.twring.app';
const VOIP = 'a'.repeat(64);
const ALERT = 'b'.repeat(64);
const keyPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const ring: RingPush = {
  type: 'cord.ring',
  invite_id: 'inv_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  agent_id: 'agt_aaaaaaaaaaaaaaaaaaaa',
  agent_name: 'Hermes',
  reason: 'The build failed',
  expires_at: '2026-10-20T10:00:30.000Z',
  server_time: '2026-10-20T10:00:00.000Z',
};
const cancel = (status: RingCancelPush['status']): RingCancelPush => ({
  type: 'cord.ring_cancel',
  invite_id: ring.invite_id,
  status,
  agent_name: 'Hermes',
});
const message: MessagePush = {
  type: 'cord.message',
  user_ref: '0123456789abcdef',
  agent_id: ring.agent_id,
  agent_name: 'Hermes',
  message_id: 'msg_aaaaaaaaaaaaaaaaaaaa',
  preview: 'Done. All tests pass.',
  silent: '0',
};

describe('what an iPhone gets', () => {
  const ios = { token: VOIP, platform: 'ios' as const, apnsToken: ALERT };

  it('rings with a VoIP push to the VoIP token, and nothing else is VoIP', () => {
    expect(apnsRequestFor(ios, ring, BUNDLE)).toMatchObject({
      token: VOIP,
      pushType: 'voip',
      topic: 'com.twring.app.voip',
      priority: 10,
      ttlSeconds: 30,
      body: ring,
    });
    for (const data of [message, cancel('missed'), cancel('answered'), cancel('cancelled')]) {
      expect(apnsRequestFor(ios, data, BUNDLE)?.pushType).not.toBe('voip');
    }
  });

  it('turns a message into an alert on the alert token, quiet when silent', () => {
    expect(apnsRequestFor(ios, message, BUNDLE)).toMatchObject({
      token: ALERT,
      pushType: 'alert',
      topic: BUNDLE,
      priority: 10,
      collapseId: message.message_id,
      body: {
        aps: {
          alert: { title: 'Hermes', body: 'Done. All tests pass.' },
          sound: 'default',
          'thread-id': message.agent_id,
        },
        message_id: message.message_id,
      },
    });
    const quiet = apnsRequestFor(ios, { ...message, silent: '1' }, BUNDLE);
    expect(quiet?.priority).toBe(5);
    expect(quiet?.body.aps).toMatchObject({ 'interruption-level': 'passive' });
    expect(quiet?.body.aps).not.toHaveProperty('sound');
  });

  it('shows a missed call, and quietly closes the call screen for any other end', () => {
    expect(apnsRequestFor(ios, cancel('missed'), BUNDLE)).toMatchObject({
      pushType: 'alert',
      body: { aps: { alert: { title: 'Hermes', body: 'Missed call' } }, status: 'missed' },
    });
    expect(apnsRequestFor(ios, cancel('answered'), BUNDLE)).toMatchObject({
      token: ALERT,
      pushType: 'background',
      priority: 5,
      body: { aps: { 'content-available': 1 }, status: 'answered' },
    });
  });

  it('skips alerts for a phone that gave no alert token', () => {
    const voipOnly = { token: VOIP, platform: 'ios' as const };
    expect(apnsRequestFor(voipOnly, message, BUNDLE)).toBeUndefined();
    expect(apnsRequestFor(voipOnly, cancel('missed'), BUNDLE)).toBeUndefined();
    expect(apnsRequestFor(voipOnly, ring, BUNDLE)?.pushType).toBe('voip');
  });
});

function fakeApple(...responses: (ApnsResponse | Error)[]) {
  const calls: { origin: string; path: string; headers: Record<string, string>; body: string }[] =
    [];
  const transport: ApnsTransport = {
    post: vi.fn((origin: string, path: string, headers: Record<string, string>, body: string) => {
      calls.push({ origin, path, headers, body });
      const next = responses.shift() ?? { status: 200, body: '' };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }),
    close: vi.fn(),
  };
  return { transport, calls };
}

function sender(transport: ApnsTransport, now = () => Date.parse('2026-10-20T10:00:00Z')) {
  return new ApnsPushSender(
    {
      keyPem,
      keyId: 'ABCDE12345',
      teamId: 'ZMVQWM9XL2',
      bundleId: BUNDLE,
      environment: 'production',
    },
    transport,
    { now, retryDelayMs: 0 },
  );
}

describe('ApnsPushSender', () => {
  it('posts to APNs with a signed provider token and the right headers', async () => {
    const apple = fakeApple({ status: 200, body: '' });
    const outcome = await sender(apple.transport).send({ token: VOIP, platform: 'ios' }, ring);
    expect(outcome).toBe('sent');
    const [call] = apple.calls;
    expect(call?.origin).toBe('https://api.push.apple.com');
    expect(call?.path).toBe(`/3/device/${VOIP}`);
    expect(call?.headers).toMatchObject({
      'apns-topic': 'com.twring.app.voip',
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': String(Date.parse('2026-10-20T10:00:00Z') / 1000 + 30),
    });
    const jwt = call!.headers.authorization!.replace(/^bearer /, '');
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'ABCDE12345' });
    expect(decodeJwt(jwt)).toMatchObject({ iss: 'ZMVQWM9XL2' });
    expect(JSON.parse(call!.body)).toEqual(ring);
  });

  it('reuses the provider token, and signs a new one after 50 minutes', async () => {
    let clock = Date.parse('2026-10-20T10:00:00Z');
    const apple = fakeApple();
    const apns = sender(apple.transport, () => clock);
    await apns.send({ token: VOIP }, ring);
    await apns.send({ token: VOIP }, ring);
    clock += 51 * 60_000;
    await apns.send({ token: VOIP }, ring);
    const tokens = apple.calls.map((c) => c.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[0]);
  });

  it('forgets an uninstalled phone: 410, BadDeviceToken, or a token for another app', async () => {
    for (const response of [
      { status: 410, body: '{"reason":"Unregistered"}' },
      { status: 400, body: '{"reason":"BadDeviceToken"}' },
      { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' },
    ]) {
      expect(await sender(fakeApple(response).transport).send({ token: VOIP }, ring)).toBe(
        'invalid',
      );
    }
  });

  it('re-signs and retries once when Apple calls the provider token expired', async () => {
    const apple = fakeApple(
      { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      { status: 200, body: '' },
    );
    expect(await sender(apple.transport).send({ token: VOIP }, ring)).toBe('sent');
    expect(apple.calls).toHaveLength(2);
  });

  it('retries once on a network error, 429 or 5xx, and gives up on other 4xx', async () => {
    expect(
      await sender(fakeApple(new Error('reset'), { status: 200, body: '' }).transport).send(
        { token: VOIP },
        ring,
      ),
    ).toBe('sent');
    expect(
      await sender(fakeApple({ status: 503, body: '' }, { status: 429, body: '' }).transport).send(
        { token: VOIP },
        ring,
      ),
    ).toBe('failed');
    const badRequest = fakeApple({ status: 400, body: '{"reason":"PayloadTooLarge"}' });
    expect(await sender(badRequest.transport).send({ token: VOIP }, ring)).toBe('failed');
    expect(badRequest.calls).toHaveLength(1);
  });

  it('sends nothing when the push has no iOS form', async () => {
    const apple = fakeApple();
    expect(await sender(apple.transport).send({ token: VOIP, platform: 'ios' }, message)).toBe(
      'skipped',
    );
    expect(apple.calls).toHaveLength(0);
  });

  it('uses the sandbox host for development builds', async () => {
    const apple = fakeApple();
    await new ApnsPushSender(
      {
        keyPem,
        keyId: 'ABCDE12345',
        teamId: 'ZMVQWM9XL2',
        bundleId: BUNDLE,
        environment: 'sandbox',
      },
      apple.transport,
      { retryDelayMs: 0 },
    ).send({ token: VOIP }, ring);
    expect(apple.calls[0]?.origin).toBe('https://api.sandbox.push.apple.com');
  });
});

describe('RoutedPushSender', () => {
  const fake = () => {
    const send = vi.fn(() => Promise.resolve('sent' as const));
    const sender: PushSender = { send };
    return { send, sender };
  };

  it('sends Android to FCM and iOS to APNs, and skips a platform that is off', async () => {
    const android = fake();
    const ios = fake();
    const both = new RoutedPushSender({ android: android.sender, ios: ios.sender });
    await both.send({ token: 'fcm-token', platform: 'android' }, ring);
    await both.send({ token: VOIP, platform: 'ios' }, ring);
    expect(android.send).toHaveBeenCalledTimes(1);
    expect(ios.send).toHaveBeenCalledTimes(1);
    expect(both.ringPlatforms()).toEqual(['android', 'ios']);

    const androidOnly = new RoutedPushSender({ android: android.sender });
    expect(await androidOnly.send({ token: VOIP, platform: 'ios' }, ring)).toBe('skipped');
    expect(androidOnly.ringPlatforms()).toEqual(['android']);
  });

  it('treats a phone with no platform as Android (rows from before iOS)', async () => {
    const android = fake();
    await new RoutedPushSender({ android: android.sender }).send({ token: 'fcm-token' }, ring);
    expect(android.send).toHaveBeenCalledTimes(1);
  });
});
