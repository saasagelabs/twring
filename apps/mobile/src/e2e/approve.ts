import {
  approvalBytesSchema,
  approvalCode,
  approvalCommitment,
  approvalCommitmentMatches,
  base64urlDecode,
  base64urlEncode,
  connectorIdSchema,
  keyMatchesId,
  MAX_PAIRED_DEVICES,
  newApprovalSecret,
  openTrustNote,
  phoneApprovalSchema,
  sealTrustNote,
  type PhoneApproval,
  type TrustNote,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadDeviceKey, loadOrCreateDeviceKey, type DeviceKey } from './device-key';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';
import { queueRewrap } from './rewrap';

/**
 * Approving a second phone from a phone that already has private chats (C3 #11, Task 27). The
 * new phone asks; a trusted phone takes the request and both show the same 6-digit code; when
 * the person says they match, the trusted phone seals a note naming the new phone, wrapped to the
 * new phone and to every device it trusts. The server only relays: a swapped key gives two
 * different codes.
 *
 * The code is commit, then reveal (ADR-046): the new phone sends a commitment to its key and a
 * random secret with its request; the approving phone sends its own random nonce only once it
 * holds that commitment; the new phone reveals its secret only once that nonce is fixed. So a
 * server that swaps a key cannot search for one that gives the same 6 digits. Logs carry ids and
 * states only.
 */

export const APPROVE_PATH = 'Approve from my other phone';
export const APPROVE_ASK = 'On your other phone, open Devices and approve this phone.';
export const APPROVE_DONE =
  'This phone can read new private messages. Older ones appear after your other phone shares them, the next time Twring is open there.';
export const WAITING_TITLE = 'Waiting for approval';
export const APPROVE_BUTTON = 'Codes match, approve';
export const DENY_BUTTON = 'Deny';

export function approveCheckCopy(approverName: string, code: string): string {
  return `Check that ${approverName} shows ${code}.`;
}

export function approveSheetCopy(newPhoneName: string): string {
  return `Make sure ${newPhoneName} shows the same 6 digits.`;
}

/** The approving phone, while the new phone has not yet sent what the code needs. */
export function approveNewPhoneWaitingCopy(newPhoneName: string): string {
  return `Waiting for ${newPhoneName}. Keep Twring open on it.`;
}

/** The new phone sent no commitment: an app from before ADR-046, refused (fail closed). */
export const APPROVE_OUTDATED =
  'That phone needs the latest Twring. Update Twring on the new phone, then ask again from it.';

const SECRET_KEY_PREFIX = 'twring.e2e.approval_secret.v1.';
const NONCE_KEY_PREFIX = 'twring.e2e.approval_nonce.v1.';

/** The new phone's secret for this approval, kept until the approval ends. */
export async function loadApprovalSecret(
  store: SecureKeyValue,
  id: string,
): Promise<Uint8Array | undefined> {
  return loadBytes(store, SECRET_KEY_PREFIX + id);
}

/** Drops this approval's secret (new phone) and nonce (approving phone), if any. */
export async function forgetApprovalSecrets(store: SecureKeyValue, id: string): Promise<void> {
  await Promise.all([
    store.deleteItemAsync(SECRET_KEY_PREFIX + id).catch(() => undefined),
    store.deleteItemAsync(NONCE_KEY_PREFIX + id).catch(() => undefined),
  ]);
}

async function loadBytes(store: SecureKeyValue, key: string): Promise<Uint8Array | undefined> {
  const raw = await store.getItemAsync(key);
  if (raw === null || !approvalBytesSchema.safeParse(raw).success) return undefined;
  return base64urlDecode(raw);
}

