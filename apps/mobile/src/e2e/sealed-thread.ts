import {
  base64urlDecode,
  base64urlEncode,
  MAX_PAIRED_DEVICES,
  MAX_USER_MESSAGE_CHARS,
  messageAad,
  newMessageKey,
  openBody,
  openControl,
  parseConnectorEndpoint,
  ReplayWindow,
  sealBody,
  sealControl,
  SEALED_FORMAT_VERSION,
  unwrapKey,
  wrapKey,
  type SealedControlPayload,
  type SealedEnvelopeV1,
  type SealedPayload,
  type ThreadMessage,
} from '@twring/contracts';

import type { DeviceKey } from './device-key';
import type { TrustedDevice } from './pairing';

/**
 * Sealing and opening private chat messages on the phone (ADR-044), the mirror of the computer's
 * apps/connector/src/e2e/sealed.ts. A sender's key always comes from this phone's own verified
 * list, never from the server. Pure: no logging here, so no text or key can reach a log.
 */

export type SealedThreadMessage = Extract<ThreadMessage, { kind: 'sealed' }>;

export type OpenedMessage =
  | {
      id: string;
      author: 'user' | 'agent';
      state: 'ok';
      text: string;
      quote?: SealedPayload['quote'];
      files?: SealedPayload['files'];
      /** The computer could not open the message this answers. */
      notice?: 'couldnt_open';
      /** A streamed reply whose final chunk has not arrived yet. */
      partial?: true;
    }
  | {
      /** A sealed approval request from the computer (C3 #11), opened on this phone only. */
      id: string;
      author: 'agent';
      state: 'approval';
      approvalId: string;
      title: string;
      description?: string;
      expiresAt: string;
    }
  | { id: string; author: 'user' | 'agent'; state: 'couldnt_open' }
  | { id: string; state: 'missing_before'; missing: number };

export class TooLongError extends Error {
  constructor() {
    super(`A private message holds at most ${MAX_USER_MESSAGE_CHARS} characters.`);
    this.name = 'TooLongError';
  }
}

export interface PhoneSealOptions {
  /** The connector id (`con_...`) from the agent's address (`aadIdsFor`). */
  accountId: string;
  /** The computer's local agent id from the agent's address. */
  agentId: string;
  me: DeviceKey;
  /** Devices this phone verified at pairing. */
  trusted: TrustedDevice[];
  /** The next seq, saved before it is handed out (`device-key.ts` `nextSeq`). */
  nextSeq: () => number;
  /** Replay state saved before a restart (`seenToSave`). */
  seen?: SavedReplay;
}

/** At most this many (sender, seq) to message id entries are saved per thread: one per message. */
export const MAX_SAVED_IDS = 2000;

/**
 * What a thread saves so a restart neither reopens replays nor drops its own history (P3b ruling
 * 1): the highest seq per sender, and the message id that first opened each (sender, seq). At or
 * under the floor, a (sender, seq) opens only under its saved id.
 */
export interface SavedReplay {
  floor: Record<string, number>;
  /** `<sender>:<seq>` to message id. */
  ids: Record<string, string>;
}

export interface PhoneSealContext extends PhoneSealOptions {
  window: ReplayWindow;
  /** Replay key (sender, seq, chunk) to the message id that first opened it. */
  owners: Map<string, string>;
  /** Highest seq shown per other sender, to mark gaps. */
  shown: Map<string, number>;
  /** `<sender>:<seq>` to message id, saved before a restart. */
  savedIds: Map<string, string>;
}

export function createPhoneContext(options: PhoneSealOptions): PhoneSealContext {
  return {
    accountId: options.accountId,
    agentId: options.agentId,
    me: options.me,
    trusted: options.trusted,
    nextSeq: options.nextSeq,
    window: new ReplayWindow(options.seen?.floor ?? {}),
    owners: new Map(),
    shown: new Map(Object.entries(options.seen?.floor ?? {})),
    savedIds: new Map(Object.entries(options.seen?.ids ?? {})),
  };
}

/** The AAD ids from a computer agent's `cord-connector://<connector id>/<local agent>` address. */
export function aadIdsFor(address: string): { accountId: string; agentId: string } | undefined {
  const endpoint = parseConnectorEndpoint(address);
  return endpoint && { accountId: endpoint.connectorId, agentId: endpoint.localAgent };
}

function aadFor(ctx: PhoneSealContext, sender: string, seq: number, chunk?: number): Uint8Array {
  return messageAad({
    accountId: ctx.accountId,
    agentId: ctx.agentId,
    senderDevice: sender,
    senderSeq: seq,
    ...(chunk !== undefined && { chunk }),
  });
}

