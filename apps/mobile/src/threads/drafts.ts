import { z } from 'zod';

import { COMPOSER_LIMIT } from '../components/chat/composer-state';

import type { OutboxTimers } from './outbox';
import type { JsonStore } from './outbox-storage';

const SAVE_DEBOUNCE_MS = 300;
const MAX_DRAFTS = 200;

const storedDrafts = z.object({
  version: z.literal(1),
  drafts: z.record(z.string().min(1).max(100), z.string().max(COMPOSER_LIMIT)),
});

/**
 * Whether a chat is private: true, false, or undefined while the chat list has not loaded.
 * A private chat's draft stays in memory only (C3 #11) and is lost if the app is killed.
 */
export type DraftPrivacy = (agentId: string) => boolean | undefined;

/** Unsent composer text per agent, kept across launches. Text only, never attachments. */
export class DraftStore {
  private drafts = new Map<string, string>();
  /** What the file holds now, so a chat not yet known to be ordinary keeps its old saved text. */
  private persisted = new Map<string, string>();
  private loaded = false;
  private disposed = false;
  private timer: unknown;
  private saving: Promise<void> = Promise.resolve();
  readonly hydrated: Promise<void>;

  constructor(
    private readonly store: JsonStore,
    private readonly timers: OutboxTimers,
    private readonly isPrivate: DraftPrivacy = () => false,
  ) {
    this.hydrated = this.hydrate();
  }

  /** The saved draft, once storage has been read. */
  async get(agentId: string): Promise<string> {
    await this.hydrated;
    return this.drafts.get(agentId) ?? '';
  }

  set(agentId: string, text: string): void {
    if (this.disposed) return;
    const value = text.slice(0, COMPOSER_LIMIT);
    if ((this.drafts.get(agentId) ?? '') === value) return;
    if (value) this.drafts.set(agentId, value);
    else this.drafts.delete(agentId);
    this.scheduleSave();
  }

  /** Clearing a chat drops its draft. */
  forget(agentId: string): void {
    this.set(agentId, '');
  }

  /** Signing out: removes every draft. */
  async clear(): Promise<void> {
    this.disposed = true;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.drafts.clear();
    await this.saving.then(() => this.store.remove()).catch(() => undefined);
  }

  /** The chat list changed: a draft saved for a chat that is now private leaves the file. */
  privacyChanged(): void {
    for (const agentId of this.persisted.keys())
      if (this.isPrivate(agentId) === true) return this.scheduleSave();
    for (const agentId of this.drafts.keys())
      if (this.isPrivate(agentId) === false && !this.persisted.has(agentId))
        return this.scheduleSave();
  }

  /**
   * Writes the latest drafts now. A private chat's draft is never written; a chat not known yet
   * keeps only what the file already held, until the chat list says it is ordinary.
   */
  flush(): Promise<void> {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.loaded || this.disposed) return this.saving;
    const kept: [string, string][] = [];
    for (const [agentId, text] of this.drafts) {
      const privacy = this.isPrivate(agentId);
      if (privacy === false) kept.push([agentId, text]);
      else if (privacy === undefined) {
        const old = this.persisted.get(agentId);
        if (old !== undefined) kept.push([agentId, old]);
      }
    }
    const drafts = Object.fromEntries(kept.slice(-MAX_DRAFTS));
    this.persisted = new Map(Object.entries(drafts));
    this.saving = this.saving
      .then(() =>
        Object.keys(drafts).length ? this.store.save({ version: 1, drafts }) : this.store.remove(),
      )
      .catch(() => undefined);
    return this.saving;
  }

  private scheduleSave(): void {
    if (!this.loaded || this.disposed) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  private async hydrate(): Promise<void> {
    try {
      const raw = await this.store.load();
      if (raw !== undefined) {
        const parsed = storedDrafts.safeParse(raw);
        if (parsed.success) {
          this.persisted = new Map(Object.entries(parsed.data.drafts));
          // Typing before the file was read wins over the saved text.
          for (const [agentId, text] of Object.entries(parsed.data.drafts))
            if (!this.drafts.has(agentId)) this.drafts.set(agentId, text);
        } else await this.store.remove();
      }
    } catch {
      await this.store.remove().catch(() => undefined);
    }
    if (this.disposed) return;
    this.loaded = true;
    if (this.drafts.size) this.scheduleSave();
  }
}
