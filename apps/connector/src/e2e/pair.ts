import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  base64urlDecode,
  base64urlEncode,
  e2eDeviceIdSchema,
  e2eDeviceSchema,
  pairOfferIdSchema,
  pairingMac,
  publicKeySchema,
  safetyCode,
} from '@twring/contracts';
import { z } from 'zod';

import { apiUrl, checkServerUrl, type ConnectorConfig } from '../config';
import { terminalQr } from '../link';
import type { E2eConfig, TrustedDevice } from './keys';

/** What the phone reads from the QR: `twring-pair:` then base64url JSON of this. */
export const pairLinkSchema = z
  .object({
    /** The Twring server's origin. */
    s: z.url(),
    o: pairOfferIdSchema,
    /** This computer's public key, so the phone can check what the server hands it. */
    k: publicKeySchema,
    /** 32 random bytes the server never sees: the phone proves it read the QR with it. */
    x: publicKeySchema,
  })
  .strict();
export type PairLink = z.infer<typeof pairLinkSchema>;

export const PAIR_LINK_PREFIX = 'twring-pair:';

export function pairLink(link: PairLink): string {
  return `${PAIR_LINK_PREFIX}${base64urlEncode(new TextEncoder().encode(JSON.stringify(link)))}`;
}

export function parsePairLink(text: string): PairLink | undefined {
  if (!text.startsWith(PAIR_LINK_PREFIX)) return undefined;
  try {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(base64urlDecode(text.slice(PAIR_LINK_PREFIX.length))),
    );
    const parsed = pairLinkSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type PairOutcome = 'paired' | 'expired' | 'mismatch' | 'cancelled' | 'cap';

export interface PairPhoneOptions {
  /** A config that already has a device key (`ensureDeviceKey`). */
  config: ConnectorConfig;
  fetch: typeof fetch;
  print: (line: string) => void;
  /** Asks "Same number? (y/n)" after the code was printed. */
  confirm: (code: string) => Promise<boolean>;
  /**
   * Changes and saves the private chat config (read fresh first); rejects when it could not. The
   * phone is saved pending before the server hears of it and trusted only after the server added
   * it, so a failure at any step leaves both sides agreeing (or the next device sync settles it).
   */
  update: (change: (current: E2eConfig) => E2eConfig) => Promise<void>;
  signal: AbortSignal;
  qr?: (text: string) => string | undefined;
  /** Long-poll wait the server is asked for, in seconds. */
  waitSeconds?: number;
  now?: () => number;
}

const offerResponseSchema = z.object({
  offer_id: pairOfferIdSchema,
  expires_at: z.iso.datetime(),
});
const claimResponseSchema = z.object({
  phone_device_id: e2eDeviceIdSchema,
  phone_public_key: publicKeySchema,
  phone_name: z.string().min(1).max(60),
  mac: z.string().min(1).max(64),
});
type Claim = z.infer<typeof claimResponseSchema>;
const devicesResponseSchema = z.object({ devices: z.array(e2eDeviceSchema).max(64) });

const RETRY_MS = 2_000;

class PairStop extends Error {
  constructor(readonly outcome: Exclude<PairOutcome, 'paired'>) {
    super(outcome);
  }
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Pairs a phone with this computer for private chats (ADR-044). The QR carries a secret the
 * server never sees; the phone's claim must carry an HMAC with it over both public keys, both device
 * ids and the phone's name (so the server cannot rename or re-id a phone), and the
 * person must see the same 6-digit code on both screens. Only then does the phone join this
 * computer's trusted list. Prints plain words only: never the secret, a key or a MAC.
 */
export async function pairPhone(options: PairPhoneOptions): Promise<PairOutcome> {
  const { config, print, signal } = options;
  const e2e = config.e2e;
  if (e2e === undefined) throw new Error('no device key');
  if (signal.aborted) return 'cancelled';
  const server = checkServerUrl(config.server);
  const headers = {
    authorization: `Bearer ${config.token}`,
    'content-type': 'application/json',
  };
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await options.fetch(apiUrl(server, path), {
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw new PairStop('cancelled');
      throw error;
    }
  };
  try {
    const offered = await call('/v1/e2e/pairings', {
      method: 'POST',
      body: JSON.stringify({
        connector_public_key: e2e.public_key,
        connector_device_id: e2e.device_id,
      }),
    });
    if (!offered.ok) throw new Error(await refusal(offered));
    const offer = offerResponseSchema.parse(await offered.json());
    const secret = randomBytes(32);
    const link = pairLink({
      s: server.origin,
      o: offer.offer_id,
      k: e2e.public_key,
      x: base64urlEncode(secret),
    });
    print('Scan this with Twring on your phone (Settings, Private chats).');
    const drawn = (options.qr ?? terminalQr)(link);
    print(drawn ?? 'This window is too small to show the code. Make it bigger and run this again.');
    print('Waiting for your phone…');

    const claim = await waitForClaim(options, call, offer.offer_id, Date.parse(offer.expires_at));
    const mine = base64urlDecode(e2e.public_key);
    const phoneKey = base64urlDecode(claim.phone_public_key);
    // The MAC proves the phone read this QR: a key, device id or name swapped on the way fails.
    const expected = pairingMac(secret, {
      connectorPublic: mine,
      phonePublic: phoneKey,
      connectorDeviceId: e2e.device_id,
      phoneDeviceId: claim.phone_device_id,
      phoneName: claim.phone_name,
    });
    if (!sameText(expected, claim.mac)) {
      print('Your phone sent a code this computer could not check. Nothing was paired.');
      return 'mismatch';
    }
    const code = safetyCode(mine, phoneKey);
    print(`Check that your phone shows ${code}.`);
    if (!(await options.confirm(code))) {
      print('The numbers did not match, so nothing was paired.');
      return 'mismatch';
    }
    const phone: TrustedDevice = {
      id: claim.phone_device_id,
      kind: 'phone',
      name: claim.phone_name,
      public_key: claim.phone_public_key,
      verified_at: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    const other = (d: TrustedDevice) => d.id !== phone.id && d.public_key !== phone.public_key;
    const dropPending = (current: E2eConfig): E2eConfig => {
      const { pending, ...rest } = current;
      const left = (pending ?? []).filter(other);
      return left.length > 0 ? { ...rest, pending: left } : rest;
    };
    // Saved before the server adds it: a failed save leaves nothing on either side.
    await options.update((current) => ({
      ...current,
      pending: [...(current.pending ?? []).filter(other), phone],
    }));
    const forget = () => options.update(dropPending).catch(() => undefined);
    let added: Response | undefined;
    try {
      added = await call('/v1/e2e/computer/devices', {
        method: 'POST',
        body: JSON.stringify({ offer_id: offer.offer_id }),
      });
    } catch (error) {
      // The link dropped: the server may or may not have added it. Ask; if it cannot say, the
      // phone stays pending and the next device sync settles it.
      const listed = await serverLists(options, server, headers.authorization, phone);
      if (listed === false) await forget();
      if (listed !== true) throw error;
    }
    if (added !== undefined && !added.ok) {
      await forget();
      if (added.status === 409 && (await errorCode(added)) === 'device_cap') return 'cap';
      if (added.status === 410 || added.status === 404) return 'expired';
      throw new Error(await refusal(added));
    }
    await options.update((current) => ({
      ...dropPending(current),
      devices: [...current.devices.filter(other), phone],
    }));
    return 'paired';
  } catch (error) {
    if (error instanceof PairStop) return error.outcome;
    throw error;
  }
}

/** Whether the server lists `phone` with its key; undefined when it cannot be asked. */
async function serverLists(
  options: PairPhoneOptions,
  server: URL,
  authorization: string,
  phone: TrustedDevice,
): Promise<boolean | undefined> {
  try {
    const res = await options.fetch(apiUrl(server, '/v1/e2e/computer/devices'), {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body = devicesResponseSchema.safeParse(await res.json());
    if (!body.success) return undefined;
    return body.data.devices.some(
      (d) => d.id === phone.id && d.public_key === phone.public_key && d.revoked_at === undefined,
    );
  } catch {
    return undefined;
  }
}

async function waitForClaim(
  options: PairPhoneOptions,
  call: (path: string) => Promise<Response>,
  offerId: string,
  expiresAt: number,
): Promise<Claim> {
  const now = options.now ?? Date.now;
  const wait = options.waitSeconds ?? 25;
  for (;;) {
    if (options.signal.aborted) throw new PairStop('cancelled');
    if (now() > expiresAt) throw new PairStop('expired');
    let res: Response;
    try {
      res = await call(`/v1/e2e/pairings/${offerId}?wait=${wait}`);
    } catch (error) {
      if (error instanceof PairStop) throw error;
      // A dropped long poll: try again shortly, until the offer runs out.
      await pause(RETRY_MS, options.signal);
      continue;
    }
    if (res.status === 204) continue;
    if (res.status === 410 || res.status === 404) throw new PairStop('expired');
    if (!res.ok) throw new Error(await refusal(res));
    const claim = claimResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (!claim.success) throw new PairStop('mismatch');
    return claim.data;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const errorBodySchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function errorCode(res: Response): Promise<string | undefined> {
  const body = errorBodySchema.safeParse(await res.json().catch(() => undefined));
  return body.success ? body.data.error.code : undefined;
}

async function refusal(res: Response): Promise<string> {
  const body = errorBodySchema.safeParse(await res.json().catch(() => undefined));
  if (body.success && body.data.error.code === 'private_chats_off')
    return 'Private chats are not available for this account yet.';
  return body.success
    ? body.data.error.message
    : `Twring could not pair your phone right now (${res.status}). Try again in a minute.`;
}
