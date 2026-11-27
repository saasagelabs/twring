import {
  base64urlEncode,
  fileAad,
  MAX_FILE_BYTES,
  MAX_USER_MESSAGE_CHARS,
  newFileKey,
  sealFile,
  type SealedEnvelopeV1,
  type SealedPayload,
  type ThreadMessage,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import type { JsonStore } from '../threads/outbox-storage';
import { clearAfterApproves, PENDING_APPROVE_KEY_NAME } from './approve';
import { forgetDeviceKey, loadOrCreateDeviceKey, nextSeq } from './device-key';
import { forgetTrusted, loadTrusted, type TrustedDevice } from './pairing';
import {
  aadIdsFor,
  createPhoneContext,
  openMessage,
  openMessages,
  openMessagesInSteps,
  sealOutgoing,
  sealOutgoingControl,
  seenToSave,
  type OpenedMessage,
  type PhoneSealContext,
  type SavedReplay,
  type SealedThreadMessage,
} from './sealed-thread';
import type { PhoneQuote } from './private-quote';
import {
  hasComputerFor,
  listDevices,
  LOST_KEYS,
  NEW_PHONE,
  reinstalledFor,
  REINSTALLED,
  removedPhone,
  REMOVED_PHONE,
  syncTrusted,
} from './devices';
import { PAIR_AGAIN } from './private-state';
import { readRewraps, REWRAP_JOBS_KEY, type RewrapApi } from './rewrap';
import { VOICE_CONSENT_KEY } from './voice-consent';
import { forgetListPreviews } from './list-previews';

/**
 * Private chats in the chat data layer (ADR-044): seals what the phone sends and opens what it
 * shows. Opened text lives in memory only; what reaches the phone's disk is the sealed envelope
 * and the replay state (device ids, seqs and message ids), never text. Logs carry counts and
 * ids only.
 */

/** Why a message could not be sealed; it then stays in the outbox as failed, never sent as text. */
export type SealFailure =
  | 'pair_again'
  | 'not_computer'
  | 'too_long'
  | 'seal_failed'
  | 'file_too_large'
  | 'unsupported_file_type';
export class SealError extends Error {
  constructor(readonly code: SealFailure) {
    super(code);
    this.name = 'SealError';
  }
}

export interface PrivateChatDeps {
  /** The keychain store for the device key and its counter (`deviceOnlyStore`). */
  store: SecureKeyValue;
  /** Replay state per chat, on disk: no text, no keys. */
  replay: JsonStore;
  /** The agent's address (`cord-connector://<connector>/<agent>`), for the AAD ids. */
  addressOf(agentId: string): Promise<string | undefined>;
  /**
   * The account's device list (`GET /v1/e2e/devices`), read when a chat opens: revoked devices
   * leave the trusted list and a reinstalled computer is noticed (C3 #11 P4a). None: not read.
   */
  devices?: () => Promise<unknown>;
  /**
   * Keys another phone wrapped again for this one (C3 #11 Task 28), read when a chat has a
   * message with no key for this phone. None: older messages stay unopened.
   */
  rewraps?: Pick<RewrapApi, 'read'>;
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

const savedSchema = z.record(
  z.string().max(100),
  z.object({
    floor: z.record(z.string().max(64), z.number().int().nonnegative()),
    ids: z.record(z.string().max(100), z.string().max(64)),
  }),
);

/** A chat's re-wraps are read again at most this often while the app runs. */
export const REWRAP_ASK_MS = 5 * 60_000;
/** How often one chat may read the device list to learn whether this phone was removed. */
export const REMOVED_CHECK_MS = 30_000;
/** A sender lookup stops holding a chat on loading after this; a stalled read then shows what is known. */
export const SENDER_LOOKUP_MS = 10_000;

export class PrivateChats {
  private readonly contexts = new Map<string, PhoneSealContext>();
  private readonly loading = new Map<string, Promise<PhoneSealContext | undefined>>();
  private saved?: Promise<Record<string, SavedReplay>>;
  private trusted: TrustedDevice[] = [];
  /** Chats whose computer the server lists with a key this phone does not trust. */
  private readonly reinstalled = new Set<string>();
  /** Chats with sealed messages none of which this phone's key can open (a reinstalled app). */
  private readonly lostKeys = new Set<string>();
  /** Another phone removed this one: its keys are forgotten and nothing is sealed. */
  private removedSelf = false;
  /** The removed phone's device id (public), to tell which replies it could still have read. */
  private removedDevice: string | undefined;
  /** When the server revoked this phone (its own `revoked_at`); undefined if it did not say. */
  private removedAt: string | undefined;
  /** Bumped by `reset` and `forget`: a load started before one never keeps what it read. */
  private generation = 0;
  /** This phone's saved list held a computer before the server's list was applied. */
  private hadComputer = false;
  /**
   * The server's last list named this phone as an active device (it was paired, approved or
   * restored): never a new phone. Undefined until a list was read.
   */
  private known: boolean | undefined;
  private saving: Promise<void> = Promise.resolve();
  /** When each chat's re-wraps were last asked for, and the read still running. */
  private readonly rewrapAsked = new Map<string, number>();
  private readonly rewrapLoading = new Map<string, Promise<void>>();
  private readonly removedListeners = new Set<() => void>();
  /** When each chat last read the device list to learn whether this phone was removed. */
  private readonly removedChecked = new Map<string, number>();
  /** Per chat: when each sender device it did not know was last looked up, and the read running. */
  private readonly senderAsked = new Map<string, Map<string, number>>();
  private readonly senderLoading = new Map<string, Promise<void>>();

  constructor(private readonly deps: PrivateChatDeps) {}

  /** No computer to send to for this chat: the key was replaced, or pairing was lost. */
  pairAgain(agentId: string): boolean {
    const ctx = this.contexts.get(agentId);
    return ctx === undefined || !hasComputerFor(this.trusted, ctx.accountId);
  }

  /** What a private chat says above the composer, if anything: most specific first. */
  notice(agentId: string): string | undefined {
    // Removal clears every context: the notice must not wait for one.
    if (this.removedSelf) return REMOVED_PHONE;
    if (this.contexts.get(agentId) === undefined) return undefined;
    if (this.reinstalled.has(agentId)) return REINSTALLED;
    if (this.lostKeys.has(agentId) && this.pairAgain(agentId)) return LOST_KEYS;
    // No computer trusted, then or now, and the server does not know this phone: a new or wiped
    // phone, to set up rather than pair "again". A phone the server knows lost only its computer.
    if (
      this.known !== true &&
      !this.hadComputer &&
      !this.trusted.some((d) => d.kind === 'computer')
    )
      return NEW_PHONE;
    return this.pairAgain(agentId) ? PAIR_AGAIN : undefined;
  }

  /** The server's list: drops revoked devices here, and notes a reinstalled computer. */
  private async readDevices(
    agentId: string,
    connectorId: string,
    me: { deviceId: string; privateKey: Uint8Array },
    stale: () => boolean = () => false,
  ): Promise<void> {
    if (this.deps.devices === undefined) return;
    try {
      const server = await listDevices({ list: this.deps.devices });
      // A reset came while the list was read: it may hold a new key, never act on the old one.
      if (stale()) return;
      const before = this.trusted;
      if (removedPhone(server, before, me.deviceId)) {
        const revokedAt = server.find((d) => d.id === me.deviceId)?.revoked_at;
        await this.forgetRemoved(me.deviceId, revokedAt);
        return;
      }
      this.known = server.some(
        (d) => d.id === me.deviceId && d.kind === 'phone' && d.revoked_at === undefined,
      );
      this.trusted = await syncTrusted(this.deps.store, server, this.deps.log, me);
      if (reinstalledFor(server, this.trusted, connectorId, before)) this.reinstalled.add(agentId);
      else this.reinstalled.delete(agentId);
    } catch {
      // Offline or a bad answer: nothing changes.
    }
  }

  /** Another phone removed this one; true until Set up resets the chats. */
  removed(): boolean {
    return this.removedSelf;
  }

  /** When the server removed this phone, if it said; undefined until then or after Set up. */
  removedSince(): string | undefined {
    return this.removedSelf ? this.removedAt : undefined;
  }

  /** Once removed: whether a sealed message was still sealed to this phone before removal. */
  sealedToRemoved(message: SealedThreadMessage): boolean {
    const id = this.removedDevice;
    return id !== undefined && message.sealed.some((e) => e.keys.some((k) => k.device === id));
  }

  /**
   * Reads the device list again to learn whether another phone removed this one: a reply with no
   * key for this phone, a failed send, or the chat coming back into view. At most once per chat in
   * `REMOVED_CHECK_MS`; a reset meanwhile drops the answer.
   */
  async checkRemoved(agentId: string): Promise<void> {
    if (this.removedSelf) return;
    const ctx = this.contexts.get(agentId);
    if (ctx === undefined) return;
    const now = Date.now();
    const checked = this.removedChecked.get(agentId);
    if (checked !== undefined && now - checked < REMOVED_CHECK_MS) return;
    this.removedChecked.set(agentId, now);
    const generation = this.generation;
    await this.readDevices(agentId, ctx.accountId, ctx.me, () => generation !== this.generation);
  }

  /** Called once this phone learns another phone removed it (R3-4): the chats drop opened text. */
  onRemoved(listener: () => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  /**
   * This phone was removed by another: the same wipe as Remove this phone (key, trusted list,
   * replay state and re-wrap jobs), then the chats are told so they drop opened files and text.
   * It can only come back through a fresh approval as a new device.
   */
  private async forgetRemoved(deviceId: string, revokedAt: string | undefined): Promise<void> {
    this.deps.log?.('e2e_phone_removed');
    this.removedSelf = true;
    this.removedDevice = deviceId;
    this.removedAt = revokedAt;
    this.known = false;
    this.trusted = [];
    this.contexts.clear();
    this.reinstalled.clear();
    this.lostKeys.clear();
    this.rewrapAsked.clear();
    await this.wipeStored();
    for (const listener of this.removedListeners) listener();
  }

  /** The replay state and the keychain's private chat keys, for both forget paths. */
  private async wipeStored(): Promise<void> {
    this.saved = Promise.resolve({});
    await this.saving;
    await Promise.all([
      this.deps.replay.remove().catch(() => undefined),
      forgetPrivateDevice(this.deps.store),
    ]);
  }

  /**
   * Drops every loaded chat context, so the next open reads the key and trusted list again: after
   * a restore, a pairing or an approval the chat opens with them at once.
   */
  reset(): void {
    this.generation++;
    this.loading.clear();
    this.contexts.clear();
    this.reinstalled.clear();
    this.lostKeys.clear();
    this.rewrapAsked.clear();
    this.removedChecked.clear();
    this.senderAsked.clear();
    this.removedSelf = false;
    this.removedDevice = undefined;
    this.removedAt = undefined;
    this.known = undefined;
  }

  private loadSaved(): Promise<Record<string, SavedReplay>> {
    this.saved ??= this.deps.replay
      .load()
      .then((raw) => {
        const parsed = savedSchema.safeParse(raw);
        return parsed.success ? parsed.data : {};
      })
      .catch(() => ({}));
    return this.saved;
  }

  /** The chat's context, loaded once: key, trusted computers, address and saved replay state. */
  context(agentId: string): Promise<PhoneSealContext | undefined> {
    const ready = this.contexts.get(agentId);
    // A re-wrap or sender read under way: the chat is drawn again once it is in.
    if (ready)
      return Promise.all([this.rewrapLoading.get(agentId), this.senderLoading.get(agentId)]).then(
        () => ready,
      );
    // Removed: no new key is made until Set up resets the chats.
    if (this.removedSelf) return Promise.resolve(undefined);
    let work = this.loading.get(agentId);
    if (!work) {
      const generation = this.generation;
      const stale = () => generation !== this.generation;
      work = (async () => {
        const [me, trusted, address, saved] = await Promise.all([
          loadOrCreateDeviceKey(this.deps.store, this.deps.log),
          loadTrusted(this.deps.store),
          this.deps.addressOf(agentId),
          this.loadSaved(),
        ]);
        if (stale()) return undefined;
        this.trusted = trusted;
        this.hadComputer = trusted.some((d) => d.kind === 'computer');
        const ids = address === undefined ? undefined : aadIdsFor(address);
        if (ids === undefined) return undefined;
        await this.readDevices(agentId, ids.accountId, me, stale);
        if (stale()) return undefined;
        const ctx = createPhoneContext({
          ...ids,
          me,
          trusted: this.trusted,
          // Every seal takes its seq from the keychain counter first (`seal`).
          nextSeq: () => {
            throw new SealError('seal_failed');
          },
          ...(saved[agentId] !== undefined && { seen: saved[agentId] }),
        });
        this.contexts.set(agentId, ctx);
        return ctx;
      })()
        .catch(() => undefined)
        .finally(() => {
          if (this.loading.get(agentId) === work) this.loading.delete(agentId);
        });
      this.loading.set(agentId, work);
    }
    return work;
  }

  /** The chat's context only if already loaded (for drawing). */
  ready(agentId: string): PhoneSealContext | undefined {
    return this.contexts.get(agentId);
  }

  /**
   * Seals one message. The seq comes from the keychain counter and is saved there before the
   * post goes out (P3b ruling 2): a failed send uses a seq, never reuses one.
   */
  async seal(
    agentId: string,
    text: string,
    quote?: PhoneQuote,
    files?: SealedPayload['files'],
  ): Promise<SealedEnvelopeV1> {
    if (text.length > MAX_USER_MESSAGE_CHARS) throw new SealError('too_long');
    if (this.removedSelf) throw new SealError('pair_again');
    let ctx: PhoneSealContext | undefined;
    try {
      ctx = await this.context(agentId);
    } catch {
      throw new SealError('seal_failed');
    }
    if (ctx === undefined) throw new SealError('not_computer');
    // Read again: a pairing done since this chat opened counts at once.
    const trusted = await loadTrusted(this.deps.store).catch(() => ctx.trusted);
    this.trusted = trusted;
    ctx.trusted = trusted;
    if (
      this.removedSelf ||
      this.reinstalled.has(agentId) ||
      !hasComputerFor(trusted, ctx.accountId)
    )
      throw new SealError('pair_again');
    let seq: number;
    try {
      seq = await nextSeq(this.deps.store);
    } catch {
      throw new SealError('seal_failed');
    }
    try {
      return sealOutgoing(
        { ...ctx, nextSeq: () => seq },
        {
          text,
          ...(quote !== undefined && { quote }),
          ...(files !== undefined && files.length > 0 && { files }),
        },
      );
    } catch {
      throw new SealError('seal_failed');
    }
  }

  /**
   * Seals one file's bytes with a fresh key before upload (ADR-045). The key goes into the
   * message's payload, never to the server. A 0-byte or over-limit file is refused first.
   */
  async sealFileBytes(
    agentId: string,
    bytes: Uint8Array,
  ): Promise<{ blob: Uint8Array; key: string }> {
    if (bytes.length < 1) throw new SealError('unsupported_file_type');
    if (bytes.length > MAX_FILE_BYTES) throw new SealError('file_too_large');
    let ids: { accountId: string; agentId: string } | undefined;
    try {
      const address = await this.deps.addressOf(agentId);
      ids = address === undefined ? undefined : aadIdsFor(address);
    } catch {
      throw new SealError('seal_failed');
    }
    if (ids === undefined) throw new SealError('seal_failed');
    try {
      const key = newFileKey();
      return { blob: sealFile(key, bytes, fileAad(ids)), key: base64urlEncode(key) };
    } catch {
      throw new SealError('seal_failed');
    }
  }

  /**
   * Seals the answer to a sealed approval (C3 #11) with the next keychain seq, like a message:
   * only the computer can open it, and the server cannot forge or reuse it.
   */
  async sealDecision(
    agentId: string,
    approvalId: string,
    decision: 'approve' | 'deny',
  ): Promise<SealedEnvelopeV1> {
    const ctx = await this.context(agentId).catch(() => undefined);
    if (ctx === undefined) throw new SealError('not_computer');
    const trusted = await loadTrusted(this.deps.store).catch(() => ctx.trusted);
    this.trusted = trusted;
    ctx.trusted = trusted;
    if (
      this.removedSelf ||
      this.reinstalled.has(agentId) ||
      !hasComputerFor(trusted, ctx.accountId)
    )
      throw new SealError('pair_again');
    let seq: number;
    try {
      seq = await nextSeq(this.deps.store);
    } catch {
      throw new SealError('seal_failed');
    }
    try {
      return sealOutgoingControl(
        { ...ctx, nextSeq: () => seq },
        { kind: 'approval_decision', approval_id: approvalId, decision },
      );
    } catch {
      throw new SealError('seal_failed');
    }
  }

  /** The text of a message this phone sealed itself, for a queued message after a restart. */
  async openOwn(agentId: string, sealed: SealedEnvelopeV1): Promise<string | undefined> {
    const ctx = await this.context(agentId);
    if (ctx === undefined) return undefined;
    // A throwaway context: reading the queue must not move the chat's replay window.
    const scratch = createPhoneContext({ ...ctx, seen: undefined });
    const opened = openMessage(scratch, {
      id: 'msg_aaaaaaaaaaaaaaaaaaaa',
      kind: 'sealed',
      author: 'user',
      sealed: [sealed],
    } as unknown as SealedThreadMessage);
    return opened.state === 'ok' ? opened.text : undefined;
  }

  /** A chat's last message for the Chats list, opened in a throwaway context; never throws. */
  async openPreview(agentId: string, message: ThreadMessage): Promise<string | undefined> {
    if (message.kind !== 'sealed') return undefined;
    try {
      const ctx = await this.context(agentId);
      if (ctx === undefined) return undefined;
      const opened = openMessage(createPhoneContext({ ...ctx, seen: undefined }), message);
      return opened.state === 'ok' ? opened.text : undefined;
    } catch {
      return undefined;
    }
  }

  /** The whole chat for an export, opened in a throwaway context so the chat's window stays. */
  async openForExport(
    agentId: string,
    messages: readonly ThreadMessage[],
  ): Promise<OpenedMessage[] | undefined> {
    const ctx = await this.context(agentId);
    if (ctx === undefined) return undefined;
    const scratch = createPhoneContext({ ...ctx, seen: undefined });
    // A whole chat can take seconds on a phone: open it in steps so the screen keeps answering.
    return openMessagesInSteps(
      scratch,
      messages.filter((m): m is SealedThreadMessage => m.kind === 'sealed'),
      () => new Promise((resolve) => setTimeout(resolve, 0)),
    );
  }

  /** Opens a chat's sealed messages in order; undefined until the chat's context is loaded. */
  open(agentId: string, messages: readonly ThreadMessage[]): OpenedMessage[] | undefined {
    const ctx = this.contexts.get(agentId);
    if (ctx === undefined) return undefined;
    const sealed = messages.filter((m): m is SealedThreadMessage => m.kind === 'sealed');
    const keyless = (m: SealedThreadMessage) =>
      m.sealed.every((e) => !e.keys.some((k) => k.device === ctx.me.deviceId));
    // A reply sealed without this phone: the computer may no longer trust it (removed elsewhere).
    if (sealed.some((m) => m.author === 'agent' && keyless(m))) void this.checkRemoved(agentId);
    // A message with no key for this phone may have one from another phone: read them first.
    if (
      sealed.some((m) => keyless(m) && ctx.rewraps?.has(m.id) !== true) &&
      this.askRewraps(agentId, ctx)
    )
      return undefined;
    // A sender this chat does not know yet (a phone approved since it loaded): read the list again.
    // Only a message this phone has a key for: one it cannot unwrap waits for nothing here.
    const readable = sealed.filter((m) => !keyless(m) || ctx.rewraps?.has(m.id) === true);
    if (this.askSenders(agentId, ctx, readable)) return undefined;
    const opened = openMessages(ctx, sealed);
    // None of the chat's messages carries a key for this phone, nor a re-wrap: its keys were lost.
    if (sealed.length > 0 && sealed.every((m) => keyless(m) && ctx.rewraps?.has(m.id) !== true))
      this.lostKeys.add(agentId);
    else this.lostKeys.delete(agentId);
    // A chat opens again on every change: write the replay state only when it moved.
    if (ctx.changed) {
      ctx.changed = false;
      this.save(agentId, ctx);
    }
    const failed = opened.filter((m) => m.state === 'couldnt_open').length;
    if (failed > 0) this.deps.log?.('e2e_couldnt_open', { count: failed });
    return opened;
  }

  /**
   * Starts reading the chat's re-wraps, at most once per chat in `REWRAP_ASK_MS`. True while a
   * read runs: the caller waits (`context`) and opens the chat again with them.
   */
  private askRewraps(agentId: string, ctx: PhoneSealContext): boolean {
    const api = this.deps.rewraps;
    if (api === undefined) return false;
    if (this.rewrapLoading.has(agentId)) return true;
    const now = Date.now();
    const asked = this.rewrapAsked.get(agentId);
    if (asked !== undefined && now - asked < REWRAP_ASK_MS) return false;
    this.rewrapAsked.set(agentId, now);
    const work = readRewraps(api, agentId, ctx.me.deviceId)
      .then((found) => {
        if (found === undefined) return;
        ctx.rewraps = found;
        this.deps.log?.('e2e_rewraps_read', { count: found.size });
      })
      .catch(() => undefined)
      .finally(() => this.rewrapLoading.delete(agentId));
    this.rewrapLoading.set(agentId, work);
    return true;
  }

  /**
   * Starts reading the trusted list again when a message comes from a device this chat does not
   * know: the keychain first, then the server's list through the usual trust rules. Each unknown
   * device is looked up at most once per chat in `REMOVED_CHECK_MS`; true while a read runs.
   */
  private askSenders(
    agentId: string,
    ctx: PhoneSealContext,
    sealed: readonly SealedThreadMessage[],
  ): boolean {
    if (this.senderLoading.has(agentId)) return true;
    const known = new Set([ctx.me.deviceId, ...ctx.trusted.map((d) => d.id)]);
    const now = Date.now();
    const asked = this.senderAsked.get(agentId) ?? new Map<string, number>();
    const unknown = new Set<string>();
    for (const m of sealed) {
      const sender = m.sealed[0]?.sender_device;
      if (sender === undefined || known.has(sender)) continue;
      const at = asked.get(sender);
      if (at === undefined || now - at >= REMOVED_CHECK_MS) unknown.add(sender);
    }
    if (unknown.size === 0) return false;
    for (const id of unknown) asked.set(id, now);
    this.senderAsked.set(agentId, asked);
    const generation = this.generation;
    const stale = () => generation !== this.generation || this.removedSelf;
    const work = (async () => {
      const trusted = await loadTrusted(this.deps.store);
      if (stale()) return;
      this.trusted = trusted;
      ctx.trusted = trusted;
      if ([...unknown].every((id) => trusted.some((d) => d.id === id))) return;
      await this.readDevices(agentId, ctx.accountId, ctx.me, () => generation !== this.generation);
      if (!stale()) ctx.trusted = this.trusted;
    })().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SENDER_LOOKUP_MS);
    });
    const held: Promise<void> = Promise.race([work, deadline]).finally(() => {
      clearTimeout(timer);
      if (this.senderLoading.get(agentId) === held) this.senderLoading.delete(agentId);
    });
    this.senderLoading.set(agentId, held);
    return true;
  }

  private save(agentId: string, ctx: PhoneSealContext): void {
    this.saving = this.saving
      .then(async () => {
        const all = { ...(await this.loadSaved()), [agentId]: seenToSave(ctx) };
        this.saved = Promise.resolve(all);
        await this.deps.replay.save(all);
      })
      .catch(() => {
        // Not saved: the next open tries again, as it did before only changes were saved.
        ctx.changed = true;
      });
  }

  /**
   * Signing out: the replay state goes with the chats, and the device key, its counter and the
   * trusted computers go too, so the next account never seals to this account's computer.
   */
  async forget(): Promise<void> {
    this.generation++;
    this.loading.clear();
    this.contexts.clear();
    this.reinstalled.clear();
    this.lostKeys.clear();
    this.rewrapAsked.clear();
    this.removedChecked.clear();
    this.senderAsked.clear();
    this.removedSelf = false;
    this.removedDevice = undefined;
    this.removedAt = undefined;
    this.known = undefined;
    this.trusted = [];
    await this.wipeStored();
  }
}

/** The phone's private chat keys in the keychain, removed on sign-out. */
export async function forgetPrivateDevice(store: SecureKeyValue): Promise<void> {
  // An approve still waiting on the server would otherwise save its record again after the keys
  // went (`clearAfterApproves`).
  await clearAfterApproves(store, async () => {
    await Promise.all([
      forgetDeviceKey(store).catch(() => undefined),
      forgetTrusted(store).catch(() => undefined),
      // Re-wrap jobs share this phone's keys with a new phone, and an approve left to finish
      // vouches for one: both go with the keys.
      store.deleteItemAsync(REWRAP_JOBS_KEY).catch(() => undefined),
      store.deleteItemAsync(PENDING_APPROVE_KEY_NAME).catch(() => undefined),
      // Voice-note consent is asked again after signing back in.
      store.deleteItemAsync(VOICE_CONSENT_KEY).catch(() => undefined),
      // The Chats list's opened previews go with the keys that opened them.
      forgetListPreviews(store).catch(() => undefined),
    ]);
  });
}
