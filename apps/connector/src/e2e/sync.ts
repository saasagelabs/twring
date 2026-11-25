import {
  base64urlDecode,
  checkTrustNote,
  e2eDeviceWithNoteSchema,
  type E2eDevice,
  type E2eDeviceWithNote,
  type TrustNoteRefusal,
} from '@twring/contracts';
import { z } from 'zod';

import { apiUrl, checkServerUrl } from '../config';
import type { E2eConfig, TrustedDevice } from './keys';

/** How often a running computer reads the account's device list. */
export const DEVICE_SYNC_MS = 10 * 60_000;

/**
 * This computer's trusted list against the server's (ADR-044). A device the server says was
 * revoked is dropped; a device only the server lists is unverified and never wrapped to; a trusted
 * device missing from the server stays until the server says it was revoked (an outage or a short
 * list must not drop devices). The server can only take trust away, never add it.
 */
export function reconcileDevices(
  trusted: TrustedDevice[],
  server: E2eDevice[],
  selfId?: string,
): { trusted: TrustedDevice[]; revoked: string[]; unverified: E2eDevice[] } {
  const revoked = new Set(
    server.filter((device) => device.revoked_at !== undefined).map((device) => device.id),
  );
  return {
    trusted: trusted.filter((device) => !revoked.has(device.id)),
    revoked: trusted.filter((device) => revoked.has(device.id)).map((device) => device.id),
    unverified: server.filter(
      (device) =>
        device.revoked_at === undefined &&
        device.id !== selfId &&
        !trusted.some((mine) => mine.id === device.id),
    ),
  };
}

/** A pending phone the server still does not list after this long was never added: dropped. */
export const PENDING_MAX_MS = 30 * 60_000;

/**
 * Settles phones a pairing left pending (its last save or the server add did not finish): one
 * the server lists with the same key is trusted (this computer checked it itself at pairing), one
 * the server revoked or lists with another key is dropped, and one never listed is dropped after
 * PENDING_MAX_MS. So this computer and the server end up agreeing on the pairing.
 */
export function settlePending(
  pending: TrustedDevice[],
  server: E2eDevice[],
  now: number,
): { confirmed: TrustedDevice[]; pending: TrustedDevice[] } {
  const confirmed: TrustedDevice[] = [];
  const kept: TrustedDevice[] = [];
  for (const device of pending) {
    const listed = server.find((d) => d.id === device.id);
    if (listed !== undefined) {
      if (listed.revoked_at === undefined && listed.public_key === device.public_key)
        confirmed.push(device);
    } else if (now - Date.parse(device.verified_at) <= PENDING_MAX_MS) {
      kept.push(device);
    }
  }
  return { confirmed, pending: kept };
}

/**
 * Devices the server lists that a phone this computer trusts vouched for (C3 #11 P4b ruling 4):
 * each note is checked with `checkTrustNote` against this computer's own trusted list, so the
 * server alone can never add one. Notes are applied in list order, so only a phone trusted before
 * this sync can vouch. Refusals carry a reason only.
 */
export function applyTrustNotes(
  trusted: TrustedDevice[],
  server: readonly E2eDeviceWithNote[],
  me: { deviceId: string; privateKey: Uint8Array },
  now: number,
): { trusted: TrustedDevice[]; added: number; refused: TrustNoteRefusal[] } {
  const vouchers = [...trusted];
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
    const checked = checkTrustNote(listed, vouchers, me);
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

const devicesResponseSchema = z.object({ devices: z.array(e2eDeviceWithNoteSchema).max(64) });

export interface SyncDevicesOptions {
  server: string;
  token: string;
  fetch: typeof fetch;
  /** Changes and saves the private chat config (read fresh first). */
  persist: (change: (current: E2eConfig) => E2eConfig) => Promise<E2eConfig | undefined>;
  signal?: AbortSignal;
  now?: () => number;
  /** Ids, counts and reasons only. */
  log?: (line: string) => void;
}

/**
 * Reads the account's devices and drops the revoked ones from the trusted list. Undefined when
 * the list could not be read (offline, private chats off, a bad answer): nothing changes then.
 */
export async function syncDevices(
  options: SyncDevicesOptions,
): Promise<{ revoked: number; unverified: number; added: number } | undefined> {
  let body: z.infer<typeof devicesResponseSchema>;
  try {
    const res = await options.fetch(
      apiUrl(checkServerUrl(options.server), '/v1/e2e/computer/devices?notes=1'),
      {
        headers: { authorization: `Bearer ${options.token}` },
        ...(options.signal !== undefined && { signal: options.signal }),
      },
    );
    if (!res.ok) return undefined;
    const parsed = devicesResponseSchema.safeParse(await res.json());
    if (!parsed.success) return undefined;
    body = parsed.data;
  } catch {
    return undefined;
  }
  let counts = { revoked: 0, unverified: 0, added: 0 };
  let refused: TrustNoteRefusal[] = [];
  const now = (options.now ?? Date.now)();
  await options.persist((current) => {
    const out = reconcileDevices(current.devices, body.devices, current.device_id);
    const noted = (list: TrustedDevice[]) => {
      const applied = applyTrustNotes(
        list,
        body.devices,
        { deviceId: current.device_id, privateKey: base64urlDecode(current.private_key) },
        now,
      );
      refused = applied.refused;
      counts = {
        revoked: out.revoked.length,
        unverified: Math.max(0, out.unverified.length - applied.added),
        added: applied.added,
      };
      return applied.trusted;
    };
    if (current.pending === undefined) return { ...current, devices: noted(out.trusted) };
    const settled = settlePending(current.pending, body.devices, now);
    const rest = { ...current };
    delete rest.pending;
    return {
      ...rest,
      devices: noted([
        ...out.trusted.filter((d) => !settled.confirmed.some((c) => c.id === d.id)),
        ...settled.confirmed,
      ]),
      ...(settled.pending.length > 0 && { pending: settled.pending }),
    };
  });
  for (const reason of new Set(refused))
    options.log?.(
      `e2e_trust_note_refused ${reason} (${refused.filter((r) => r === reason).length})`,
    );
  return counts;
}

/** How long a `e2e.devices_changed` waits for more of them before the one sync it starts. */
export const DEVICES_CHANGED_DEBOUNCE_MS = 2_000;

/**
 * The sync a `e2e.devices_changed` frame starts (C3 #11 P4 ruling 2): many frames close together
 * start one sync, and a frame that arrives while a sync runs starts one more after it, so the
 * last removal is always read. Ignored while `enabled()` says private chats are off here.
 */
export function devicesChangedTrigger(options: {
  run: () => Promise<void>;
  enabled: () => boolean;
  delayMs?: number;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  const start = () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void options
      .run()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        if (again) {
          again = false;
          start();
        }
      });
  };
  return () => {
    if (!options.enabled()) return;
    if (timer !== undefined) return;
    timer = setTimeout(start, options.delayMs ?? DEVICES_CHANGED_DEBOUNCE_MS);
    timer.unref?.();
  };
}
