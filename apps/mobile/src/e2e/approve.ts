import {
  base64urlDecode,
  base64urlEncode,
  connectorIdSchema,
  keyMatchesId,
  MAX_PAIRED_DEVICES,
  openTrustNote,
  phoneApprovalSchema,
  safetyCode,
  sealTrustNote,
  type PhoneApproval,
  type TrustNote,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import { loadDeviceKey, loadOrCreateDeviceKey, type DeviceKey } from './device-key';
import { loadTrusted, saveTrusted, type TrustedDevice } from './pairing';

/**
 * Approving a second phone from a phone that already has private chats (C3 #11, Task 27). The
 * new phone asks; a trusted phone takes the request and both show the same 6-digit code; when
 * the person says they match, the trusted phone seals a note naming the new phone, wrapped to the
 * new phone and to every device it trusts. The server only relays: a swapped key gives two
 * different codes. Logs carry ids and states only.
 */

export const APPROVE_PATH = 'Approve from my other phone';
export const APPROVE_ASK = 'On your other phone, open Devices and approve this phone.';
export const APPROVE_DONE = 'This phone can read new private messages.';
export const WAITING_TITLE = 'Waiting for approval';
export const APPROVE_BUTTON = 'Codes match, approve';
export const DENY_BUTTON = 'Deny';

export function approveCheckCopy(approverName: string, code: string): string {
  return `Check that ${approverName} shows ${code}.`;
}

export function approveSheetCopy(newPhoneName: string): string {
  return `Make sure ${newPhoneName} shows the same 6 digits.`;
}

/** The signed-in approval calls; the raw answers, checked here. */
export interface ApproveApi {
  request(body: {
    device_id: string;
    public_key: string;
    name: string;
  }): Promise<{ status: number; body: unknown }>;
  status(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
  list(deviceId: string): Promise<{ status: number; body: unknown }>;
  claim(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
  accept(id: string, deviceId: string, note: TrustNote): Promise<{ status: number; body: unknown }>;
  deny(id: string, deviceId: string): Promise<{ status: number; body: unknown }>;
}

type Log = (event: string, fields?: Record<string, string | number>) => void;

export type ApproveFailure =
  'already_added' | 'cap' | 'busy' | 'expired' | 'closed' | 'mismatch' | 'network';

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
  const answer = await call(() =>
    deps.api.request({
      device_id: me.deviceId,
      public_key: base64urlEncode(me.publicKey),
      name: deps.phoneName,
    }),
  );
  if (!answer.ok) {
    deps.log?.('e2e_phone_approval_failed', { reason: answer.code });
    return answer;
  }
  const out = approvalFrom(answer.body);
  if (out.ok) deps.log?.('e2e_phone_approval_requested', { approval_id: out.approval.id });
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
  code: string;
}

/** The code the new phone shows for this claim, or undefined when the claim is not usable. */
export function shownApprover(approval: PhoneApproval, me: DeviceKey): ShownApprover | undefined {
  const approver = approval.approver;
  if (approver === undefined || !keyMatchesId(approver) || approver.id === me.deviceId)
    return undefined;
  return {
    ...approver,
    code: safetyCode(me.publicKey, base64urlDecode(approver.public_key)),
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

export type ClaimedApproval = { approval: PhoneApproval; code: string };

/** Takes a waiting phone; the code is the one both screens show. */
export async function claimWaiting(
  deps: { api: Pick<ApproveApi, 'claim'>; store: SecureKeyValue; log?: Log },
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
  deps.log?.('e2e_phone_approval_claimed', { approval_id: id });
  return {
    ok: true,
    claimed: {
      approval,
      code: safetyCode(me.publicKey, base64urlDecode(approval.public_key)),
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
  approval: PhoneApproval,
): Promise<{ ok: true } | { ok: false; code: ApproveFailure }> {
  const me = await loadDeviceKey(deps.store);
  if (
    me === undefined ||
    !keyMatchesId({ id: approval.device_id, public_key: approval.public_key })
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
  if (answer.ok) deps.log?.('e2e_phone_approval_denied', { approval_id: id });
  return answer.ok ? { ok: true } : answer;
}
