import {
  checkTrustNote,
  e2eDeviceWithNoteSchema,
  MAX_PAIRED_DEVICES,
  type E2eDevice,
  type E2eDeviceWithNote,
  type TrustNoteRefusal,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import {
  loadTrusted,
  REMOVED_KEY_NAME,
  saveTrusted,
  withTrustLock,
  type TrustedDevice,
} from './pairing';

/**
 * The account's private chat devices (C3 #11, Task 26 and Task 30): the list on the devices
 * screen, removing a device, and what the server's list may change on this phone. The server can
 * only take trust away (ADR-044, P4 ruling 3): a device it marks revoked leaves this phone's
 * trusted list, and nothing it lists is ever trusted without pairing. Logs carry ids and counts.
 */

export const CAP_HINT = 'Remove a device to add a new one.';
export const REINSTALLED = 'Your computer was set up again, scan to continue';
/** A phone that trusts no computer yet (a new or wiped phone): set it up, nothing was undone. */
export const NEW_PHONE = "This phone can't read private chats yet.";
/** Another phone removed this one: its keys are gone, and it comes back as a new device. */
export const REMOVED_PHONE =
  'This phone was removed from private chats. Approve it from your other phone to read new messages.';
export const SET_UP_PHONE = 'Set up this phone';
export const PAIR_AGAIN_ACTION = 'Pair again';

/** The button under a private chat's notice: both open the pair screen. */
export function noticeAction(notice: string): string {
  return notice === NEW_PHONE || notice === REMOVED_PHONE ? SET_UP_PHONE : PAIR_AGAIN_ACTION;
}

export const LOST_KEYS =
  "Older private messages can't be opened on this phone. New messages will work after you pair.";

export function lostKeyMessage(): string {
  return LOST_KEYS;
}

/** The signed-in phone's device calls; the raw answers, checked here. */
export interface DevicesApi {
  /**
   * `GET /v1/e2e/devices?notes=1`: active devices and those revoked lately (`revoked_at`), each
   * with the trust note a phone sealed when it approved it (C3 #11, Task 27).
   */
  list(): Promise<unknown>;
  /** `DELETE /v1/e2e/devices/:id`; resolves once the server removed it (or it was gone). */
  remove(id: string): Promise<void>;
}

const listSchema = z.object({ devices: z.array(e2eDeviceWithNoteSchema).max(64) });

/** The server's list, checked; throws on an answer that is not one. */
export async function listDevices(api: Pick<DevicesApi, 'list'>): Promise<E2eDeviceWithNote[]> {
  return listSchema.parse(await api.list()).devices;
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: 'Phone' | 'Computer';
  thisPhone: boolean;
  /** False for a phone this phone has not approved (it cannot read that phone's private chats). */
  connected: boolean;
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
export function devicesStateFrom(
  devices: readonly E2eDevice[],
  selfId?: string,
  trustedIds?: ReadonlySet<string>,
): DevicesState {
  const active = devices.filter((d) => d.revoked_at === undefined);
  const canAdd = active.length < MAX_PAIRED_DEVICES;
  return {
    devices: active.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind === 'phone' ? 'Phone' : 'Computer',
      thisPhone: d.id === selfId,
      connected:
        trustedIds === undefined ||
        d.id === selfId ||
        d.kind === 'computer' ||
        trustedIds.has(d.id),
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
  const survivors = trusted.filter((d) => !revoked.has(d.id));
  // A connector that already has a bound computer never gets another one from the server: that
  // would let an older entry speak in a chat it is refused in now. One entry per connector.
  const taken = new Set(
    survivors.flatMap((d) => (d.kind === 'computer' && d.connector_id ? [d.connector_id] : [])),
  );
  const kept = survivors.map((d) => {
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
    if (parsed === undefined || taken.has(parsed)) return d;
    taken.add(parsed);
    bound++;
    return { ...d, connector_id: parsed };
  });
  return { trusted: kept, dropped: trusted.length - kept.length, bound };
}

/**
 * Phones the server lists that another phone this one trusts approved (C3 #11 P4b ruling 4, the
 * computer's rule): the note must come from a phone in this phone's own trusted list and name
 * exactly the listed id and key. Only phones trusted before this pass can vouch.
 */
export function applyTrustNotes(
  trusted: readonly TrustedDevice[],
  server: readonly E2eDeviceWithNote[],
  me: { deviceId: string; privateKey: Uint8Array },
  now: number,
): { trusted: TrustedDevice[]; added: number; refused: TrustNoteRefusal[] } {
  const out = [...trusted];
  const refused: TrustNoteRefusal[] = [];
  for (const listed of server) {
    if (
      listed.trust_note === undefined ||
      listed.revoked_at !== undefined ||
      listed.kind !== 'phone' ||
      listed.id === me.deviceId ||
      out.some((d) => d.id === listed.id)
    )
      continue;
    const checked = checkTrustNote(listed, trusted, me);
    if (!checked.ok) {
      refused.push(checked.reason);
      continue;
    }
    out.push({
      id: checked.add.id,
      kind: 'phone',
      name: checked.add.name,
      public_key: checked.add.public_key,
      verified_at: new Date(now).toISOString(),
    });
  }
  return { trusted: out, added: out.length - trusted.length, refused };
}

/**
 * Device ids removed from this phone's trusted list, kept so a trust note can never bring one
 * back (R3-1). Only ids this phone trusted (dropped because the server marked them revoked) or
 * removed itself are added, so a server cannot flush the list with ids of its choosing. When it is
 * full the oldest id goes first; during a sync, which has the server's listing, an id the server
 * still lists is never the one evicted. Filling it takes 256 removals.
 */
export { REMOVED_KEY_NAME };
export const MAX_REMOVED_SEEN = 256;
const removedSchema = z.array(z.string().min(1).max(64)).max(MAX_REMOVED_SEEN);

async function loadRemoved(store: SecureKeyValue): Promise<string[]> {
  try {
    const parsed = removedSchema.safeParse(
      JSON.parse((await store.getItemAsync(REMOVED_KEY_NAME)) ?? '[]'),
    );
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

async function addRemoved(
  store: SecureKeyValue,
  ids: readonly string[],
  listed: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const kept = await loadRemoved(store);
  const fresh = [...new Set(ids)].filter((id) => !kept.includes(id));
  if (fresh.length === 0) return kept;
  const next = [...kept, ...fresh];
  while (next.length > MAX_REMOVED_SEEN) {
    const oldest = next.findIndex((id) => !listed.has(id) && !fresh.includes(id));
    // Every id is listed or new: the server lists at most 64, so this cannot happen in practice.
    next.splice(oldest === -1 ? 0 : oldest, 1);
  }
  await store.setItemAsync(REMOVED_KEY_NAME, JSON.stringify(next));
  return next;
}

async function rememberRemoved(
  store: SecureKeyValue,
  server: readonly E2eDevice[],
  trustedBefore: readonly TrustedDevice[],
): Promise<string[]> {
  const mine = new Set(trustedBefore.map((d) => d.id));
  return addRemoved(
    store,
    server.filter((d) => d.revoked_at !== undefined && mine.has(d.id)).map((d) => d.id),
    new Set(server.map((d) => d.id)),
  );
}

/**
 * Reads the server's list and applies `reconcileTrusted` to this phone's saved list, then, with
 * this phone's key, the trust notes of phones another trusted phone approved. A trusted entry
 * whose id is in the removed memory is dropped too. Runs under the trust lock.
 */
export function syncTrusted(
  store: SecureKeyValue,
  server: readonly E2eDeviceWithNote[],
  log?: (event: string, fields?: Record<string, string | number>) => void,
  me?: { deviceId: string; privateKey: Uint8Array },
  now: () => number = Date.now,
): Promise<TrustedDevice[]> {
  return withTrustLock(store, () => syncTrustedNow(store, server, log, me, now));
}

async function syncTrustedNow(
  store: SecureKeyValue,
  server: readonly E2eDeviceWithNote[],
  log: ((event: string, fields?: Record<string, string | number>) => void) | undefined,
  me: { deviceId: string; privateKey: Uint8Array } | undefined,
  now: () => number,
): Promise<TrustedDevice[]> {
  const current = await loadTrusted(store);
  const removed = await rememberRemoved(store, server, current);
  const reconciled = reconcileTrusted(current, server);
  const kept = reconciled.trusted.filter((d) => !removed.includes(d.id));
  const out = {
    ...reconciled,
    trusted: kept,
    dropped: reconciled.dropped + reconciled.trusted.length - kept.length,
  };
  const notedRaw =
    me === undefined
      ? { trusted: out.trusted, added: 0, refused: [] as TrustNoteRefusal[] }
      : applyTrustNotes(
          out.trusted,
          server.filter((d) => !removed.includes(d.id)),
          me,
          now(),
        );
  const blocked = server.filter((d) => d.trust_note !== undefined && removed.includes(d.id));
  const noted = {
    ...notedRaw,
    refused: [...notedRaw.refused, ...blocked.map((): TrustNoteRefusal => 'removed')],
  };
  for (const reason of new Set(noted.refused)) log?.('e2e_trust_note_refused', { reason });
  if (out.dropped > 0 || out.bound > 0 || noted.added > 0) {
    await saveTrusted(store, noted.trusted);
    log?.('e2e_trusted_synced', { dropped: out.dropped, bound: out.bound, added: noted.added });
  }
  return noted.trusted;
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
 * The server lists an active computer for this chat's connector that this phone does not trust,
 * while this phone did trust a computer for that connector (`before`, its list before the
 * server's was applied): the computer was set up again (Task 30). Never trusted silently; the
 * chat asks to scan. A phone that never trusted one is a new phone, not this. A computer that was
 * only removed is not listed active, so it never shows this.
 */
export function reinstalledFor(
  server: readonly E2eDevice[],
  trusted: readonly TrustedDevice[],
  connectorId: string,
  before: readonly TrustedDevice[] = trusted,
): boolean {
  if (!hasComputerFor(before, connectorId)) return false;
  return server.some(
    (s) =>
      s.kind === 'computer' &&
      s.revoked_at === undefined &&
      s.connector_id === connectorId &&
      !trusted.some((d) => d.id === s.id && d.public_key === s.public_key),
  );
}

/**
 * Another phone removed this one: only when the server lists this phone's id with `revoked_at`.
 * A phone missing from the list is never treated as removed (lead ruling): a server answer that
 * leaves it out by mistake must never wipe its keys. The trusted list is not consulted.
 */
export function removedPhone(
  server: readonly E2eDevice[],
  _trusted: readonly TrustedDevice[],
  selfId: string,
): boolean {
  return server.some((d) => d.id === selfId && d.revoked_at !== undefined);
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
  // Recorded before the trusted list changes, so an old trust note never brings it back (R3-1).
  // Under the trust lock, so an overlapping sync cannot save the list it loaded before.
  await withTrustLock(deps.store, async () => {
    await addRemoved(deps.store, [id]);
    const current = await loadTrusted(deps.store);
    const next = current.filter((d) => d.id !== id);
    if (next.length !== current.length) await saveTrusted(deps.store, next);
  });
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