/** The signed-in approval calls; the raw answers, checked here. */
export interface ApproveApi {
  request(body: {
    device_id: string;
    public_key: string;
    name: string;
    commitment: string;
  }): Promise<{ status: number; body: unknown }>;
  status(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
  list(deviceId: string): Promise<{ status: number; body: unknown }>;
  claim(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
  nonce(id: string, deviceId: string, nonce: string): Promise<{ status: number; body: unknown }>;
  reveal(id: string, deviceId: string, reveal: string): Promise<{ status: number; body: unknown }>;
  accept(id: string, deviceId: string, note: TrustNote): Promise<{ status: number; body: unknown }>;
  deny(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
}

type Log = (event: string, fields?: Record<string, string | number>) => void;

export type ApproveFailure =
  'already_added' | 'cap' | 'busy' | 'expired' | 'closed' | 'mismatch' | 'outdated' | 'network';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });
const listSchema = z.object({ approvals: z.array(phoneApprovalSchema).max(16) });

function failure(status: number, body: unknown): ApproveFailure {
  const parsed = errorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  if (code === 'already_added') return 'already_added';
  if (code === 'device_cap') return 'cap';
  if (code === 'approval_cap') return 'busy';
  if (status === 410 || code === 'expired') return 'expired';
  if (code === 'approval_closed' || code === 'not_found') return 'closed';
  return 'network';
}

async function call(
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ ok: true; body: unknown } | { ok: false; code: ApproveFailure }> {
  let answer: { status: number; body: unknown };
  try {
    answer = await run();
  } catch {
    return { ok: false, code: 'network' };
  }
  if (answer.status < 200 || answer.status >= 300)
    return { ok: false, code: failure(answer.status, answer.body) };
  return { ok: true, body: answer.body };
}

function approvalFrom(
  body: unknown,
): { ok: true; approval: PhoneApproval } | { ok: false; code: ApproveFailure } {
  const parsed = phoneApprovalSchema.safeParse(body);
  return parsed.success ? { ok: true, approval: parsed.data } : { ok: false, code: 'network' };
}

// New phone

/** The new phone asks to be approved (making its device key if it has none). */
export async function requestApproval(deps: {
  api: Pick<ApproveApi, 'request'>;
  store: SecureKeyValue;
  phoneName: string;
  log?: Log;
}): Promise<{ ok: true; approval: PhoneApproval } | { ok: false; code: ApproveFailure }> {
  const me = await loadOrCreateDeviceKey(deps.store, deps.log);
  const secret = newApprovalSecret();
  const commitment = base64urlEncode(approvalCommitment(me.publicKey, secret));
  const answer = await call(() =>
    deps.api.request({
      device_id: me.deviceId,
      public_key: base64urlEncode(me.publicKey),
      name: deps.phoneName,
      commitment,
    }),
  );
  if (!answer.ok) {
    deps.log?.('e2e_phone_approval_failed', { reason: answer.code });
    return answer;
  }
  const out = approvalFrom(answer.body);
  if (!out.ok) return out;
  if (out.approval.commitment !== commitment) return { ok: false, code: 'mismatch' };
  // Kept until the approval ends, so a restart mid-way can still reveal it.
  await deps.store.setItemAsync(SECRET_KEY_PREFIX + out.approval.id, base64urlEncode(secret));
  deps.log?.('e2e_phone_approval_requested', { approval_id: out.approval.id });
  return out;
}

/** The new phone's request as the server answers it now. */
export async function approvalStatus(
  deps: { api: Pick<ApproveApi, 'status'>; store: SecureKeyValue },
  id: string,
): Promise<{ ok: true; approval: PhoneApproval } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return { ok: false, code: 'closed' };
  const answer = await call(() => deps.api.status(id, me.deviceId));
  return answer.ok ? approvalFrom(answer.body) : answer;
}

/** Who the new phone shows the code for: the approving phone the server names, as claimed. */
export interface ShownApprover {
  id: string;
  name: string;
  public_key: string;
  /** The approving phone's nonce the code was made with. */
  nonce: string;
  code: string;
}

/**
 * The code the new phone shows for this claim, or undefined while it is not usable yet: no
 * approver, or no approver nonce yet (the code needs it).
 */
export function shownApprover(
  approval: PhoneApproval,
  me: DeviceKey,
  secret: Uint8Array,
): ShownApprover | undefined {
  const approver = approval.approver;
  const nonce = approval.approver_nonce;
  if (
    approver === undefined ||
    nonce === undefined ||
    !keyMatchesId(approver) ||
    approver.id === me.deviceId
  )
    return undefined;
  return {
    ...approver,
    nonce,
    code: approvalCode(
      me.publicKey,
      base64urlDecode(approver.public_key),
      secret,
      base64urlDecode(nonce),
    ),
  };
}

/**
 * What a phone does with the other phone an answer names: show it the first time, keep it when
 * it is the same phone, key and nonce, and stop when any changes after a code was shown (a code
 * must never be replaced silently while a person compares it).
 */
