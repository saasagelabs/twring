import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  base64urlDecode,
  base64urlEncode,
  e2eDeviceIdSchema,
  pairOfferIdSchema,
  pairingMac,
  publicKeySchema,
  safetyCode,
} from '@twring/contracts';
import { z } from 'zod';

import { apiUrl, checkServerUrl, type ConnectorConfig } from '../config';
import { terminalQr } from '../link';
import type { TrustedDevice } from './keys';

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
  /** Saves the config with the new phone; called only once pairing succeeded. */
  save: (config: ConnectorConfig) => Promise<void>;
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
 * server never sees; the phone's claim must carry an HMAC over both public keys with it, and the
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
    // The MAC proves the phone read this QR: a key swapped on the way fails here.
    if (!sameText(pairingMac(secret, mine, phoneKey), claim.mac)) {
      print('Your phone sent a code this computer could not check. Nothing was paired.');
      return 'mismatch';
    }
    const code = safetyCode(mine, phoneKey);
    print(`Check that your phone shows ${code}.`);
    if (!(await options.confirm(code))) {
      print('The numbers did not match, so nothing was paired.');
      return 'mismatch';
    }
    const added = await call('/v1/e2e/computer/devices', {
      method: 'POST',
      body: JSON.stringify({ offer_id: offer.offer_id }),
    });
    if (added.status === 409 && (await errorCode(added)) === 'device_cap') return 'cap';
    if (added.status === 410 || added.status === 404) return 'expired';
    if (!added.ok) throw new Error(await refusal(added));
    const phone: TrustedDevice = {
      id: claim.phone_device_id,
      kind: 'phone',
      name: claim.phone_name,
      public_key: claim.phone_public_key,
      verified_at: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    await options.save({
      ...config,
      e2e: {
        ...e2e,
        devices: [
          ...e2e.devices.filter((d) => d.id !== phone.id && d.public_key !== phone.public_key),
          phone,
        ],
      },
    });
    return 'paired';
  } catch (error) {
    if (error instanceof PairStop) return error.outcome;
    throw error;
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
