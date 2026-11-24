import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  generateSealKeyPair,
  publicKeySchema,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';

/**
 * This phone's device key for private chats (ADR-044). The private key stays in the keychain
 * (through `platform/secure-store.ts`, `deviceOnlyStore`) and is never logged; the device id comes from the public
 * key (`deviceIdFor`), the same rule the computer uses, so each side can check the other's.
 */
export const DEVICE_KEY_NAME = 'twring.e2e.device.v1';
export const SEQ_KEY_NAME = 'twring.e2e.seq.v1';
/** The computers this phone verified (`pairing.ts`); cleared here when the key is replaced. */
export const TRUSTED_KEY_NAME = 'twring.e2e.trusted.v1';

const storedSchema = z
  .object({ v: z.literal(1), public_key: publicKeySchema, private_key: publicKeySchema })
  .strict();

export interface DeviceKey {
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

function read(raw: string | null): DeviceKey | undefined {
  if (raw === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = storedSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const privateKey = base64urlDecode(parsed.data.private_key);
  const publicKey = base64urlDecode(parsed.data.public_key);
  return { deviceId: deviceIdFor(publicKey), publicKey, privateKey };
}

export async function loadOrCreateDeviceKey(
  store: SecureKeyValue,
  log?: (event: string) => void,
): Promise<DeviceKey & { created: boolean }> {
  const raw = await store.getItemAsync(DEVICE_KEY_NAME);
  const found = read(raw);
  if (found !== undefined) return { ...found, created: false };
  if (raw !== null) {
    // A damaged key gets a new key and so a new device id: every paired computer would seal to a
    // phone that no longer exists, so they are forgotten and the chat asks to pair again
    // (P3b ruling 3). Cleared before the new key is saved, so a crash between cannot keep them.
    log?.('e2e_device_key_reset');
    await store.deleteItemAsync(TRUSTED_KEY_NAME);
  }
  const pair = generateSealKeyPair();
  await store.setItemAsync(
    DEVICE_KEY_NAME,
    JSON.stringify({
      v: 1,
      public_key: base64urlEncode(pair.publicKey),
      private_key: base64urlEncode(pair.privateKey),
    }),
  );
  return {
    deviceId: deviceIdFor(pair.publicKey),
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    created: true,
  };
}

/** The next seq this phone seals with, saved before it is handed out: never reused. */
export async function nextSeq(store: SecureKeyValue): Promise<number> {
  const raw = await store.getItemAsync(SEQ_KEY_NAME);
  const last = raw === null ? 0 : Number(raw);
  // A damaged counter must never restart at 1: the computer would drop those as replays.
  if (!Number.isSafeInteger(last) || last < 0) throw new Error('private chat counter damaged');
  const seq = last + 1;
  await store.setItemAsync(SEQ_KEY_NAME, String(seq));
  return seq;
}

/** On sign-out: the key and its counter go together. */
export async function forgetDeviceKey(store: SecureKeyValue): Promise<void> {
  await store.deleteItemAsync(DEVICE_KEY_NAME);
  await store.deleteItemAsync(SEQ_KEY_NAME);
}