function senderKey(ctx: PhoneSealContext, device: string): Uint8Array | undefined {
  if (device === ctx.me.deviceId) return ctx.me.publicKey;
  const found = ctx.trusted.find((d) => d.id === device);
  return found && base64urlDecode(found.public_key);
}

const replayKey = (sender: string, seq: number, chunk?: number) =>
  `${sender}:${seq}:${chunk ?? '-'}`;

type Opened =
  | { ok: true; payload: SealedPayload; partial: boolean; sender: string; seq: number }
  | {
      ok: true;
      approval: Extract<SealedControlPayload, { kind: 'approval' }>;
      sender: string;
      seq: number;
    }
  | { ok: false; replay: boolean };

/**
 * All chunks of one message: one sender, one seq, indexes 0..n-1 with at most the last final.
 * Replays are checked per (sender, seq, chunk); a chunk this same message opened before is not one.
 */
function openAll(ctx: PhoneSealContext, m: SealedThreadMessage): Opened {
  const envelopes = [...m.sealed].sort((a, b) => (a.chunk?.index ?? 0) - (b.chunk?.index ?? 0));
  const first = envelopes[0];
  const sender = first.sender_device;
  const seq = first.sender_seq;
  const chunked = first.chunk !== undefined;
  for (const [i, e] of envelopes.entries()) {
    if (e.sender_device !== sender || e.sender_seq !== seq) return { ok: false, replay: false };
    if (chunked !== (e.chunk !== undefined)) return { ok: false, replay: false };
    if (chunked && e.chunk!.index !== i) return { ok: false, replay: false };
    if (e.chunk?.final === true && i !== envelopes.length - 1) return { ok: false, replay: false };
  }
  if (!chunked && envelopes.length !== 1) return { ok: false, replay: false };
  const theirKey = senderKey(ctx, sender);
  if (theirKey === undefined) return { ok: false, replay: false };
  const saved = ctx.savedIds.get(`${sender}:${seq}`);
  for (const e of envelopes) {
    const owner = ctx.owners.get(replayKey(sender, seq, e.chunk?.index)) ?? saved;
    if (owner !== undefined ? owner !== m.id : !ctx.window.fresh(sender, seq, e.chunk?.index))
      return { ok: false, replay: true };
  }
  const payloads: SealedPayload[] = [];
  let control: SealedControlPayload | undefined;
  for (const e of envelopes) {
    const mine = e.keys.find((k) => k.device === ctx.me.deviceId);
    if (mine === undefined) return { ok: false, replay: false };
    const aad = aadFor(ctx, sender, seq, e.chunk?.index);
    let key: Uint8Array;
    try {
      key = unwrapKey(mine.wrapped, ctx.me.privateKey, theirKey, aad);
    } catch {
      return { ok: false, replay: false };
    }
    try {
      payloads.push(openBody(key, e.nonce, e.body, aad));
    } catch {
      // Only a single sealed agent message from another device may be an approval (C3 #11).
      if (chunked || m.author !== 'agent' || sender === ctx.me.deviceId)
        return { ok: false, replay: false };
      try {
        control = openControl(key, e.nonce, e.body, aad);
      } catch {
        return { ok: false, replay: false };
      }
    }
  }
  if (control !== undefined && control.kind !== 'approval') return { ok: false, replay: false };
  // Only now does the window move: a forgery cannot use up a real message's seq.
  for (const e of envelopes) {
    const key = replayKey(sender, seq, e.chunk?.index);
    if (!ctx.owners.has(key)) {
      ctx.window.accept(sender, seq, e.chunk?.index);
      ctx.owners.set(key, m.id);
    }
  }
  if (control !== undefined) return { ok: true, approval: control, sender, seq };
  const head = payloads[0];
  const notice = payloads.find((p) => p.notice !== undefined)?.notice;
  return {
    ok: true,
    sender,
    seq,
    partial: chunked && envelopes[envelopes.length - 1].chunk!.final !== true,
    payload: {
      ...head,
      text: payloads.map((p) => p.text).join(''),
      ...(notice !== undefined && { notice }),
    },
  };
}

