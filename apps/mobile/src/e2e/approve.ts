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
import {
  loadTrusted,
  removedIds,
  saveTrusted,
  unremove,
  withTrustLock,
  type TrustedDevice,
} from './pairing';
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
// An older app on the other phone does not list this request at all (it can't read it).
export const APPROVE_ASK =
  "On your other phone, open Devices and approve this phone. If it isn't listed there, update Twring on that phone first.";
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
/** Approving phone: its nonce with the request it was made for, written before it is sent. */
const CLAIM_KEY_PREFIX = 'twring.e2e.approval_claim.v1.';
/** New phone: the approver and nonce it revealed against, written before the reveal is sent. */
const REVEAL_KEY_PREFIX = 'twring.e2e.approval_reveal.v1.';
/**
 * Approving phone: an approve whose answer was lost on the network, which the server may already
 * have taken. Kept (one at a time) until it is finished or over (`resumePendingApprove`).
 */
export const PENDING_APPROVE_KEY_NAME = 'twring.e2e.approval_pending.v1';

const claimRecordSchema = z
  .object({
    nonce: approvalBytesSchema,
    device_id: z.string().min(1).max(128),
    public_key: z.string().min(1).max(128),
    commitment: approvalBytesSchema,
  })
  .strict();
type ClaimRecord = z.infer<typeof claimRecordSchema>;

const pendingApproveSchema = z
  .object({ approval: phoneApprovalSchema, code: z.string().min(1).max(16) })
  .strict();

const revealRecordSchema = z
  .object({
    approver_id: z.string().min(1).max(128),
    approver_key: z.string().min(1).max(128),
    nonce: approvalBytesSchema,
  })
  .strict();
type RevealRecord = z.infer<typeof revealRecordSchema>;

/** 'missing' when nothing is stored; 'bad' when something is stored but unreadable. */
async function loadRecord<T>(
  store: SecureKeyValue,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | 'missing' | 'bad'> {
  const raw = await store.getItemAsync(key);
  if (raw === null) return 'missing';
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'bad';
  } catch {
    return 'bad';
  }
}

/** The new phone's secret for this approval, kept until the approval ends. */
export async function loadApprovalSecret(
  store: SecureKeyValue,
  id: string,
): Promise<Uint8Array | undefined> {
  return loadBytes(store, SECRET_KEY_PREFIX + id);
}