export function approverUpdate(
  shown: { id: string; public_key: string; nonce?: string } | undefined,
  next: { id: string; public_key: string; nonce?: string },
): 'show' | 'same' | 'changed' {
  if (shown === undefined) return 'show';
  return shown.id === next.id && shown.public_key === next.public_key && shown.nonce === next.nonce
    ? 'same'
    : 'changed';
}

/**
 * The new phone reveals its secret, now that the approver's nonce is fixed, before it shows the
 * code. Already revealed (a restart) is fine when it is this phone's own secret.
 */
export async function revealApproval(
  deps: { api: Pick<ApproveApi, 'reveal'>; store: SecureKeyValue; log?: Log },
  approval: PhoneApproval,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  const secret = await loadApprovalSecret(deps.store, approval.id);
  if (me === undefined || secret === undefined || approval.approver_nonce === undefined)
    return { ok: false, code: 'mismatch' };
  const mine = base64urlEncode(secret);
  if (approval.reveal !== undefined)
    return approval.reveal === mine ? { ok: true } : { ok: false, code: 'mismatch' };
  const answer = await call(() => deps.api.reveal(approval.id, me.deviceId, mine));
  if (!answer.ok) return answer;
  const out = approvalFrom(answer.body);
  if (!out.ok) return out;
  if (out.approval.reveal !== mine || out.approval.approver_nonce !== approval.approver_nonce)
    return { ok: false, code: 'mismatch' };
  deps.log?.('e2e_phone_approval_revealed', { approval_id: approval.id });
  return { ok: true };
}

/**
 * Runs `check` every `everyMs` while it is not already running (one poll at a time; a failure
 * waits for the next tick). The returned stop ends it for good.
 */
export function pollApproval(check: () => Promise<void>, everyMs: number): () => void {
  let running = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = true;
    void check()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, everyMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The new phone applies its own note (P4b ruling 5): sent by the approver it showed the code for,
 * naming this phone. It then trusts that phone and each device the note knows (never itself).
 */
export function trustFromOwnNote(
  note: TrustNote,
  shown: Pick<ShownApprover, 'id' | 'name' | 'public_key'>,
  me: DeviceKey,
  now: number,
): TrustedDevice[] | undefined {
  if (note.sender_device !== shown.id) return undefined;
  let payload;
  try {
    payload = openTrustNote(
      note,
      { deviceId: me.deviceId, privateKey: me.privateKey },
      base64urlDecode(shown.public_key),
    );
  } catch {
    return undefined;
  }
  if (payload.add.id !== me.deviceId || payload.add.public_key !== base64urlEncode(me.publicKey))
    return undefined;
  const verifiedAt = new Date(now).toISOString();
  const out: TrustedDevice[] = [
    {
      id: shown.id,
      kind: 'phone',
      name: shown.name,
      public_key: shown.public_key,
      verified_at: verifiedAt,
    },
  ];
  for (const known of payload.known) {
    if (known.id === me.deviceId || !keyMatchesId(known)) continue;
    if (out.some((d) => d.id === known.id)) continue;
    const connector = connectorIdSchema.safeParse(known.connector_id);
    out.push({
      id: known.id,
      kind: known.kind,
      name: known.name,
      public_key: known.public_key,
      verified_at: verifiedAt,
      ...(known.kind === 'computer' && connector.success && { connector_id: connector.data }),
    });
  }
  return out;
}

/**
 * Saves what the new phone's accepted note says. False (nothing saved) for a note from another
 * device than the one whose code was shown, or one that does not name this phone.
 */
export async function finishApproval(
  deps: { store: SecureKeyValue; now?: () => number; log?: Log },
  approval: PhoneApproval,
  shown: Pick<ShownApprover, 'id' | 'name' | 'public_key'>,
): Promise<boolean> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined || approval.trust_note === undefined) return false;
  const learned = trustFromOwnNote(approval.trust_note, shown, me, (deps.now ?? Date.now)());
  if (learned === undefined) {
    deps.log?.('e2e_trust_note_refused', { reason: 'own_note' });
    return false;
  }
  const current = await loadTrusted(deps.store);
  const merged = [...current.filter((d) => !learned.some((l) => l.id === d.id)), ...learned];
  await saveTrusted(deps.store, merged);
  // Earlier private messages this phone sent: shared with the approver next (`rewrap.ts`).
  await queueRewrap(deps.store, { id: shown.id, public_key: shown.public_key }).catch(() =>
    deps.log?.('e2e_rewrap_queue_failed', { approval_id: approval.id }),
  );
  await forgetApprovalSecrets(deps.store, approval.id);
  deps.log?.('e2e_phone_approval_done', { approval_id: approval.id, trusted: learned.length });
  return true;
}

