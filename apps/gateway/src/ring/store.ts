import {
  agentIdSchema,
  base64urlEncode,
  connectorIdSchema,
  DEFAULT_RING_SETTINGS,
  deviceIdSchema,
  generateSealKeyPair,
  deviceRegistrationSchema,
  inviteIdSchema,
  inviteStatusSchema,
  localAgentIdSchema,
  MAX_DEVICES_PER_USER,
  type MessagePush,
  ringSettingsSchema,
  type InviteStatus,
  type RingSettings,
  type SealedEnvelope,
} from '@twring/contracts';
import { z } from 'zod';

import { deviceSealAad } from '../selfhost/people';
import { sealedSecretSchema, type CredentialCipher } from '../store/cipher';
import type { Collection } from '../store/collection';

import { sealMessageFor } from './sealed-push';

/**
 * Storage for rings (ADR-024): push-registered phones, ring settings, and invites. Every row is
 * scoped by `user_id`. The push token is personal data: it is never logged and goes with the
 * device or with the user's data.
 */

export const deviceRecordSchema = deviceRegistrationSchema.extend({
  user_id: z.string().min(1),
  device_id: deviceIdSchema,
  updated_at: z.iso.datetime(),
  /**
   * With `seal_public_key`: this server's X25519 key pair for the phone, public in clear, private
   * sealed under `deviceSealAad(device_id)` (ADR-043 Phase B). Never logged.
   */
  server_seal_public_key: z.string().min(1).optional(),
  server_seal_private_key: sealedSecretSchema.optional(),
});
export type DeviceRecord = z.infer<typeof deviceRecordSchema>;

/** A phone's registration as the route takes it; the server seal keys are made here. */
export type DeviceRegistrationInput = Omit<
  DeviceRecord,
  'server_seal_public_key' | 'server_seal_private_key'
>;

export class DeviceRepository {
  private readonly now: () => Date;

  /** Without a `cipher` no seal keys are kept and every message push goes redacted. */
  constructor(
    private readonly rows: Collection<DeviceRecord>,
    private readonly cipher?: CredentialCipher,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async list(userId: string): Promise<DeviceRecord[]> {
    return (await this.rows.read()).filter((row) => row.user_id === userId);
  }

  /**
   * Upserts a phone. A token registered to another user (or another device) moves here: one token
   * reaches one phone, and that phone now belongs to this user. Past MAX_DEVICES_PER_USER, the
   * phone updated longest ago is dropped.
   *
   * With `seal_public_key`, resolves this server's public key for the phone: the same phone key
   * keeps its pair, a new one gets a fresh pair. Without it (an older app, or one that lost its
   * key) any stored pair goes with the old row.
   */
  upsert(input: DeviceRegistrationInput): Promise<string | undefined> {
    return this.rows.update((items) => {
      const previous = items.find(
        (row) => row.user_id === input.user_id && row.device_id === input.device_id,
      );
      const record = this.withSealKeys(input, previous);
      const others = items.filter(
        (row) =>
          row.fcm_token !== record.fcm_token &&
          !(row.user_id === record.user_id && row.device_id === record.device_id),
      );
      const mine = others
        .filter((row) => row.user_id === record.user_id)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const drop = new Set(mine.slice(MAX_DEVICES_PER_USER - 1));
      return {
        items: [...others.filter((row) => !drop.has(row)), record],
        result: record.server_seal_public_key,
      };
    });
  }

  private withSealKeys(input: DeviceRegistrationInput, previous?: DeviceRecord): DeviceRecord {
    const { seal_public_key: phoneKey, ...rest } = input;
    if (phoneKey === undefined || this.cipher === undefined) return rest;
    if (
      previous?.seal_public_key === phoneKey &&
      previous.server_seal_public_key !== undefined &&
      previous.server_seal_private_key !== undefined
    ) {
      return {
        ...rest,
        seal_public_key: phoneKey,
        server_seal_public_key: previous.server_seal_public_key,
        server_seal_private_key: previous.server_seal_private_key,
      };
    }
    const pair = generateSealKeyPair();
    try {
      return {
        ...rest,
        seal_public_key: phoneKey,
        server_seal_public_key: base64urlEncode(pair.publicKey),
        server_seal_private_key: this.cipher.seal(
          base64urlEncode(pair.privateKey),
          deviceSealAad(input.device_id),
        ),
      };
    } finally {
      pair.privateKey.fill(0);
    }
  }

  /**
   * Seals message pushes for a phone that sent a seal key, or undefined (redacted pushes). The
   * sealer returns undefined when the stored key cannot be opened.
   */
  messageSealer(
    device: DeviceRecord,
  ): ((data: MessagePush) => SealedEnvelope | undefined) | undefined {
    const cipher = this.cipher;
    const phonePublicKey = device.seal_public_key;
    const serverPrivateKey = device.server_seal_private_key;
    if (cipher === undefined || phonePublicKey === undefined || serverPrivateKey === undefined) {
      return undefined;
    }
    const keys = { phonePublicKey, serverPrivateKey, aad: deviceSealAad(device.device_id) };
    return (data) => sealMessageFor(cipher, keys, data, this.now());
  }

  delete(userId: string, deviceId: string): Promise<boolean> {
    return this.rows.update((items) => {
      const next = items.filter((row) => row.user_id !== userId || row.device_id !== deviceId);
      return { items: next, result: next.length !== items.length };
    });
  }

  /** Drops a token FCM reported as unregistered or invalid, whoever it belongs to. */
  deleteToken(token: string): Promise<void> {
    return this.rows.update((items) => ({
      items: items.filter((row) => row.fcm_token !== token),
      result: undefined,
    }));
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwned(this.rows, userId);
  }
}

export const ringSettingsRecordSchema = ringSettingsSchema.safeExtend({
  user_id: z.string().min(1),
});
export type RingSettingsRecord = z.infer<typeof ringSettingsRecordSchema>;

export class RingSettingsRepository {
  constructor(private readonly rows: Collection<RingSettingsRecord>) {}

