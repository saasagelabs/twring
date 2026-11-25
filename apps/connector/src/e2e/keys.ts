import {
  base64urlEncode,
  deviceIdFor,
  e2eDeviceIdSchema,
  e2eDeviceKindSchema,
  generateSealKeyPair,
  publicKeySchema,
} from '@twring/contracts';
import { z } from 'zod';

import type { ConnectorConfig } from '../config';

/**
 * This computer's device key for private chats (ADR-044) and the phones it verified at pairing.
 * The private key never leaves the config file (mode 600) and is never printed or logged.
 */

/** A device this computer checked itself at pairing (MAC and safety code), so it may wrap to it. */
export const trustedDeviceSchema = z
  .object({
    id: e2eDeviceIdSchema,
    kind: e2eDeviceKindSchema,
    name: z.string().min(1).max(60),
    public_key: publicKeySchema,
    verified_at: z.iso.datetime(),
  })
  .strict();
export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;

export const e2eConfigSchema = z
  .object({
    device_id: e2eDeviceIdSchema,
    public_key: publicKeySchema,
    private_key: publicKeySchema,
    devices: z.array(trustedDeviceSchema).max(16),
    /**
     * Phones checked at pairing (MAC and code) whose server add is not known to have finished.
     * Never wrapped to: they move to `devices` once the add succeeds or the server lists them.
     */
    pending: z.array(trustedDeviceSchema).max(4).optional(),
    /**
     * Devices the server has said were removed (newest last, at most MAX_REVOKED_SEEN). A trust
     * note never brings one of these back, even when the server lists it as active again.
     */
    revoked: z.array(e2eDeviceIdSchema).max(32).optional(),
    /** The last seq this computer sealed with; never reused, even across restarts. */
    seq: z.number().int().nonnegative(),
    /** Highest seq opened per sender device, so a restart does not reopen old replays. */
    seen: z.record(e2eDeviceIdSchema, z.number().int().nonnegative()).optional(),
  })
  .strict();
export type E2eConfig = z.infer<typeof e2eConfigSchema>;

/** The config with a device key, made once per install. */
export function ensureDeviceKey(config: ConnectorConfig): {
  config: ConnectorConfig;
  created: boolean;
} {
  if (config.e2e !== undefined) return { config, created: false };
  const pair = generateSealKeyPair();
  return {
    config: {
      ...config,
      e2e: {
        device_id: deviceIdFor(pair.publicKey),
        public_key: base64urlEncode(pair.publicKey),
        private_key: base64urlEncode(pair.privateKey),
        devices: [],
        seq: 0,
      },
    },
    created: true,
  };
}

/** The next seq to seal with. Save the returned config before the seq is used. */
export function nextSeq(config: ConnectorConfig): { config: ConnectorConfig; seq: number } {
  if (config.e2e === undefined) throw new Error('no device key');
  const seq = config.e2e.seq + 1;
  return { config: { ...config, e2e: { ...config.e2e, seq } }, seq };
}

/** Phones this computer trusts: private chats are on only when there is at least one. */
export function trustedPhones(config: ConnectorConfig): TrustedDevice[] {
  return config.e2e?.devices.filter((device) => device.kind === 'phone') ?? [];
}
