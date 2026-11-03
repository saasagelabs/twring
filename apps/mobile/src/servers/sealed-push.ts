import { base64urlDecode, open } from '@twring/contracts';

import { openedNotificationRoute, type OpenedRoute } from '../ring/system-call';
import type { ProfileSecrets, ServerProfile } from './profiles';

/**
 * A `cord.sealed` push from a person's own server, opened on the phone: the JavaScript twin of
 * the Android check (Sealed.kt). The relay only sees the envelope; the inner push must match the
 * outer kind and be fresh, so it can be neither relabelled nor replayed. Never logs keys,
 * envelopes or plaintext.
 */

const MAX_FUTURE_MS = 10 * 60_000;
const MAX_RING_AGE_MS = 5 * 60_000;
const MAX_AGE_MS = 24 * 60 * 60_000;

const KIND_TYPES: Record<string, string> = {
  ring: 'cord.ring',
  ring_cancel: 'cord.ring_cancel',
  missed_call: 'cord.ring_cancel',
  message: 'cord.message',
};

/** The inner push without the sealed-only fields, or undefined when nothing opens it or a check fails. */
export function openSealedPush(
  data: unknown,
  keys: readonly Uint8Array[],
  nowMs: number,
): Record<string, unknown> | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { kind, sealed } = data as Record<string, unknown>;
  if (typeof kind !== 'string' || !Object.hasOwn(KIND_TYPES, kind)) return undefined;
  if (typeof sealed !== 'string') return undefined;
  const plaintext = firstOpened(keys, sealed);
  if (plaintext === undefined) return undefined;
  let inner: unknown;
  try {
    inner = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return undefined;
  }
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return undefined;
  const fields = inner as Record<string, unknown>;
  if (fields.kind !== kind || fields.type !== KIND_TYPES[kind]) return undefined;
  if (kind === 'missed_call' && fields.status !== 'missed') return undefined;
  const id = fields.id;
  if (typeof id !== 'string' || id === '') return undefined;
  if (id !== fields[kind === 'message' ? 'message_id' : 'invite_id']) return undefined;
  const issuedAt = parseTime(fields.issued_at);
  if (issuedAt === undefined) return undefined;
  const maxAge = kind === 'ring' ? MAX_RING_AGE_MS : MAX_AGE_MS;
  if (issuedAt > nowMs + MAX_FUTURE_MS || nowMs - issuedAt > maxAge) return undefined;
  // The strict message push schema refuses the added fields.
  const push = { ...fields };
  delete push.kind;
  delete push.id;
  delete push.issued_at;
  return push;
}

/** The first stored key that opens the envelope; a wrong key, bad shape or version opens nothing. */
function firstOpened(keys: readonly Uint8Array[], envelope: string): Uint8Array | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { v, n, c } = parsed as Record<string, unknown>;
  if (v !== 1 || typeof n !== 'string' || typeof c !== 'string') return undefined;
  for (const key of keys) {
    try {
      return open(key, { v: 1, n, c });
    } catch {
      // Not this key.
    }
  }
  return undefined;
}

/** ISO 8601 UTC as `Date.toISOString()` writes it, with or without milliseconds. */
function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A tapped notification payload that came sealed from a person's own server. */
export function isSealedPush(data: unknown): boolean {
  return (
    typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'cord.sealed'
  );
}

export interface OpenedSealedDeps {
  active: () => Pick<ServerProfile, 'kind'> & { serverId?: string };
  secrets: (serverId: string) => Promise<ProfileSecrets | undefined>;
  now: () => number;
}

/**
 * Where a tapped `cord.sealed` notification leads, routed like the plain inner push. Anything
 * that does not open (another server's key, tampered, stale, Twring's own service) leads nowhere,
 * so the app just opens on its home screen with no error.
 */
export async function openedSealedRoute(
  data: unknown,
  deps: OpenedSealedDeps,
): Promise<OpenedRoute | undefined> {
  const profile = deps.active();
  if (profile.kind !== 'selfhost' || profile.serverId === undefined) return undefined;
  try {
    const secrets = await deps.secrets(profile.serverId);
    if (secrets === undefined) return undefined;
    const inner = openSealedPush(data, [base64urlDecode(secrets.sealKey)], deps.now());
    return inner === undefined ? undefined : openedNotificationRoute(inner);
  } catch {
    return undefined;
  }
}