  async get(userId: string): Promise<RingSettings> {
    const row = (await this.rows.read()).find((r) => r.user_id === userId);
    if (row === undefined) return DEFAULT_RING_SETTINGS;
    return {
      dnd: row.dnd,
      quiet_hours: row.quiet_hours,
      after_call_result: row.after_call_result ?? 'ring',
      call_transcripts: row.call_transcripts ?? false,
    };
  }

  put(userId: string, settings: RingSettings): Promise<RingSettings> {
    return this.rows.update((items) => {
      const previous = items.find((r) => r.user_id === userId);
      const merged = {
        ...settings,
        after_call_result: settings.after_call_result ?? previous?.after_call_result ?? 'ring',
        // An older app never sends it: changing Do Not Disturb must not turn transcripts off.
        call_transcripts: settings.call_transcripts ?? previous?.call_transcripts ?? false,
      };
      return {
        items: [...items.filter((r) => r.user_id !== userId), { ...merged, user_id: userId }],
        result: merged,
      };
    });
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwned(this.rows, userId);
  }
}

export const inviteRecordSchema = z.object({
  id: inviteIdSchema,
  user_id: z.string().min(1),
  connector_id: connectorIdSchema.optional(),
  local_agent: localAgentIdSchema.optional(),
  agent_id: agentIdSchema,
  agent_name: z.string(),
  reason: z.string().min(1).max(140),
  // Read leniently: a row stored before refs had to start with a letter or digit must not make the
  // whole file unreadable. Only a ref that passes sessionRefSchema is ever used (routes.ts).
  session_ref: z.string().max(200).optional(),
  message_id: z
    .string()
    .regex(/^msg_[a-z2-7]{20}$/)
    .optional(),
  status: inviteStatusSchema,
  note: z.string().max(60).optional(),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  handled_at: z.iso.datetime().optional(),
  /** The phone that answered (`POST /v1/invites/:id/answer` `device_id`), when it said. */
  answered_by: deviceIdSchema.optional(),
  /** The call the answer started, so the same phone can repeat a lost answer. */
  call_id: z.string().max(100).optional(),
});
export type InviteRecord = z.infer<typeof inviteRecordSchema>;

/** Invites older than this are pruned (the hourly ring limit only needs the last hour). */
const INVITE_RETENTION_MS = 24 * 60 * 60 * 1000;

export class InviteRepository {
  constructor(private readonly rows: Collection<InviteRecord>) {}

  all(): Promise<readonly InviteRecord[]> {
    return this.rows.read();
  }

  async get(userId: string, id: string): Promise<InviteRecord | undefined> {
    return (await this.rows.read()).find((row) => row.user_id === userId && row.id === id);
  }

  async list(userId: string, status?: InviteStatus): Promise<InviteRecord[]> {
    return (await this.rows.read())
      .filter((row) => row.user_id === userId && (status === undefined || row.status === status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /**
   * Adds `record` unless `refuse` (run under the collection lock, against the user's current
   * invites) names a reason not to. Prunes old invites on the way.
   */
  create<R extends string>(
    record: InviteRecord,
    now: Date,
    refuse: (mine: readonly InviteRecord[]) => R | undefined,
  ): Promise<R | undefined> {
    return this.rows.update((items) => {
      const cutoff = now.getTime() - INVITE_RETENTION_MS;
      const kept = items.filter(
        (row) => row.status === 'pending' || Date.parse(row.created_at) >= cutoff,
      );
      const refusal = refuse(kept.filter((row) => row.user_id === record.user_id));
      if (refusal !== undefined) return { items: kept, result: refusal };
      return { items: [...kept, record], result: undefined };
    });
  }

  /**
   * Moves a pending invite to `status`, atomically. Resolves the updated row, or undefined when
   * the invite is gone or no longer pending (someone else handled it first).
   */
  settle(
    id: string,
    status: Exclude<InviteStatus, 'pending'>,
    now: Date,
    note?: string,
    answeredBy?: { deviceId?: string; callId?: string },
  ): Promise<InviteRecord | undefined> {
    return this.rows.update((items) => {
      let updated: InviteRecord | undefined;
      const next = items.map((row) => {
        if (row.id !== id || row.status !== 'pending') return row;
        updated = {
          ...row,
          status,
          handled_at: now.toISOString(),
          ...(note !== undefined && note !== '' && { note }),
          ...(answeredBy?.deviceId !== undefined && { answered_by: answeredBy.deviceId }),
          ...(answeredBy?.callId !== undefined && { call_id: answeredBy.callId }),
        };
        return updated;
      });
      return { items: updated === undefined ? items : next, result: updated };
    });
  }

  deleteAllForUser(userId: string): Promise<number> {
    return deleteOwned(this.rows, userId);
  }
}

function deleteOwned<T extends { user_id: string }>(
  rows: Collection<T>,
  userId: string,
): Promise<number> {
  return rows.update((items) => {
    const kept = items.filter((row) => row.user_id !== userId);
    return { items: kept, result: items.length - kept.length };
  });
}

export interface RingStores {
  devices: DeviceRepository;
  settings: RingSettingsRepository;
  invites: InviteRepository;
}
