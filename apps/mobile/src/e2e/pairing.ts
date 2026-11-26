import {
  base64urlDecode,
  base64urlEncode,
  connectorIdSchema,
  deviceIdFor,
  e2eDeviceIdSchema,
  e2eDeviceKindSchema,
  normalizeTypedPairCode,
  offerKeyMacMatches,
  pairingMac,
  pairOfferIdSchema,
  publicKeySchema,
  safetyCode,
  splitTypedPairCode,
  typedPairKey,
  type PairClaim,
  type PairOffer,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadOrCreateDeviceKey, TRUSTED_KEY_NAME } from './device-key';

/**
 * Pairing this phone with a computer for private chats (ADR-044). The QR carries the computer's
 * key and a secret the server never sees; the phone proves it read the QR with a MAC, checks the
 * key the server answers with against the QR, and the person compares a 6-digit code on both
 * screens. Nothing is stored until they say the numbers match (`confirmPairing`).
 */
export { TRUSTED_KEY_NAME };
const PAIR_LINK_PREFIX = 'twring-pair:';

/** The computer's QR (mirrors `pairLinkSchema` in apps/connector/src/e2e/pair.ts). */
const pairLinkSchema = z
  .object({ s: z.url(), o: pairOfferIdSchema, k: publicKeySchema, x: publicKeySchema })
  .strict();

/** A device this phone checked itself at pairing (MAC, key and safety code). */
export const trustedDeviceSchema = z
  .object({
    id: e2eDeviceIdSchema,
    kind: e2eDeviceKindSchema,
    name: z.string().min(1).max(60),
    public_key: publicKeySchema,
    verified_at: z.iso.datetime(),
    /**
     * A computer's connector (`con_...`): its replies and approvals are taken only in chats with
     * that connector's agents (C3 #11 P4a). Absent on entries paired before; see `devices.ts`.
     */
    connector_id: connectorIdSchema.optional(),
  })
  .strict();
export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;
const trustedListSchema = z.array(trustedDeviceSchema).max(16);

/**
 * The QR, or the code typed instead (C3 #11). A typed code holds no server: it pairs on the
 * phone's active server, where its handle finds the offer.
 */
export type PairInput =
  { kind: 'qr'; offer: PairOffer; server: string } | { kind: 'typed'; code: string };

/** A typed code as people type it (`normalizeTypedPairCode`), or undefined when it is not one. */
export function parseTypedPairCode(text: string): PairInput | undefined {
  const code = normalizeTypedPairCode(text);
  return code === undefined ? undefined : { kind: 'typed', code };
}

export function parsePairInput(text: string): PairInput | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PAIR_LINK_PREFIX)) return undefined;
  try {
    const json: unknown = JSON.parse(
      new TextDecoder().decode(base64urlDecode(trimmed.slice(PAIR_LINK_PREFIX.length))),
    );
    const link = pairLinkSchema.safeParse(json);
    if (!link.success) return undefined;
    return {
      kind: 'qr',
      server: link.data.s,
      offer: { offer_id: link.data.o, connector_public_key: link.data.k, secret: link.data.x },
    };
  } catch {
    return undefined;
  }
}

/** The signed-in pairing calls; the raw answers, checked here. */
export interface PairApi {
  /** `POST /v1/e2e/pairings/:offerId/claim` */
  claim(offerId: string, body: PairClaim): Promise<{ status: number; body: unknown }>;
  /** `POST /v1/e2e/pairings/lookup`: the offer a typed code's handle names. */
  lookup(handle: string): Promise<{ status: number; body: unknown }>;
}

