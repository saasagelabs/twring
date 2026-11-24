import {
  base64urlDecode,
  deriveSealKey,
  MAX_SEAL_PLAINTEXT_BYTES,
  seal,
  type MessagePush,
  type RelayPushRequest,
  type SealedEnvelope,
} from '@twring/contracts';
import type { PushPayload } from '@twring/push';

import type { CredentialCipher, SealedSecret } from '../store/cipher';

/**
 * Pushes sealed to one phone (X25519 between the phone's key and this server's key for that
 * phone), shared by the self-hosted relay path and hosted message pushes (ADR-043 Phase B).
 */

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

/** One phone's sealing keys as stored: the phone's public key, this server's private key sealed. */
export interface DeviceSealKeys {
  phonePublicKey: string;
  serverPrivateKey: SealedSecret;
  /** The AAD the server private key was sealed under (`deviceSealAad`). */
  aad: string;
}

/** The shared key for one phone. Throws when the stored key cannot be opened. */
export function deviceSealKey(cipher: CredentialCipher, keys: DeviceSealKeys): Uint8Array {
  const privateKey = base64urlDecode(cipher.open(keys.serverPrivateKey, keys.aad));
  try {
    return deriveSealKey(privateKey, base64urlDecode(keys.phonePublicKey));
  } finally {
    privateKey.fill(0);
  }
}

/**
 * A hosted message push sealed for one phone, or undefined when it cannot be (key unreadable):
 * the caller then sends the redacted push, never nothing. Never throws.
 */
export function sealMessageFor(
  cipher: CredentialCipher,
  keys: DeviceSealKeys,
  data: MessagePush,
  now: Date,
): SealedEnvelope | undefined {
  let key: Uint8Array;
  try {
    key = deviceSealKey(cipher, keys);
  } catch {
    return undefined;
  }
  try {
    return seal(key, sealedPlaintext(data, 'message', now));
  } catch {
    return undefined;
  } finally {
    key.fill(0);
  }
}
