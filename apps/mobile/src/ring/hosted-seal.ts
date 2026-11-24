import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  type DeviceRegistrationResponse,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import type { SealKeys } from '../platform/seal-keys';

import type { RegisterDeviceRequest } from './protocol';
import type { PushRegistrationDeps } from './push-registration';

type RegistrationCalls = Pick<PushRegistrationDeps, 'register' | 'unregister'>;

/** This install's X25519 key pair for hosted message pushes, made once and kept in the keychain. */
export const HOSTED_SEAL_KEY = 'cord.hosted_seal_key';
/** The native seal key slot for Twring's own service (self-hosted servers use their id). */
export const HOSTED_SEAL_SLOT = 'hosted';

const storedPairSchema = z.object({ public: z.string().min(1), private: z.string().min(1) });

export interface HostedSealDeps {
  register(
    deviceId: string,
    request: RegisterDeviceRequest,
  ): Promise<DeviceRegistrationResponse | undefined>;
  unregister(deviceId: string): Promise<void>;
  store: SecureKeyValue;
  sealKeys: Pick<SealKeys, 'set' | 'remove'>;
  /** Tests inject this; defaults to the contracts generator. */
  keyPair?: () => { publicKey: Uint8Array; privateKey: Uint8Array };
}

/**
 * Hosted push registration that also sets up sealed message previews (ADR-043 Phase B): the
 * phone sends its public key, derives the shared key from the server's answer and hands it to the
 * native push handler, which opens `cord.sealed` pushes with it. Anything wrong with the key
 * (keychain unreadable, old server) falls back to a plain registration and the redacted push.
 * The private key never leaves this phone and is never logged.
 */
export function hostedSealCalls(deps: HostedSealDeps): RegistrationCalls {
  async function loadPair(): Promise<{ publicKey: string; privateKey: string }> {
    const stored = await deps.store.getItemAsync(HOSTED_SEAL_KEY);
    if (stored !== null && stored !== '') {
      try {
        const parsed = storedPairSchema.parse(JSON.parse(stored));
        return { publicKey: parsed.public, privateKey: parsed.private };
      } catch {
        // Unreadable: make a new pair below.
      }
    }
    const pair = (deps.keyPair ?? generateSealKeyPair)();
    const value = {
      public: base64urlEncode(pair.publicKey),
      private: base64urlEncode(pair.privateKey),
    };
    pair.privateKey.fill(0);
    await deps.store.setItemAsync(HOSTED_SEAL_KEY, JSON.stringify(value));
    return { publicKey: value.public, privateKey: value.private };
  }

  return {
    async register(deviceId, request) {
      let pair: { publicKey: string; privateKey: string } | undefined;
      try {
        pair = await loadPair();
      } catch {
        pair = undefined;
      }
      const answer = await deps.register(
        deviceId,
        pair === undefined ? request : { ...request, seal_public_key: pair.publicKey },
      );
      const serverKey = answer?.seal_server_public_key;
      if (pair === undefined || serverKey === undefined) {
        await deps.sealKeys.remove(HOSTED_SEAL_SLOT).catch(() => undefined);
        return;
      }
      try {
        const privateKey = base64urlDecode(pair.privateKey);
        const shared = deriveSealKey(privateKey, base64urlDecode(serverKey));
        privateKey.fill(0);
        await deps.sealKeys.set(HOSTED_SEAL_SLOT, base64urlEncode(shared));
        shared.fill(0);
      } catch {
        await deps.sealKeys.remove(HOSTED_SEAL_SLOT).catch(() => undefined);
      }
    },
    async unregister(deviceId) {
      try {
        await deps.unregister(deviceId);
      } finally {
        await deps.sealKeys.remove(HOSTED_SEAL_SLOT).catch(() => undefined);
      }
    },
  };
}
