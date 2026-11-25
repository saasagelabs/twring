import { e2eDeviceSchema, MAX_PAIRED_DEVICES, type E2eDevice } from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';

/**
 * The account's private chat devices (C3 #11, Task 26 and Task 30): the list on the devices
 * screen, removing a device, and what the server's list may change on this phone. The server can
 * only take trust away (ADR-044, P4 ruling 3): a device it marks revoked leaves this phone's
 * trusted list, and nothing it lists is ever trusted without pairing. Logs carry ids and counts.
 */

export const CAP_HINT = 'Remove a device to add a new one.';
export const REINSTALLED = 'Your computer was set up again, scan to continue';
export const LOST_KEYS =
  "Older private messages can't be opened on this phone. New messages will work after you pair.";

export function lostKeyMessage(): string {
  return LOST_KEYS;
}

/** The signed-in phone's device calls; the raw answers, checked here. */
export interface DevicesApi {
  /** `GET /v1/e2e/devices`: active devices and those revoked lately (`revoked_at`). */
  list(): Promise<unknown>;
  /** `DELETE /v1/e2e/devices/:id`; resolves once the server removed it (or it was gone). */
  remove(id: string): Promise<void>;
}

const listSchema = z.object({ devices: z.array(e2eDeviceSchema).max(64) });

/** The server's list, checked; throws on an answer that is not one. */
export async function listDevices(api: Pick<DevicesApi, 'list'>): Promise<E2eDevice[]> {
  return listSchema.parse(await api.list()).devices;
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: 'Phone' | 'Computer';
  thisPhone: boolean;
  /** The added date, for display (`YYYY-MM-DD`). */
  added: string;
}

export interface DevicesState {
  devices: DeviceRow[];
  /** "2 of 5 devices". */
  count: string;
  canAdd: boolean;
  /** At the cap: what to do next. */
  hint?: string;
}

/** What the devices screen shows: active devices only, this phone marked. */
export function devicesStateFrom(devices: readonly E2eDevice[], selfId?: string): DevicesState {
  const active = devices.filter((d) => d.revoked_at === undefined);
  const canAdd = active.length < MAX_PAIRED_DEVICES;
  return {
    devices: active.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind === 'phone' ? 'Phone' : 'Computer',
      thisPhone: d.id === selfId,
      added: d.added_at.slice(0, 10),
    })),
    count: `${active.length} of ${MAX_PAIRED_DEVICES} devices`,
    canAdd,
    ...(!canAdd && { hint: CAP_HINT }),
  };
}

export async function devicesState(
  api: Pick<DevicesApi, 'list'>,
  selfId?: string,
): Promise<DevicesState> {
  return devicesStateFrom(await listDevices(api), selfId);
}

/**
 * The trusted list after the server's: a device it marks revoked is dropped (the server can only
 * take trust away), and a computer paired before connector ids were recorded is bound to the
 * connector the server lists for that same id and key (ruling: such a computer was verified at
 * pairing, so only its agent binding comes from the server). An absent device stays.
 */
export function reconcileTrusted(
  trusted: readonly TrustedDevice[],
  server: readonly E2eDevice[],
): { trusted: TrustedDevice[]; dropped: number; bound: number } {
  const revoked = new Set(server.filter((d) => d.revoked_at !== undefined).map((d) => d.id));
  let bound = 0;
  const kept = trusted
    .filter((d) => !revoked.has(d.id))
    .map((d) => {
      if (d.kind !== 'computer' || d.connector_id !== undefined) return d;
      const listed = server.find(
        (s) =>
          s.id === d.id &&
          s.revoked_at === undefined &&
          s.kind === 'computer' &&
          s.public_key === d.public_key &&
          s.connector_id !== undefined,
      );
      const parsed = listed?.connector_id?.match(/^con_[a-z0-9]{20}$/)?.[0];
      if (parsed === undefined) return d;
      bound++;
      return { ...d, connector_id: parsed };
    });
  return { trusted: kept, dropped: trusted.length - kept.length, bound };
}

/** Reads the server's list and applies `reconcileTrusted` to this phone's saved list. */
export async function syncTrusted(
  store: SecureKeyValue,
  server: readonly E2eDevice[],
  log?: (event: string, fields?: Record<string, string | number>) => void,
): Promise<TrustedDevice[]> {
  const current = await loadTrusted(store);
  const out = reconcileTrusted(current, server);
  if (out.dropped > 0 || out.bound > 0) {
    await saveTrusted(store, out.trusted);
    log?.('e2e_trusted_synced', { dropped: out.dropped, bound: out.bound });
  }
  return out.trusted;
}

/**
 * The computer that serves a chat's connector: the one bound to it, or, when none is bound, a
 * computer paired before binding (ruling: such an entry keeps working until the device list binds
 * it, but never in a chat whose connector already has a bound computer).
 */
export function computerAllowed(
  trusted: readonly TrustedDevice[],
  deviceId: string,
  connectorId: string,
): boolean {
  const device = trusted.find((d) => d.id === deviceId && d.kind === 'computer');
  if (device === undefined) return false;
  if (device.connector_id !== undefined) return device.connector_id === connectorId;
  return !trusted.some((d) => d.kind === 'computer' && d.connector_id === connectorId);
}

export function hasComputerFor(trusted: readonly TrustedDevice[], connectorId: string): boolean {
  return trusted.some((d) => computerAllowed(trusted, d.id, connectorId));
}

/**
 * The server lists an active computer for this chat's connector that this phone does not trust:
 * the computer was set up again (Task 30). Never trusted silently; the chat asks to scan. A
 * computer that was only removed is not listed active, so it never shows this.
 */
export function reinstalledFor(
  server: readonly E2eDevice[],
  trusted: readonly TrustedDevice[],
  connectorId: string,
): boolean {
  return server.some(
    (s) =>
      s.kind === 'computer' &&
      s.revoked_at === undefined &&
      s.connector_id === connectorId &&
      !trusted.some((d) => d.id === s.id && d.public_key === s.public_key),
  );
}

/**
 * Removes a device on the server; that is the whole removal (P4 ruling 1). The phone stops
 * wrapping to it at once (P4 ruling 3). Removing this phone forgets its private chat keys through
 * `forgetSelf`, the sign-out path.
 */
export async function removeDevice(
  deps: {
    api: Pick<DevicesApi, 'remove'>;
    store: SecureKeyValue;
    selfId?: string;
    forgetSelf: () => Promise<void>;
    log?: (event: string, fields?: Record<string, string | number>) => void;
  },
  id: string,
): Promise<void> {
  await deps.api.remove(id);
  deps.log?.('e2e_device_removed', { device_id: id });
  if (id === deps.selfId) {
    await deps.forgetSelf();
    return;
  }
  const current = await loadTrusted(deps.store);
  const next = current.filter((d) => d.id !== id);
  if (next.length !== current.length) await saveTrusted(deps.store, next);
}

/** What removing a device asks first, in plain words. */
export function removeCopy(row: Pick<DeviceRow, 'name' | 'kind' | 'thisPhone'>): {
  title: string;
  body: string;
  confirm: string;
} {
  if (row.thisPhone)
    return {
      title: 'Remove this phone?',
      body: "This phone forgets its private chat keys. Private messages here can't be opened again until you pair it.",
      confirm: 'Remove this phone',
    };
  if (row.kind === 'Computer')
    return {
      title: `Remove ${row.name}?`,
      body: 'Private chats with agents on this computer stop until you pair it again.',
      confirm: 'Remove computer',
    };
  return {
    title: `Remove ${row.name}?`,
    body: "That phone can't open new private messages after this.",
    confirm: 'Remove phone',
  };
}
