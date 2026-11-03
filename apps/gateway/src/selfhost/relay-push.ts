import {
  base64urlDecode,
  deriveSealKey,
  MAX_SEAL_PLAINTEXT_BYTES,
  seal,
  type RelayPushRequest,
} from '@twring/contracts';
import type { PushOptions, PushOutcome, PushPayload, PushSender, PushTarget } from '@twring/push';

import type { RingPhones } from '../ring/service';
import type { CredentialCipher } from '../store/cipher';

import { deviceSealAad, type DeviceTokenRepository } from './people';
import type { RelayPushResult } from './relay-client';

export type RelayPushKind = RelayPushRequest['kind'];

/** The relay's kind for a push: a ring that ended as missed is a missed call. */
export function relayKindFor(data: PushPayload): RelayPushKind {
  switch (data.type) {
    case 'cord.ring':
      return 'ring';
    case 'cord.ring_cancel':
      return data.status === 'missed' ? 'missed_call' : 'ring_cancel';
    case 'cord.message':
      return 'message';
  }
}

const encoder = new TextEncoder();

/** Fields cut short, in this order, when a payload would not fit in a sealed envelope. */
const TRIMMABLE = ['preview', 'reason', 'agent_name'] as const;

/**
 * The sealed plaintext: the push as the app handles it today, plus `kind`, the call or message
 * `id` and `issued_at`, which the phone checks against the outer kind and for freshness (so a
 * sealed push can be neither relabelled nor replayed). Long text is trimmed to fit; never throws.
 */
export function sealedPlaintext(
  data: PushPayload,
  kind: RelayPushKind,
  issuedAt: Date,
): Uint8Array {
  const body: Record<string, unknown> = {
    ...data,
    kind,
    id: data.type === 'cord.message' ? data.message_id : data.invite_id,
    issued_at: issuedAt.toISOString(),
  };
  let bytes = encoder.encode(JSON.stringify(body));
  for (const field of TRIMMABLE) {
    let value = body[field];
    if (typeof value !== 'string') continue;
    let chars = Array.from(value);
    while (bytes.length > MAX_SEAL_PLAINTEXT_BYTES && chars.length > 0) {
      chars = chars.slice(0, Math.floor(chars.length * 0.8));
      value = chars.join('');
      body[field] = value;
      bytes = encoder.encode(JSON.stringify(body));
    }
    if (bytes.length <= MAX_SEAL_PLAINTEXT_BYTES) break;
  }
  return bytes;
}

/** The relay caps a push's life at an hour (rings at a minute). */
const MAX_TTL_SECONDS = 3600;

export interface RelayPushSenderOptions {
  relay: { push(request: RelayPushRequest): Promise<RelayPushResult> };
  devices: DeviceTokenRepository;
  cipher: CredentialCipher;
  now?: () => Date;
  /** The relay said the ring service is paused or expired for this install. */
  onRingState?: (state: 'paused' | 'expired') => void;
}

/**
 * Self-hosted push: every ring, ring end and message goes to Twring's relay, sealed to the phone
 * (X25519 between the phone's key and this server's key for that phone), so the relay sees only
 * the kind, the size and the handle. `target.token` is the paired device id: the push is sealed
 * for that device and sent to its own handle, never found by handle.
 */
export class RelayPushSender implements PushSender {
  private readonly now: () => Date;

  constructor(private readonly options: RelayPushSenderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async send(target: PushTarget, data: PushPayload, options?: PushOptions): Promise<PushOutcome> {
    // A phone that has not registered with the relay yet: it sees rings when the app is open.
    const device = await this.options.devices.get(target.token);
    const handle = device?.removed_at === undefined ? device?.relay_handle : undefined;
    if (device === undefined || handle === undefined) return 'skipped';

    const kind = relayKindFor(data);
    let key: Uint8Array;
    try {
      const privateKey = base64urlDecode(
        this.options.cipher.open(device.server_seal_private_key, deviceSealAad(device.id)),
      );
      key = deriveSealKey(privateKey, base64urlDecode(device.seal_public_key));
      privateKey.fill(0);
    } catch {
      return 'failed';
    }
    const sealed = seal(key, sealedPlaintext(data, kind, this.now()));
    key.fill(0);

    const { priority, ttlSeconds } = options ?? { priority: 'high', ttlSeconds: 30 };
    const result = await this.options.relay.push({
      handle,
      kind,
      sealed,
      ttl_seconds: Math.min(Math.max(1, Math.round(ttlSeconds)), MAX_TTL_SECONDS),
      priority,
    });
    switch (result) {
      case 'sent':
        return 'sent';
      case 'invalid':
        return 'invalid';
      case 'unsupported':
        return 'skipped';
      case 'paused':
      case 'expired':
        this.options.onRingState?.(result);
        return 'failed';
      case 'limited':
      case 'failed':
        return 'failed';
    }
  }
}

/**
 * The ring service's phones in self-hosted mode: the person's paired phones that registered with
 * the relay (ruling R4: one with no handle cannot ring, so a person with none is refused
 * `no_ring_phone` at once). An `invalid` answer forgets that handle unless the phone has sent a
 * newer one since; the app registers again on its next open.
 */
export function relayRingPhones(devices: DeviceTokenRepository): RingPhones {
  return async (userId) =>
    (await devices.listFor(userId)).flatMap((device) => {
      const handle = device.relay_handle;
      if (handle === undefined) return [];
      return [
        {
          target: { token: device.id, platform: device.platform },
          forget: async () => {
            await devices.clearRelayHandle(device.id, handle);
          },
        },
      ];
    });
}