// Approving phone

/** Phones waiting for this phone's approval. Empty when this phone has no key or on a failure. */
export async function listWaiting(deps: {
  api: Pick<ApproveApi, 'list'>;
  store: SecureKeyValue;
}): Promise<PhoneApproval[]> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return [];
  const answer = await call(() => deps.api.list(me.deviceId));
  if (!answer.ok) return [];
  const parsed = listSchema.safeParse(answer.body);
  return parsed.success ? parsed.data.approvals.filter((a) => a.device_id !== me.deviceId) : [];
}

/** A waiting phone this phone took and sent its nonce for; no code until the new phone reveals. */
export type ClaimedApproval = { approval: PhoneApproval; nonce: string };
/** The new phone revealed and it opened its commitment: the code both screens show. */
export type CheckedApproval = { approval: PhoneApproval; code: string };

/** Same new phone, key and commitment as when it was claimed. */
function sameRequest(a: PhoneApproval, b: PhoneApproval): boolean {
  return (
    a.id === b.id &&
    a.device_id === b.device_id &&
    a.public_key === b.public_key &&
    a.commitment === b.commitment
  );
}

/**
 * Takes a waiting phone and, only once it holds the new phone's commitment, sends this phone's
 * random nonce. A request without a commitment (an older app) is refused.
 */
export async function claimWaiting(
  deps: { api: Pick<ApproveApi, 'claim' | 'nonce'>; store: SecureKeyValue; log?: Log },
  id: string,
): Promise<{ ok: true; claimed: ClaimedApproval } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return { ok: false, code: 'closed' };
  const answer = await call(() => deps.api.claim(id, me.deviceId));
  if (!answer.ok) return answer;
  const out = approvalFrom(answer.body);
  if (!out.ok) return out;
  const approval = out.approval;
  if (
    approval.id !== id ||
    !keyMatchesId({ id: approval.device_id, public_key: approval.public_key }) ||
    approval.device_id === me.deviceId
  )
    return { ok: false, code: 'mismatch' };
  if (approval.commitment === undefined) {
    deps.log?.('e2e_phone_approval_failed', { approval_id: id, reason: 'outdated' });
    return { ok: false, code: 'outdated' };
  }
  deps.log?.('e2e_phone_approval_claimed', { approval_id: id });
  // A nonce kept from before a restart is reused; the server takes only one.
  const kept = await loadBytes(deps.store, NONCE_KEY_PREFIX + id);
  const nonce = base64urlEncode(kept ?? newApprovalSecret());
  if (approval.approver_nonce !== undefined)
    return approval.approver_nonce === nonce
      ? { ok: true, claimed: { approval, nonce } }
      : { ok: false, code: 'mismatch' };
  if (kept === undefined) await deps.store.setItemAsync(NONCE_KEY_PREFIX + id, nonce);
  const sent = await call(() => deps.api.nonce(id, me.deviceId, nonce));
  if (!sent.ok) return sent;
  const after = approvalFrom(sent.body);
  if (!after.ok) return after;
  if (!sameRequest(approval, after.approval) || after.approval.approver_nonce !== nonce)
    return { ok: false, code: 'mismatch' };
  return { ok: true, claimed: { approval: after.approval, nonce } };
}

/**
 * The approving phone asks whether the new phone revealed its secret. `waiting` until it has;
 * then the secret must open the commitment it held before sending its nonce (else `mismatch`),
 * and the code is made from what was claimed and checked here, never from a later answer.
 */
export async function checkReveal(
  deps: { api: Pick<ApproveApi, 'status'>; store: SecureKeyValue; log?: Log },
  claimed: ClaimedApproval,
): Promise<
  | { ok: true; waiting: true }
  | { ok: true; checked: CheckedApproval }
  | { ok: false; code: ApproveFailure }
> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined || claimed.approval.commitment === undefined)
    return { ok: false, code: 'mismatch' };
  const answer = await call(() => deps.api.status(claimed.approval.id, me.deviceId));
  if (!answer.ok) return answer;
  const out = approvalFrom(answer.body);
  if (!out.ok) return out;
  const next = out.approval;
  if (next.state === 'expired') return { ok: false, code: 'expired' };
  if (next.state !== 'claimed') return { ok: false, code: 'closed' };
  if (
    !sameRequest(claimed.approval, next) ||
    next.approver_nonce !== claimed.nonce ||
    next.approver?.id !== me.deviceId
  )
    return { ok: false, code: 'mismatch' };
  if (next.reveal === undefined) return { ok: true, waiting: true };
  const newKey = base64urlDecode(claimed.approval.public_key);
  const reveal = base64urlDecode(next.reveal);
  if (!approvalCommitmentMatches(base64urlDecode(claimed.approval.commitment), newKey, reveal)) {
    deps.log?.('e2e_phone_approval_failed', {
      approval_id: claimed.approval.id,
      reason: 'commitment',
    });
    return { ok: false, code: 'mismatch' };
  }
  return {
    ok: true,
    checked: {
      approval: { ...claimed.approval, reveal: next.reveal },
      code: approvalCode(newKey, me.publicKey, reveal, base64urlDecode(claimed.nonce)),
    },
  };
}

/**
 * The codes matched: seal the note naming the new phone, wrapped to it and to every device this
 * phone trusts, send it, and trust the new phone here too.
 */
export async function approveWaiting(
  deps: {
    api: Pick<ApproveApi, 'accept'>;
    store: SecureKeyValue;
    now?: () => number;
    log?: Log;
  },
  checked: CheckedApproval,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  // Only the approval that was claimed and whose reveal opened its commitment (`checkReveal`).
  const approval = checked.approval;
  const me = await loadDeviceKey(deps.store);
  if (
    me === undefined ||
    approval.commitment === undefined ||
    approval.reveal === undefined ||
    !keyMatchesId({ id: approval.device_id, public_key: approval.public_key }) ||
    !approvalCommitmentMatches(
      base64urlDecode(approval.commitment),
      base64urlDecode(approval.public_key),
      base64urlDecode(approval.reveal),
    )
  )
    return { ok: false, code: 'mismatch' };
  const trusted = (await loadTrusted(deps.store)).filter((d) => d.id !== approval.device_id);
  const others = trusted.slice(0, MAX_PAIRED_DEVICES - 1);
  const note = sealTrustNote({
    payload: {
      kind: 'trust_add',
      approval_id: approval.id,
      add: {
        id: approval.device_id,
        kind: 'phone',
        name: approval.name,
        public_key: approval.public_key,
      },
      known: others.map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.name,
        public_key: d.public_key,
        ...(d.connector_id !== undefined && { connector_id: d.connector_id }),
      })),
    },
    senderDevice: me.deviceId,
    senderPrivate: me.privateKey,
    recipients: [
      { id: approval.device_id, publicKey: base64urlDecode(approval.public_key) },
      ...others.map((d) => ({ id: d.id, publicKey: base64urlDecode(d.public_key) })),
    ],
  });
  const answer = await call(() => deps.api.accept(approval.id, me.deviceId, note));
  if (!answer.ok) {
    deps.log?.('e2e_phone_approval_failed', { approval_id: approval.id, reason: answer.code });
    return answer;
  }
  const current = await loadTrusted(deps.store);
  if (!current.some((d) => d.id === approval.device_id))
    await saveTrusted(deps.store, [
      ...current,
      {
        id: approval.device_id,
        kind: 'phone',
        name: approval.name,
        public_key: approval.public_key,
        verified_at: new Date((deps.now ?? Date.now)()).toISOString(),
      },
    ]);
  // Older private messages: this phone shares them next (`rewrap.ts`), now and on later opens.
  await queueRewrap(deps.store, { id: approval.device_id, public_key: approval.public_key }).catch(
    () => undefined,
  );
  await forgetApprovalSecrets(deps.store, approval.id);
  deps.log?.('e2e_phone_approved', { approval_id: approval.id });
  return { ok: true };
}

export async function denyWaiting(
  deps: { api: Pick<ApproveApi, 'deny'>; store: SecureKeyValue; log?: Log },
  id: string,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return { ok: false, code: 'closed' };
  const answer = await call(() => deps.api.deny(id, me.deviceId));
  await forgetApprovalSecrets(deps.store, id);
  if (answer.ok) deps.log?.('e2e_phone_approval_denied', { approval_id: id });
  return answer.ok ? { ok: true } : answer;
}
