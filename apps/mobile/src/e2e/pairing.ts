import {
  base64urlDecode,
  base64urlEncode,
  deviceIdFor,
  e2eDeviceIdSchema,
  e2eDeviceKindSchema,
  pairingMac,
  pairOfferIdSchema,
  publicKeySchema,
  safetyCode,
  type PairClaim,
  type PairOffer,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadOrCreateDeviceKey } from './device-key';

/**
 * Pairing this phone with a computer for private chats (ADR-044). The QR carries the computer's
 * key and a secret the server never sees; the phone proves it read the QR with a MAC, checks the
 * key the server answers with against the QR, and the person compares a 6-digit code on both
 * screens. Nothing is stored until they say the numbers match (`confirmPairing`).
 */
export const TRUSTED_KEY_NAME = 'twring.e2e.trusted.v1';
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
  })
  .strict();
export type TrustedDevice = z.infer<typeof trustedDeviceSchema>;
const trustedListSchema = z.array(trustedDeviceSchema).max(16);

/** QR only: P2 shipped no typed code (ruling P3 #3). */
export type PairInput = { kind: 'qr'; offer: PairOffer; server: string };

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

/** `POST /v1/e2e/pairings/:offerId/claim`, signed in; the raw answer, checked here. */
export interface PairApi {
  claim(offerId: string, body: PairClaim): Promise<{ status: number; body: unknown }>;
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

export type PairFailure = 'expired' | 'claimed' | 'mismatch' | 'cap' | 'network' | 'wrong_server';
export type ClaimResult =
  { ok: true; safety: string; connector: TrustedDevice } | { ok: false; code: PairFailure };

const claimAnswerSchema = z.object({
  connector_public_key: publicKeySchema,
  connector_device_id: e2eDeviceIdSchema,
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

export async function claimPairing(deps: PairDeps, input: PairInput): Promise<ClaimResult> {
  if (deps.activeServer !== undefined && originOf(deps.activeServer) !== originOf(input.server)) {
    deps.log?.('e2e_pair_failed', { reason: 'wrong_server' });
    return { ok: false, code: 'wrong_server' };
  }
  const me = await loadOrCreateDeviceKey(deps.store, deps.log);
  const connectorKey = base64urlDecode(input.offer.connector_public_key);
  // The computer's id comes from its key (P3 ruling): the QR carries no id to trust.
  const connectorDeviceId = deviceIdFor(connectorKey);
  const phoneName = deps.phoneName.trim().slice(0, 60) || 'Phone';
  const mac = pairingMac(base64urlDecode(input.offer.secret), {
    connectorPublic: connectorKey,
    phonePublic: me.publicKey,
    connectorDeviceId,
    phoneDeviceId: me.deviceId,
    phoneName,
  });
  let answer: { status: number; body: unknown };
  try {
    answer = await deps.api.claim(input.offer.offer_id, {
      offer_id: input.offer.offer_id,
      phone_device_id: me.deviceId,
      phone_public_key: base64urlEncode(me.publicKey),
      phone_name: phoneName,
      mac,
    });
  } catch {
    deps.log?.('e2e_pair_failed', { reason: 'network' });
    return { ok: false, code: 'network' };
  }
  if (answer.status < 200 || answer.status >= 300) {
    const code = refusal(answer.status, answer.body);
    deps.log?.('e2e_pair_failed', { reason: code, status: answer.status });
    return { ok: false, code };
  }
  const parsed = claimAnswerSchema.safeParse(answer.body);
  // A server that names another key or id than the QR implies is refused: never trusted.
  if (
    !parsed.success ||
    parsed.data.connector_public_key !== input.offer.connector_public_key ||
    parsed.data.connector_device_id !== connectorDeviceId
  ) {
    deps.log?.('e2e_pair_failed', { reason: 'mismatch' });
    return { ok: false, code: 'mismatch' };
  }
  return {
    ok: true,
    safety: safetyCode(connectorKey, me.publicKey),
    connector: {
      id: connectorDeviceId,
      kind: 'computer',
      name: 'Computer',
      public_key: input.offer.connector_public_key,
      verified_at: new Date(deps.now?.() ?? Date.now()).toISOString(),
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
  const others = current.filter(
    (d) => d.id !== connector.id && d.public_key !== connector.public_key,
  );
  const next = trustedListSchema.parse([...others, connector].slice(-16));
  await deps.store.setItemAsync(TRUSTED_KEY_NAME, JSON.stringify(next));
  deps.log?.('e2e_paired', { device_id: connector.id, trusted: next.length });
}

export async function forgetTrusted(store: SecureKeyValue): Promise<void> {
  await store.deleteItemAsync(TRUSTED_KEY_NAME);
}
