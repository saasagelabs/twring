import {
  MAX_USER_MESSAGE_CHARS,
  type SealedEnvelopeV1,
  type ThreadMessage,
} from '@twring/contracts';
import { z } from 'zod';

import type { SecureKeyValue } from '../auth/storage';
import type { JsonStore } from '../threads/outbox-storage';
import { forgetDeviceKey, loadOrCreateDeviceKey, nextSeq } from './device-key';
import { forgetTrusted, loadTrusted, type TrustedDevice } from './pairing';
import {
  aadIdsFor,
  createPhoneContext,
  openMessage,
  openMessages,
  sealOutgoing,
  seenToSave,
  type OpenedMessage,
  type PhoneSealContext,
  type SavedReplay,
  type SealedThreadMessage,
} from './sealed-thread';
import type { PhoneQuote } from './private-quote';
import { hasComputer } from './private-state';

/**
 * Private chats in the chat data layer (ADR-044): seals what the phone sends and opens what it
 * shows. Opened text lives in memory only; what reaches the phone's disk is the sealed envelope
 * and the replay state (device ids, seqs and message ids), never text. Logs carry counts and
 * ids only.
 */

/** Why a message could not be sealed; it then stays in the outbox as failed, never sent as text. */
export type SealFailure = 'pair_again' | 'not_computer' | 'too_long' | 'seal_failed';
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
  log?: (event: string, fields?: Record<string, string | number>) => void;
}

const savedSchema = z.record(
  z.string().max(100),
  z.object({
    floor: z.record(z.string().max(64), z.number().int().nonnegative()),
    ids: z.record(z.string().max(100), z.string().max(64)),
  }),
);

export class PrivateChats {
  private readonly contexts = new Map<string, PhoneSealContext>();
  private readonly loading = new Map<string, Promise<PhoneSealContext | undefined>>();
  private saved?: Promise<Record<string, SavedReplay>>;
  private trusted: TrustedDevice[] = [];
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PrivateChatDeps) {}

  /** No computer to send to: the key was replaced, or pairing was lost (P3b ruling 3). */
  pairAgain(): boolean {
    return !hasComputer(this.trusted);
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
    if (ready) return Promise.resolve(ready);
    let work = this.loading.get(agentId);
    if (!work) {
      work = (async () => {
        const [me, trusted, address, saved] = await Promise.all([
          loadOrCreateDeviceKey(this.deps.store, this.deps.log),
          loadTrusted(this.deps.store),
          this.deps.addressOf(agentId),
          this.loadSaved(),
        ]);
        this.trusted = trusted;
        const ids = address === undefined ? undefined : aadIdsFor(address);
        if (ids === undefined) return undefined;
        const ctx = createPhoneContext({
          ...ids,
          me,
          trusted,
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
        .finally(() => this.loading.delete(agentId));
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
  async seal(agentId: string, text: string, quote?: PhoneQuote): Promise<SealedEnvelopeV1> {
    if (text.length > MAX_USER_MESSAGE_CHARS) throw new SealError('too_long');
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
    if (!hasComputer(trusted)) throw new SealError('pair_again');
    let seq: number;
    try {
      seq = await nextSeq(this.deps.store);
    } catch {
      throw new SealError('seal_failed');
    }
    try {
      return sealOutgoing(
        { ...ctx, nextSeq: () => seq },
        { text, ...(quote !== undefined && { quote }) },
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

  /** The whole chat for an export, opened in a throwaway context so the chat's window stays. */
  async openForExport(
    agentId: string,
    messages: readonly ThreadMessage[],
  ): Promise<OpenedMessage[] | undefined> {
    const ctx = await this.context(agentId);
    if (ctx === undefined) return undefined;
    const scratch = createPhoneContext({ ...ctx, seen: undefined });
    return openMessages(
      scratch,
      messages.filter((m): m is SealedThreadMessage => m.kind === 'sealed'),
    );
  }

  /** Opens a chat's sealed messages in order; undefined until the chat's context is loaded. */
  open(agentId: string, messages: readonly ThreadMessage[]): OpenedMessage[] | undefined {
    const ctx = this.contexts.get(agentId);
    if (ctx === undefined) return undefined;
    const sealed = messages.filter((m): m is SealedThreadMessage => m.kind === 'sealed');
    const opened = openMessages(ctx, sealed);
    this.save(agentId, ctx);
    const failed = opened.filter((m) => m.state === 'couldnt_open').length;
    if (failed > 0) this.deps.log?.('e2e_couldnt_open', { count: failed });
    return opened;
  }

  private save(agentId: string, ctx: PhoneSealContext): void {
    this.saving = this.saving
      .then(async () => {
        const all = { ...(await this.loadSaved()), [agentId]: seenToSave(ctx) };
        this.saved = Promise.resolve(all);
        await this.deps.replay.save(all);
      })
      .catch(() => undefined);
  }

  /**
   * Signing out: the replay state goes with the chats, and the device key, its counter and the
   * trusted computers go too, so the next account never seals to this account's computer.
   */
  async forget(): Promise<void> {
    this.contexts.clear();
    this.trusted = [];
    this.saved = Promise.resolve({});
    await this.saving;
    await Promise.all([
      this.deps.replay.remove().catch(() => undefined),
      forgetPrivateDevice(this.deps.store),
    ]);
  }
}

/** The phone's private chat keys in the keychain, removed on sign-out. */
export async function forgetPrivateDevice(store: SecureKeyValue): Promise<void> {
  await Promise.all([
    forgetDeviceKey(store).catch(() => undefined),
    forgetTrusted(store).catch(() => undefined),
  ]);
}