export interface PairDeps {
  api: PairApi;
  store: SecureKeyValue;
  /** This phone's name as the computer will list it (1 to 60 characters). */
  phoneName: string;
  /** The phone's active server; a code naming another server is refused before anything else. */
  activeServer?: string;
  now?: () => number;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

export type PairFailure =
  | 'expired'
  | 'claimed'
  | 'mismatch'
  | 'cap'
  | 'network'
  | 'wrong_server'
  | 'wrong_code'
  | 'too_many';
export type ClaimResult =
  { ok: true; safety: string; connector: TrustedDevice } | { ok: false; code: PairFailure };

const claimAnswerSchema = z.object({
  connector_public_key: publicKeySchema,
  connector_device_id: e2eDeviceIdSchema,
  /** Older servers send none; the entry is then bound later from the device list. */
  connector_id: connectorIdSchema.optional(),
});
const lookupAnswerSchema = z.object({
  offer_id: pairOfferIdSchema,
  connector_public_key: publicKeySchema,
  connector_device_id: e2eDeviceIdSchema,
  key_mac: z.string().min(1).max(64),
});
const errorSchema = z.object({ error: z.object({ code: z.string() }) });

function refusal(status: number, body: unknown): PairFailure {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  if (code === 'device_cap') return 'cap';
  if (code === 'offer_claimed' || (status === 409 && code === undefined)) return 'claimed';
  if (status === 410 || code === 'offer_expired' || code === 'not_found') return 'expired';
  return 'network';
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** What a claim needs, from the QR or from a typed code's checked lookup. */
interface ClaimPlan {
  offerId: string;
  connectorPublicKey: string;
  macKey: Uint8Array;
  key?: 'typed';
}

/**
 * A typed code's offer: the server answers the computer's key for the handle, so the phone
 * checks the computer's commitment with the code's secret before using that key. A swapped key
 * or a wrong code fails here, before any claim; both read as "that code didn't work".
 */
async function typedPlan(
  deps: PairDeps,
  code: string,
): Promise<ClaimPlan | { failure: PairFailure }> {
  const { handle, secret } = splitTypedPairCode(code);
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.api.lookup(handle);
  } catch {
    return { failure: 'network' };
  }
  if (answer.status === 429) return { failure: 'too_many' };
  if (answer.status === 404) return { failure: 'wrong_code' };
  if (answer.status < 200 || answer.status >= 300) return { failure: 'network' };
  const found = lookupAnswerSchema.safeParse(answer.body);
  if (!found.success) return { failure: 'wrong_code' };
  const macKey = typedPairKey(secret);
  const connectorKey = base64urlDecode(found.data.connector_public_key);
  if (
    found.data.connector_device_id !== deviceIdFor(connectorKey) ||
    !offerKeyMacMatches(macKey, connectorKey, found.data.connector_device_id, found.data.key_mac)
  )
    return { failure: 'wrong_code' };
  return {
    offerId: found.data.offer_id,
    connectorPublicKey: found.data.connector_public_key,
    macKey,
    key: 'typed',
  };
}

export async function claimPairing(deps: PairDeps, input: PairInput): Promise<ClaimResult> {
  if (
    input.kind === 'qr' &&
    deps.activeServer !== undefined &&
    originOf(deps.activeServer) !== originOf(input.server)
  ) {
    deps.log?.('e2e_pair_failed', { reason: 'wrong_server' });
    return { ok: false, code: 'wrong_server' };
  }
  let plan: ClaimPlan;
  if (input.kind === 'typed') {
    const typed = await typedPlan(deps, input.code);
    if ('failure' in typed) {
      deps.log?.('e2e_pair_failed', { reason: typed.failure });
      return { ok: false, code: typed.failure };
    }
    plan = typed;
  } else {
    plan = {
      offerId: input.offer.offer_id,
      connectorPublicKey: input.offer.connector_public_key,
      macKey: base64urlDecode(input.offer.secret),
    };
  }
  // With a typed code a refused claim reads as a wrong code, except a full list or no network.
  const failure = (code: PairFailure): PairFailure =>
    input.kind === 'typed' && code !== 'cap' && code !== 'network' ? 'wrong_code' : code;
  const me = await loadOrCreateDeviceKey(deps.store, deps.log);
  const connectorKey = base64urlDecode(plan.connectorPublicKey);
  // The computer's id comes from its key (P3 ruling): the QR carries no id to trust.
  const connectorDeviceId = deviceIdFor(connectorKey);
  const phoneName = deps.phoneName.trim().slice(0, 60) || 'Phone';
  const mac = pairingMac(plan.macKey, {
    connectorPublic: connectorKey,
    phonePublic: me.publicKey,
    connectorDeviceId,
    phoneDeviceId: me.deviceId,
    phoneName,
  });
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.api.claim(plan.offerId, {
      offer_id: plan.offerId,
      phone_device_id: me.deviceId,
      phone_public_key: base64urlEncode(me.publicKey),
      phone_name: phoneName,
      mac,
      // A QR claim stays exactly as before typed codes.
      ...(plan.key !== undefined && { key: plan.key }),
    });
  } catch {
    deps.log?.('e2e_pair_failed', { reason: 'network' });
    return { ok: false, code: 'network' };
  }
  if (answer.status < 200 || answer.status >= 300) {
    const code = failure(refusal(answer.status, answer.body));
    deps.log?.('e2e_pair_failed', { reason: code, status: answer.status });
    return { ok: false, code };
  }
  const parsed = claimAnswerSchema.safeParse(answer.body);
  // A server that names another key or id than the QR (or the checked lookup) implies is
  // refused: never trusted.
  if (
    !parsed.success ||
    parsed.data.connector_public_key !== plan.connectorPublicKey ||
    parsed.data.connector_device_id !== connectorDeviceId
  ) {
    const code = failure('mismatch');
    deps.log?.('e2e_pair_failed', { reason: code });
    return { ok: false, code };
  }
  return {
    ok: true,
    safety: safetyCode(connectorKey, me.publicKey),
    connector: {
      id: connectorDeviceId,
      kind: 'computer',
      name: 'Computer',
      public_key: plan.connectorPublicKey,
      verified_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
      ...(parsed.data.connector_id !== undefined && { connector_id: parsed.data.connector_id }),
    },
  };
}

export async function loadTrusted(store: SecureKeyValue): Promise<TrustedDevice[]> {
  const raw = await store.getItemAsync(TRUSTED_KEY_NAME);
  if (raw === null) return [];
  try {
    const parsed = trustedListSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** After the person said the numbers match: the computer joins this phone's trusted list. */
export async function confirmPairing(
  deps: Pick<PairDeps, 'store' | 'log'>,
  connector: TrustedDevice,
): Promise<void> {
  const current = await loadTrusted(deps.store);
  // Only this computer's own older entry (same id or key) is replaced. The connector id comes
  // from the server's claim answer, which nothing the person checked covers (R4-2), so it never
  // removes another computer: a computer set up again (same connector, new key) is bound to that
  // connector beside its old entry and works at once (`computerAllowed` matches the binding); the
  // old key leaves when the device list marks it removed.
  const others = current.filter(
    (d) => d.id !== connector.id && d.public_key !== connector.public_key,
  );
  const next = trustedListSchema.parse([...others, connector].slice(-16));
  await deps.store.setItemAsync(TRUSTED_KEY_NAME, JSON.stringify(next));
  deps.log?.('e2e_paired', { device_id: connector.id, trusted: next.length });
}

/** Saves the trusted list as it is now (devices.ts drops revoked ones and binds older ones). */
export async function saveTrusted(store: SecureKeyValue, list: TrustedDevice[]): Promise<void> {
  await store.setItemAsync(TRUSTED_KEY_NAME, JSON.stringify(trustedListSchema.parse(list)));
}

export async function forgetTrusted(store: SecureKeyValue): Promise<void> {
  await store.deleteItemAsync(TRUSTED_KEY_NAME);
}
