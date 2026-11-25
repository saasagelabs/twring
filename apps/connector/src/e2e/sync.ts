import { e2eDeviceSchema, type E2eDevice } from '@twring/contracts';
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

const devicesResponseSchema = z.object({ devices: z.array(e2eDeviceSchema).max(64) });

export interface SyncDevicesOptions {
  server: string;
  token: string;
  fetch: typeof fetch;
  /** Changes and saves the private chat config (read fresh first). */
  persist: (change: (current: E2eConfig) => E2eConfig) => Promise<E2eConfig | undefined>;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Reads the account's devices and drops the revoked ones from the trusted list. Undefined when
 * the list could not be read (offline, private chats off, a bad answer): nothing changes then.
 */
export async function syncDevices(
  options: SyncDevicesOptions,
): Promise<{ revoked: number; unverified: number } | undefined> {
  let body: z.infer<typeof devicesResponseSchema>;
  try {
    const res = await options.fetch(
      apiUrl(checkServerUrl(options.server), '/v1/e2e/computer/devices'),
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
  let counts = { revoked: 0, unverified: 0 };
  await options.persist((current) => {
    const out = reconcileDevices(current.devices, body.devices, current.device_id);
    counts = { revoked: out.revoked.length, unverified: out.unverified.length };
    if (current.pending === undefined) return { ...current, devices: out.trusted };
    const settled = settlePending(current.pending, body.devices, (options.now ?? Date.now)());
    const rest = { ...current };
    delete rest.pending;
    return {
      ...rest,
      devices: [
        ...out.trusted.filter((d) => !settled.confirmed.some((c) => c.id === d.id)),
        ...settled.confirmed,
      ],
      ...(settled.pending.length > 0 && { pending: settled.pending }),
    };
  });
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
