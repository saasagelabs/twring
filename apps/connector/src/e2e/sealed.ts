import {
  base64urlDecode,
  MAX_PAIRED_DEVICES,
  messageAad,
  newMessageKey,
  openBody,
  openControl,
  ReplayWindow,
  sealBody,
  sealControl,
  SEALED_FORMAT_VERSION,
  unwrapKey,
  wrapKey,
  type SealedControlPayload,
  type SealedEnvelopeV1,
  type SealedPayload,
} from '@twring/contracts';

import type { TrustedDevice } from './keys';

/** Shared with the phone (contracts); re-exported for this package's callers. */
export { ReplayWindow };

/**
 * Opening and sealing private chat messages on this computer (ADR-044).
 *
 * The AAD binds `accountId` and `agentId`. Both ends must know them without asking the server, so
 * (ruling R5, P2) `accountId` is this computer's connector id and `agentId` its local agent id:
 * the phone reads both from the agent's `cord-connector://<connector id>/<local agent>` address.
 */
export interface SealContext {
  accountId: string;
  agentId: string;
  myDeviceId: string;
  /** base64url; this computer wraps every message to itself too. */
  myPublic: string;
  myPrivate: Uint8Array;
  /** Devices this computer verified itself. Never a device only the server listed. */
  trusted: TrustedDevice[];
  seen: ReplayWindow;
}

export type OpenFailure = {
  ok: false;
  reason: 'not_for_me' | 'unknown_sender' | 'replay' | 'bad_ciphertext';
};
export type OpenResult = { ok: true; payload: SealedPayload } | OpenFailure;
/** A sealed approval decision (C3 #11); `sender` is the trusted device that sealed it. */
export type OpenControlResult =
  { ok: true; payload: SealedControlPayload; sender: TrustedDevice } | OpenFailure;

function aadFor(ctx: SealContext, sender: string, seq: number, chunk?: number): Uint8Array {
  return messageAad({
    accountId: ctx.accountId,
    agentId: ctx.agentId,
    senderDevice: sender,
    senderSeq: seq,
    ...(chunk !== undefined && { chunk }),
  });
}

/**
 * Opens a message sealed by a verified device. The sender's key comes from this computer's own
 * list, never from the server; the replay window moves only after a message opened, so a forgery
 * cannot use up a real message's seq.
 */
export function openIncoming(ctx: SealContext, envelope: SealedEnvelopeV1): OpenResult {
  const opened = openWith(ctx, envelope, openBody);
  return opened.ok ? { ok: true, payload: opened.payload } : opened;
}

/** As `openIncoming`, for a sealed approval decision; a chat message never opens here. */
export function openIncomingControl(
  ctx: SealContext,
  envelope: SealedEnvelopeV1,
): OpenControlResult {
  return openWith(ctx, envelope, openControl);
}

function openWith<T>(
  ctx: SealContext,
  envelope: SealedEnvelopeV1,
  open: (key: Uint8Array, nonce: string, body: string, aad: Uint8Array) => T,
): { ok: true; payload: T; sender: TrustedDevice } | OpenFailure {
  const mine = envelope.keys.find((key) => key.device === ctx.myDeviceId);
  if (mine === undefined) return { ok: false, reason: 'not_for_me' };
  const sender = ctx.trusted.find((device) => device.id === envelope.sender_device);
  if (sender === undefined) return { ok: false, reason: 'unknown_sender' };
  if (!ctx.seen.fresh(envelope.sender_device, envelope.sender_seq))
    return { ok: false, reason: 'replay' };
  const aad = aadFor(ctx, envelope.sender_device, envelope.sender_seq, envelope.chunk?.index);
  let payload: T;
  try {
    const key = unwrapKey(mine.wrapped, ctx.myPrivate, base64urlDecode(sender.public_key), aad);
    payload = open(key, envelope.nonce, envelope.body, aad);
  } catch {
    return { ok: false, reason: 'bad_ciphertext' };
  }
  ctx.seen.accept(envelope.sender_device, envelope.sender_seq);
  return { ok: true, payload, sender };
}

/** Seals under a fresh message key wrapped to this computer and every device it trusts. */
export function sealOutgoing(
  ctx: SealContext,
  payload: SealedPayload,
  seq: number,
  chunk?: { index: number; final: boolean },
): SealedEnvelopeV1 {
  return sealWith(ctx, seq, chunk, (key, aad) => sealBody(key, payload, aad));
}

/** As `sealOutgoing`, for a sealed approval request (C3 #11); never chunked. */
export function sealOutgoingControl(
  ctx: SealContext,
  payload: SealedControlPayload,
  seq: number,
): SealedEnvelopeV1 {
  return sealWith(ctx, seq, undefined, (key, aad) => sealControl(key, payload, aad));
}

function sealWith(
  ctx: SealContext,
  seq: number,
  chunk: { index: number; final: boolean } | undefined,
  seal: (key: Uint8Array, aad: Uint8Array) => { nonce: string; body: string },
): SealedEnvelopeV1 {
  const key = newMessageKey();
  const aad = aadFor(ctx, ctx.myDeviceId, seq, chunk?.index);
  const recipients = [
    { id: ctx.myDeviceId, public_key: ctx.myPublic },
    ...ctx.trusted.filter((device) => device.id !== ctx.myDeviceId),
  ].slice(0, MAX_PAIRED_DEVICES);
  const { nonce, body } = seal(key, aad);
  return {
    v: SEALED_FORMAT_VERSION,
    sender_device: ctx.myDeviceId,
    sender_seq: seq,
    nonce,
    body,
    keys: recipients.map((device) => ({
      device: device.id,
      wrapped: wrapKey(key, ctx.myPrivate, base64urlDecode(device.public_key), aad),
    })),
    ...(chunk !== undefined && { chunk }),
  };
}