/** Opens one message; `undefined` for a replay, which is dropped without a trace. */
function openOne(ctx: PhoneSealContext, m: SealedThreadMessage): OpenedMessage[] | undefined {
  const opened = openAll(ctx, m);
  if (!opened.ok) {
    if (opened.replay) return undefined;
    return [{ id: m.id, author: m.author, state: 'couldnt_open' }];
  }
  const out: OpenedMessage[] = [];
  if (opened.sender !== ctx.me.deviceId) {
    const last = ctx.shown.get(opened.sender);
    if (last !== undefined && opened.seq > last + 1)
      out.push({ id: `${m.id}:gap`, state: 'missing_before', missing: opened.seq - last - 1 });
    if (last === undefined || opened.seq > last) ctx.shown.set(opened.sender, opened.seq);
  }
  if ('approval' in opened) {
    const { approval } = opened;
    out.push({
      id: m.id,
      author: 'agent',
      state: 'approval',
      approvalId: approval.approval_id,
      title: approval.title,
      ...(approval.description !== undefined && { description: approval.description }),
      expiresAt: approval.expires_at,
    });
    return out;
  }
  const { payload } = opened;
  out.push({
    id: m.id,
    author: m.author,
    state: 'ok',
    text: payload.text,
    ...(payload.quote !== undefined && { quote: payload.quote }),
    ...(payload.files !== undefined && { files: payload.files }),
    ...(payload.notice !== undefined && { notice: payload.notice }),
    ...(opened.partial && { partial: true as const }),
  });
  return out;
}

/** One message as shown. A replay shows as `couldnt_open` here; lists use `openMessages`. */
export function openMessage(ctx: PhoneSealContext, m: SealedThreadMessage): OpenedMessage {
  const out = openOne(ctx, m);
  if (out === undefined) return { id: m.id, author: m.author, state: 'couldnt_open' };
  return out[out.length - 1];
}

/** A thread's sealed messages in order: replays dropped, seq gaps marked before the message. */
export function openMessages(ctx: PhoneSealContext, list: SealedThreadMessage[]): OpenedMessage[] {
  return list.flatMap((m) => openOne(ctx, m) ?? []);
}

/** Seals under a fresh key wrapped to this phone and every computer it trusts. */
export function sealOutgoing(ctx: PhoneSealContext, payload: SealedPayload): SealedEnvelopeV1 {
  // Checked before a seq is used, so a refused message burns nothing.
  if (payload.text.length > MAX_USER_MESSAGE_CHARS) throw new TooLongError();
  const seq = ctx.nextSeq();
  const key = newMessageKey();
  const aad = aadFor(ctx, ctx.me.deviceId, seq);
  const recipients = [
    { id: ctx.me.deviceId, public_key: base64urlEncode(ctx.me.publicKey) },
    ...ctx.trusted.filter((d) => d.id !== ctx.me.deviceId),
  ].slice(0, MAX_PAIRED_DEVICES);
  const { nonce, body } = sealBody(key, payload, aad);
  return {
    v: SEALED_FORMAT_VERSION,
    sender_device: ctx.me.deviceId,
    sender_seq: seq,
    nonce,
    body,
    keys: recipients.map((d) => ({
      device: d.id,
      wrapped: wrapKey(key, ctx.me.privateKey, base64urlDecode(d.public_key), aad),
    })),
  };
}

/** Seals an approval answer (C3 #11) to this phone and every computer it trusts, next seq. */
export function sealOutgoingControl(
  ctx: PhoneSealContext,
  payload: SealedControlPayload,
): SealedEnvelopeV1 {
  const seq = ctx.nextSeq();
  const key = newMessageKey();
  const aad = aadFor(ctx, ctx.me.deviceId, seq);
  const recipients = [
    { id: ctx.me.deviceId, public_key: base64urlEncode(ctx.me.publicKey) },
    ...ctx.trusted.filter((d) => d.id !== ctx.me.deviceId),
  ].slice(0, MAX_PAIRED_DEVICES);
  const { nonce, body } = sealControl(key, payload, aad);
  return {
    v: SEALED_FORMAT_VERSION,
    sender_device: ctx.me.deviceId,
    sender_seq: seq,
    nonce,
    body,
    keys: recipients.map((d) => ({
      device: d.id,
      wrapped: wrapKey(key, ctx.me.privateKey, base64urlDecode(d.public_key), aad),
    })),
  };
}

/** The replay state to save, so a restart neither reopens replays nor drops the history. */
export function seenToSave(ctx: PhoneSealContext): SavedReplay {
  const ids = new Map(ctx.savedIds);
  for (const [key, id] of ctx.owners) {
    const k = key.slice(0, key.lastIndexOf(':'));
    // Re-inserted so the newest stay when the list is cut.
    ids.delete(k);
    ids.set(k, id);
  }
  return {
    floor: ctx.window.highest(),
    ids: Object.fromEntries([...ids].slice(-MAX_SAVED_IDS)),
  };
}
