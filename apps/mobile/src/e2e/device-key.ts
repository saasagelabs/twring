import { x25519 } from '@noble/curves/ed25519.js';
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

/** This phone's device key, or undefined when it has none (nothing is created). */
export async function loadDeviceKey(store: SecureKeyValue): Promise<DeviceKey | undefined> {
  return read(await store.getItemAsync(DEVICE_KEY_NAME));
}

/**
 * Puts back a device key from a recovery backup (C3 #11): the same key, so the same device id.
 * The seq counter jumps to the clock in milliseconds, past anything the old phone could have
 * sent, so the computer never drops the restored phone's messages as replays.
 */
export async function restoreDeviceKey(
  store: SecureKeyValue,
  privateKey: Uint8Array,
  now: () => number = Date.now,
): Promise<DeviceKey> {
  const publicKey = x25519.getPublicKey(privateKey);
  await store.setItemAsync(
    DEVICE_KEY_NAME,
    JSON.stringify({
      v: 1,
      public_key: base64urlEncode(publicKey),
      private_key: base64urlEncode(privateKey),
    }),
  );
  const raw = await store.getItemAsync(SEQ_KEY_NAME);
  const last = raw === null ? 0 : Number(raw);
  const floor = Math.floor(now());
  if (!Number.isSafeInteger(last) || last < floor)
    await store.setItemAsync(SEQ_KEY_NAME, String(floor));
  return { deviceId: deviceIdFor(publicKey), publicKey, privateKey };
}

/** This phone's device id, without making a key when there is none (the devices screen). */
export async function readDeviceId(store: SecureKeyValue): Promise<string | undefined> {
  return read(await store.getItemAsync(DEVICE_KEY_NAME))?.deviceId;
}

/** The next seq this phone seals with, saved before it is handed out: never reused. */
/** One counter update at a time per keychain, so two quick sends never read the same seq. */
const seqLocks = new WeakMap<SecureKeyValue, Promise<unknown>>();

/**
 * The seq is max(saved + 1, clock in ms). A restored phone shares its key (so its device id and
 * seq lane) with the old phone, which may still be in use; both follow the clock, so neither falls
 * more than the 64-wide replay window behind the other and the computer drops neither.
 */
export function nextSeq(store: SecureKeyValue, now: () => number = Date.now): Promise<number> {
  const previous = seqLocks.get(store) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => takeSeq(store, now));
  seqLocks.set(store, next);
  return next;
}

async function takeSeq(store: SecureKeyValue, now: () => number): Promise<number> {
  const raw = await store.getItemAsync(SEQ_KEY_NAME);
  const last = raw === null ? 0 : Number(raw);
  // A damaged counter must never restart at 1: the computer would drop those as replays.
  if (!Number.isSafeInteger(last) || last < 0) throw new Error('private chat counter damaged');
  const clock = Math.floor(now());
  const seq = Number.isSafeInteger(clock) && clock > last ? clock : last + 1;
  await store.setItemAsync(SEQ_KEY_NAME, String(seq));
  return seq;
}

/** On sign-out: the key and its counter go together. */
export async function forgetDeviceKey(store: SecureKeyValue): Promise<void> {
  await store.deleteItemAsync(DEVICE_KEY_NAME);
  await store.deleteItemAsync(SEQ_KEY_NAME);
}
