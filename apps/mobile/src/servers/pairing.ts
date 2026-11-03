import {
  base64urlDecode,
  base64urlEncode,
  deriveSealKey,
  generateSealKeyPair,
  pairResponseSchema,
} from '@twring/contracts';
import { Platform } from 'react-native';

import { SERVER_MESSAGE_MAX } from '../api/client';
import { installRandomValues } from '../auth/random-values';
import type { SealKeys } from '../platform/seal-keys';

import { normalizeAddress } from './address';
import type { ProfileStore, SelfhostProfile } from './profiles';
import { checkServer } from './server-check';

export interface PairInput {
  address: string;
  code: string;
  /** From a pair link or QR: the server the code was printed by. */
  serverId?: string;
  displayName: string;
}

export type PairOutcome =
  { ok: true; profile: SelfhostProfile } | { ok: false; message: string; retryable: boolean };

export interface PairDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  /** True only in development builds. */
  allowHttp: boolean;
  store: Pick<ProfileStore, 'save' | 'activate' | 'remove' | 'list' | 'secrets'>;
  sealKeys: Pick<SealKeys, 'set' | 'remove'>;
  /** Tests inject this to see the phone's private key; defaults to the contracts generator. */
  keyPair?: typeof generateSealKeyPair;
}

const TIMEOUT_MS = 15_000;
const UNREACHABLE =
  "Couldn't reach that server. Check the address, and that the server is running.";
const unreachable: PairOutcome = { ok: false, message: UNREACHABLE, retryable: true };

/** One request, answer read in full (JSON, or undefined when not JSON), all inside the timeout. */
async function exchange(
  deps: PairDeps,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);
  });
  const work = (async () => {
    const res = await deps.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    const body: unknown = await res.json().catch(() => undefined);
    return { status: res.status, body };
  })();
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server's own words for a refused code or too many tries; undefined for anything else. */
function serverMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
  const { code, message } = error ?? {};
  return (code === 'pairing_invalid' || code === 'rate_limited') && typeof message === 'string'
    ? message.slice(0, SERVER_MESSAGE_MAX)
    : undefined;
}

/**
 * Pairs this phone with a self-hosted server: verifies the server, sends the code with a fresh
 * seal public key, and saves the profile with the device token and the derived seal key. The
 * phone's seal private key lives only in this function. If anything after a successful pair
 * fails, the new device is removed from the server again so no orphan is left, and a profile
 * saved earlier for the same server is put back exactly. A successful re-pair removes the old
 * phone from the server (best effort).
 */
export async function pairWithServer(input: PairInput, deps: PairDeps): Promise<PairOutcome> {
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 40) {
    return { ok: false, message: 'Enter a name of 1 to 40 characters.', retryable: false };
  }
  const normalized = normalizeAddress(input.address, { allowHttp: deps.allowHttp });
  if (!normalized.ok) return { ok: false, message: normalized.message, retryable: false };
  const address = normalized.address;

  const check = await checkServer(address, { serverId: input.serverId }, deps);
  if (!check.ok) return { ok: false, message: check.message, retryable: true };

  installRandomValues();
  const pair = (deps.keyPair ?? generateSealKeyPair)();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  let res: { status: number; body: unknown };
  try {
    res = await exchange(deps, `${address}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        code: input.code,
        display_name: displayName,
        device_name: platform === 'ios' ? 'iPhone' : 'Android phone',
        platform,
        seal_public_key: base64urlEncode(pair.publicKey),
      }),
    });
  } catch {
    return unreachable;
  }
  if (res.status !== 201) {
    const message = serverMessage(res.body);
    return message === undefined
      ? unreachable
      : { ok: false, message, retryable: res.status === 429 };
  }

  const parsed = pairResponseSchema.safeParse(res.body);
  // The device exists on the server by now; without a usable answer there is no token to remove it.
  if (!parsed.success || parsed.data.server.server_id !== check.info.server_id) return unreachable;
  const { person, device, server } = parsed.data;

  const unpair = (deviceId: string) =>
    exchange(deps, `${address}/v1/me/paired-devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${device.token}` },
    }).catch(() => undefined);

  const profile: SelfhostProfile = {
    kind: 'selfhost',
    serverId: check.info.server_id,
    address,
    name: server.name,
    publicKey: check.publicKey,
    person: { id: person.id, displayName: person.display_name, role: person.role },
    deviceId: device.id,
    audio: server.audio,
  };

  const prior = deps.store
    .list()
    .find((p): p is SelfhostProfile => p.kind === 'selfhost' && p.serverId === profile.serverId);
  const priorSecrets = prior === undefined ? undefined : await deps.store.secrets(profile.serverId);

  try {
    const sealKey = base64urlEncode(
      deriveSealKey(pair.privateKey, base64urlDecode(parsed.data.seal_server_public_key)),
    );
    await deps.store.save(profile, { deviceToken: device.token, sealKey });
    await deps.sealKeys.set(profile.serverId, sealKey);
    await deps.store.activate(profile.serverId);
  } catch {
    if (prior !== undefined && priorSecrets !== undefined) {
      await deps.store.save(prior, priorSecrets).catch(() => undefined);
      await deps.sealKeys.set(prior.serverId, priorSecrets.sealKey).catch(() => undefined);
    } else {
      await deps.sealKeys.remove(profile.serverId).catch(() => undefined);
      await deps.store.remove(profile.serverId).catch(() => undefined);
    }
    await unpair(device.id);
    return unreachable;
  }
  if (prior !== undefined && prior.deviceId !== device.id) await unpair(prior.deviceId);
  return { ok: true, profile };
}