/** Drops this approval's secret and reveal record (new phone) and claim (approving phone). */
export async function forgetApprovalSecrets(store: SecureKeyValue, id: string): Promise<void> {
  await Promise.all([
    store.deleteItemAsync(SECRET_KEY_PREFIX + id).catch(() => undefined),
    store.deleteItemAsync(REVEAL_KEY_PREFIX + id).catch(() => undefined),
    store.deleteItemAsync(CLAIM_KEY_PREFIX + id).catch(() => undefined),
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
 * code. It first stores the approver and nonce it reveals against; once revealed (a dropped
 * answer, a restart) it shows a code only for exactly those, since the server learned the secret
 * and could otherwise pick a new nonce to match a swapped key's code.
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
  const approver = approval.approver;
  if (approver === undefined) return { ok: false, code: 'mismatch' };
  const binding: RevealRecord = {
    approver_id: approver.id,
    approver_key: approver.public_key,
    nonce: approval.approver_nonce,
  };
  const key = REVEAL_KEY_PREFIX + approval.id;
  const stored = await loadRecord(deps.store, key, revealRecordSchema);
  if (stored === 'bad') return { ok: false, code: 'mismatch' };
  if (stored !== 'missing' && !sameBinding(stored, binding)) {
    deps.log?.('e2e_phone_approval_failed', { approval_id: approval.id, reason: 'rebound' });
    return { ok: false, code: 'mismatch' };
  }
  if (approval.reveal !== undefined)
    return approval.reveal === mine && stored !== 'missing'
      ? { ok: true }
      : { ok: false, code: 'mismatch' };
  if (stored === 'missing') await deps.store.setItemAsync(key, JSON.stringify(binding));
  const answer = await call(() => deps.api.reveal(approval.id, me.deviceId, mine));
  if (!answer.ok) return answer;
  const out = approvalFrom(answer.body);
  if (!out.ok) return out;
  if (out.approval.reveal !== mine || out.approval.approver_nonce !== approval.approver_nonce)
    return { ok: false, code: 'mismatch' };
  deps.log?.('e2e_phone_approval_revealed', { approval_id: approval.id });
  return { ok: true };
}

function sameBinding(a: RevealRecord, b: RevealRecord): boolean {
  return (
    a.approver_id === b.approver_id && a.approver_key === b.approver_key && a.nonce === b.nonce
  );
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
  // One trust change at a time (`withTrustLock`). The note never brings back a device this phone
  // removed, except the approver itself, whose code the person just checked.
  await withTrustLock(deps.store, async () => {
    const removed = await removedIds(deps.store);
    const current = await loadTrusted(deps.store);
    const added = learned.filter((l) => l.id === shown.id || !removed.includes(l.id));
    const merged = [...current.filter((d) => !added.some((l) => l.id === d.id)), ...added];
    await saveTrusted(deps.store, merged);
    await unremove(deps.store, shown.id);
  });
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
  // A nonce kept from before a restart is reused (the server takes only one), but only for the
  // exact request it was first sent for: the server knows it, so it must not pick a new key.
  const key = CLAIM_KEY_PREFIX + id;
  const kept = await loadRecord(deps.store, key, claimRecordSchema);
  if (kept === 'bad') return { ok: false, code: 'mismatch' };
  const record: ClaimRecord =
    kept === 'missing'
      ? {
          nonce: base64urlEncode(newApprovalSecret()),
          device_id: approval.device_id,
          public_key: approval.public_key,
          commitment: approval.commitment,
        }
      : kept;
  if (
    record.device_id !== approval.device_id ||
    record.public_key !== approval.public_key ||
    record.commitment !== approval.commitment
  ) {
    deps.log?.('e2e_phone_approval_failed', { approval_id: id, reason: 'rebound' });
    return { ok: false, code: 'mismatch' };
  }
  const nonce = record.nonce;
  if (approval.approver_nonce !== undefined)
    return approval.approver_nonce === nonce && kept !== 'missing'
      ? { ok: true, claimed: { approval, nonce } }
      : { ok: false, code: 'mismatch' };
  if (kept === 'missing') await deps.store.setItemAsync(key, JSON.stringify(record));
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
/** Waits before the accept goes again after a network failure (its answer may just be lost). */
const ACCEPT_RETRY_MS = [1_000, 3_000];
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Counts each time this phone's private keys are forgotten (sign-out, this phone removed). An
 * approve started before writes nothing after it: its answer can come seconds later.
 */
const forgets = new WeakMap<SecureKeyValue, number>();
/** Forgets still clearing the keys: an approve that starts meanwhile writes nothing either. */
const clearing = new WeakMap<SecureKeyValue, number>();
/** The approve writes running right now, which a forget lets finish before it clears the keys. */
const writing = new WeakMap<SecureKeyValue, Set<Promise<unknown>>>();

/** What an approve starting now holds on to: -1 (never kept) while the keys are being cleared. */
function epochNow(store: SecureKeyValue): number {
  return (clearing.get(store) ?? 0) > 0 ? -1 : (forgets.get(store) ?? 0);
}

/** Runs `work` while the keys an approve started with are kept; undefined once they were forgotten. */
function whileKept<T>(
  store: SecureKeyValue,
  epoch: number,
  work: () => Promise<T>,
): Promise<T> | undefined {
  if ((forgets.get(store) ?? 0) !== epoch) return undefined;
  const run = work();
  const runs = writing.get(store) ?? new Set<Promise<unknown>>();
  writing.set(store, runs);
  runs.add(run);
  void run.then(
    () => runs.delete(run),
    () => runs.delete(run),
  );
  return run;
}

/**
 * Clears this phone's private keys with `clear` so that no approve writes anything after: those
 * already running and those starting meanwhile write nothing more, and writes already under way
 * finish first. It never waits for the network.
 */
export async function clearAfterApproves(
  store: SecureKeyValue,
  clear: () => Promise<void>,
): Promise<void> {
  forgets.set(store, (forgets.get(store) ?? 0) + 1);
  clearing.set(store, (clearing.get(store) ?? 0) + 1);
  try {
    await Promise.all([...(writing.get(store) ?? [])].map((run) => run.catch(() => undefined)));
    await clear();
  } finally {
    clearing.set(store, (clearing.get(store) ?? 1) - 1);
  }
}

export async function approveWaiting(
  deps: {
    api: Pick<ApproveApi, 'accept'>;
    store: SecureKeyValue;
    now?: () => number;
    log?: Log;
    /** Tests replace the waits between tries. */
    wait?: (ms: number) => Promise<void>;
  },
  checked: CheckedApproval,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  // Only the approval that was claimed and whose reveal opened its commitment (`checkReveal`).
  const approval = checked.approval;
  const epoch = epochNow(deps.store);
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
  // The note, the accept and the save run as one trust change (`withTrustLock`), so a removal
  // at the same moment is neither vouched for in the note nor saved back.
  const done = await withTrustLock(
    deps.store,
    async (): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> => {
      const removed = await removedIds(deps.store);
      const trusted = (await loadTrusted(deps.store)).filter(
        (d) => d.id !== approval.device_id && !removed.includes(d.id),
      );
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
      // A network failure may be an answer lost after the server took the accept: the same note
      // again gets the same answer there, so it goes twice more before this phone gives up.
      let answer = await call(() => deps.api.accept(approval.id, me.deviceId, note));
      for (const ms of ACCEPT_RETRY_MS) {
        if (answer.ok || answer.code !== 'network') break;
        await (deps.wait ?? pause)(ms);
        answer = await call(() => deps.api.accept(approval.id, me.deviceId, note));
      }
      if (!answer.ok) {
        deps.log?.('e2e_phone_approval_failed', { approval_id: approval.id, reason: answer.code });
        return answer;
      }
      // Signed out, or this phone removed, while the answer was on its way: the keys it vouched
      // with are gone, so nothing of it is saved (`clearAfterApproves`).
      const saved = whileKept(deps.store, epoch, async () => {
        const current = (await loadTrusted(deps.store)).filter((d) => !removed.includes(d.id));
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
        await unremove(deps.store, approval.device_id);
      });
      if (saved === undefined) return { ok: false, code: 'closed' };
      await saved;
      return { ok: true };
    },
  );
  // A network failure may be an accept the server took, so it is kept to finish later; any other
  // end (done, or refused for good) leaves nothing to finish.
  if (!done.ok && done.code === 'network')
    await whileKept(deps.store, epoch, () =>
      deps.store.setItemAsync(PENDING_APPROVE_KEY_NAME, JSON.stringify(checked)),
    )?.catch(() => undefined);
  else await dropPending(deps.store, approval.id);
  if (!done.ok) return done;
  // Older private messages: this phone shares them next (`rewrap.ts`), now and on later opens.
  const queued = whileKept(deps.store, epoch, () =>
    queueRewrap(deps.store, { id: approval.device_id, public_key: approval.public_key }),
  );
  await queued?.catch(() => undefined);
  await forgetApprovalSecrets(deps.store, approval.id);
  if (queued === undefined) return { ok: false, code: 'closed' };
  deps.log?.('e2e_phone_approved', { approval_id: approval.id });
  return { ok: true };
}

/**
 * Clears the saved approve only when it is this approval's (or unreadable): finishing or turning
 * down one phone must not drop another approve still waiting to finish.
 */
async function dropPending(store: SecureKeyValue, id: string): Promise<void> {
  const saved = await loadRecord(store, PENDING_APPROVE_KEY_NAME, pendingApproveSchema).catch(
    () => 'missing' as const,
  );
  if (saved === 'missing') return;
  if (saved === 'bad' || saved.approval.id === id)
    await store.deleteItemAsync(PENDING_APPROVE_KEY_NAME).catch(() => undefined);
}

type ResumeDeps = {
  api: Pick<ApproveApi, 'accept'>;
  store: SecureKeyValue;
  now?: () => number;
  log?: Log;
  wait?: (ms: number) => Promise<void>;
};
/** 'waiting': still offline, kept for later; 'removed': dropped, the person removed that phone. */
export type ResumeResult = 'none' | 'done' | 'waiting' | 'ended' | 'removed';
const resuming = new WeakMap<SecureKeyValue, Promise<ResumeResult>>();

/**
 * Finishes an approve whose answer was lost, when Devices opens again: the person already checked
 * the codes and tapped Approve, and the server answers the same phone's repeat the same way. A
 * phone the person removed since is dropped instead. One run at a time per keychain.
 */
export function resumePendingApprove(deps: ResumeDeps): Promise<ResumeResult> {
  const current = resuming.get(deps.store);
  if (current !== undefined) return current;
  const work = resumeOnce(deps).finally(() => resuming.delete(deps.store));
  resuming.set(deps.store, work);
  return work;
}

/** Waits for a resume in flight, so an approve tapped meanwhile runs after it, not beside it. */
export async function settlePendingApprove(store: SecureKeyValue): Promise<void> {
  await resuming.get(store)?.catch(() => undefined);
}

async function resumeOnce(deps: ResumeDeps): Promise<ResumeResult> {
  const saved = await loadRecord(deps.store, PENDING_APPROVE_KEY_NAME, pendingApproveSchema);
  if (saved === 'missing') return 'none';
  const end = async (id: string) => {
    await dropPending(deps.store, id);
    await forgetApprovalSecrets(deps.store, id);
  };
  if (saved === 'bad') {
    await deps.store.deleteItemAsync(PENDING_APPROVE_KEY_NAME).catch(() => undefined);
    return 'none';
  }
  if ((await removedIds(deps.store)).includes(saved.approval.device_id)) {
    await end(saved.approval.id);
    return 'removed';
  }
  const out = await approveWaiting(deps, saved);
  if (out.ok) return 'done';
  if (out.code === 'network') return 'waiting';
  await end(saved.approval.id);
  return 'ended';
}

export async function denyWaiting(
  deps: { api: Pick<ApproveApi, 'deny'>; store: SecureKeyValue; log?: Log },
  id: string,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (me === undefined) return { ok: false, code: 'closed' };
  const answer = await call(() => deps.api.deny(id, me.deviceId));
  // A deny that never got through keeps the saved claim, so trying again carries on (a claim
  // whose nonce this phone no longer holds would be refused as a mismatch).
  if (answer.ok || ['closed', 'expired', 'mismatch'].includes(answer.code))
    await forgetApprovalSecrets(deps.store, id);
  if (answer.ok) deps.log?.('e2e_phone_approval_denied', { approval_id: id });
  return answer.ok ? { ok: true } : answer;
}
