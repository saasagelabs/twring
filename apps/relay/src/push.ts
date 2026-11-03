import type { RelayPushRequest } from '@twring/contracts';
import type { ApnsRequest, PushOptions, PushOutcome } from '@twring/push';

import type { RelayDevice } from './devices';

/** The `type` a phone sees on every relay push; the real push is inside `sealed`. */
export const SEALED_PUSH_TYPE = 'cord.sealed';
/** What an iPhone shows for a message before the app can open the envelope. */
export const SEALED_MESSAGE_TEXT = 'New message on your Twring server.';
const MISSED_CALL_TEXT = 'Missed call';
/** A ring older than this can no longer be answered, whatever the server asked for. */
export const RING_MAX_TTL_SECONDS = 60;

/** The time to live the relay uses: rings capped at 60 s, other kinds as requested. */
export function ttlFor(push: RelayPushRequest): number {
  return push.kind === 'ring' ? Math.min(push.ttl_seconds, RING_MAX_TTL_SECONDS) : push.ttl_seconds;
}

/**
 * The relay's push services, behind a small interface so tests use fakes. Production wires the
 * shared FCM and APNs senders (`@twring/push`); a missing one means that platform is not served.
 */
export interface RelaySenders {
  fcm?: (
    token: string,
    data: Readonly<Record<string, string>>,
    options: PushOptions,
  ) => Promise<PushOutcome>;
  apns?: { bundleId: string; send: (request: ApnsRequest) => Promise<PushOutcome> };
}

/** The string data every relay push carries: the kind and the sealed envelope, nothing else. */
export function sealedData(push: RelayPushRequest): Record<string, string> {
  return { type: SEALED_PUSH_TYPE, kind: push.kind, sealed: JSON.stringify(push.sealed) };
}

/**
 * The APNs request for an iPhone: rings through PushKit (VoIP token), messages and missed calls as
 * alerts with fixed text (the app's extension opens the envelope), a cancelled ring as a silent
 * background push. Undefined when the phone has no token for that form.
 */
export function apnsRequestForSealed(
  device: RelayDevice,
  push: RelayPushRequest,
  bundleId: string,
): ApnsRequest | undefined {
  const data = sealedData(push);
  if (push.kind === 'ring') {
    if (device.voipToken === undefined) return undefined;
    return {
      token: device.voipToken,
      pushType: 'voip',
      topic: `${bundleId}.voip`,
      priority: 10,
      ttlSeconds: ttlFor(push),
      body: data,
    };
  }
  if (device.apnsToken === undefined) return undefined;
  if (push.kind === 'ring_cancel') {
    return {
      token: device.apnsToken,
      pushType: 'background',
      topic: bundleId,
      priority: 5,
      ttlSeconds: ttlFor(push),
      body: { aps: { 'content-available': 1 }, ...data },
    };
  }
  const text = push.kind === 'message' ? SEALED_MESSAGE_TEXT : MISSED_CALL_TEXT;
  return {
    token: device.apnsToken,
    pushType: 'alert',
    topic: bundleId,
    priority: push.priority === 'high' ? 10 : 5,
    ttlSeconds: ttlFor(push),
    body: {
      aps: { alert: { body: text }, sound: 'default', 'mutable-content': 1 },
      ...data,
    },
  };
}

/** A push ready to go: the token it goes to (for per-token limits) and the send itself. */
export interface PlannedPush {
  token: string;
  send: () => Promise<PushOutcome>;
}

/**
 * How one sealed push reaches one phone, or undefined when it never can (no token for this kind,
 * or the relay has no service for the platform). Nothing is sent until `send` is called.
 */
export function planDelivery(
  senders: RelaySenders,
  device: RelayDevice,
  push: RelayPushRequest,
): PlannedPush | undefined {
  if (device.platform === 'android') {
    const { fcm } = senders;
    const token = device.fcmToken;
    if (fcm === undefined || token === undefined) return undefined;
    return {
      token,
      send: () =>
        fcm(token, sealedData(push), { priority: push.priority, ttlSeconds: ttlFor(push) }),
    };
  }
  const { apns } = senders;
  if (apns === undefined) return undefined;
  const request = apnsRequestForSealed(device, push, apns.bundleId);
  return request === undefined
    ? undefined
    : { token: request.token, send: () => apns.send(request) };
}
