import {
  listeningProviderSchema,
  speechProviderSchema,
  type ListeningProvider,
  type SpeechProvider,
} from '@twring/contracts';
import { z } from 'zod';

import { sealedSecretSchema, speechKeyAad, type CredentialCipher } from './cipher';
import { MemoryCollection, StoreCorruptError, type Collection } from './collection';

export { speechKeyAad };

export const speechKeyRecordSchema = z.object({
  user_id: z.string().min(1),
  provider: speechProviderSchema,
  sealed: sealedSecretSchema,
  /** The last four characters of the key, shown so a person can tell which key is saved. */
  last4: z.string().length(4),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  verified_at: z.iso.datetime(),
});
export type SpeechKeyRecord = z.infer<typeof speechKeyRecordSchema>;

/** One person's non-secret speech settings (speech-settings.json). */
export const speechSettingsRecordSchema = z.object({
  user_id: z.string().min(1),
  listening: listeningProviderSchema,
});
export type SpeechSettingsRecord = z.infer<typeof speechSettingsRecordSchema>;

/** What the app may see about a saved key. Never the key itself. */
export interface SpeechKeySummary {
  provider: SpeechProvider;
  last4: string;
  added_at: string;
  verified_at: string;
}

export interface SpeechKeyVault {
  put(userId: string, provider: SpeechProvider, key: string, verifiedAt: Date): Promise<void>;
  /** Throws CredentialDecryptError when the stored key cannot be opened. */
  get(userId: string, provider: SpeechProvider): Promise<string | undefined>;
  list(userId: string): Promise<SpeechKeySummary[]>;
  delete(userId: string, provider: SpeechProvider): Promise<void>;
  /** Removes every speech key this user saved; resolves how many. */
  deleteAllForUser(userId: string): Promise<number>;
  /** Which provider hears the person; Deepgram until they choose. */
  getListening(userId: string): Promise<ListeningProvider>;
  setListening(userId: string, provider: ListeningProvider): Promise<void>;
}

/** Defence in depth: the contracts schema enforces the real floor; this keeps last4 from exposing a key. */
const MIN_KEY_LENGTH = 8;

export class EncryptedSpeechKeyVault implements SpeechKeyVault {
  /** Told when speech-settings.json is unreadable and the default is used (main.ts logs it). */
  static onSettingsUnreadable: (() => void) | undefined;

  constructor(
    private readonly rows: Collection<SpeechKeyRecord>,
    private readonly cipher: CredentialCipher,
    private readonly now: () => Date = () => new Date(),
    private readonly settings: Collection<SpeechSettingsRecord> = new MemoryCollection(),
  ) {}

  put(userId: string, provider: SpeechProvider, key: string, verifiedAt: Date): Promise<void> {
    if (key.length < MIN_KEY_LENGTH) {
      return Promise.reject(new Error('speech key is too short'));
    }
    const sealed = this.cipher.seal(key, speechKeyAad(userId, provider));
    const stamp = this.now().toISOString();
    return this.rows.update((items) => {
      const existing = items.find((row) => row.user_id === userId && row.provider === provider);
      const others = items.filter((row) => row !== existing);
      const record: SpeechKeyRecord = {
        user_id: userId,
        provider,
        sealed,
        last4: key.slice(-4),
        created_at: existing?.created_at ?? stamp,
        updated_at: stamp,
        verified_at: verifiedAt.toISOString(),
      };
      return { items: [...others, record], result: undefined };
    });
  }

  async get(userId: string, provider: SpeechProvider): Promise<string | undefined> {
    const row = (await this.rows.read()).find(
      (r) => r.user_id === userId && r.provider === provider,
    );
    return row && this.cipher.open(row.sealed, speechKeyAad(userId, provider));
  }

  async list(userId: string): Promise<SpeechKeySummary[]> {
    return (await this.rows.read())
      .filter((row) => row.user_id === userId)
      .map((row) => ({
        provider: row.provider,
        last4: row.last4,
        added_at: row.created_at,
        verified_at: row.verified_at,
      }));
  }

  async delete(userId: string, provider: SpeechProvider): Promise<void> {
    await this.rows.update((items) => ({
      items: items.filter((row) => row.user_id !== userId || row.provider !== provider),
      result: undefined,
    }));
    // The setting is only ever read through getListening, which ignores a choice with no key,
    // so this tidy-up is not what keeps the invariant; a failure here must not fail the delete.
    if (provider !== 'deepgram' && provider !== 'xai') return;
    try {
      await this.settings.update((items) => ({
        items: items.filter((row) => row.user_id !== userId || row.listening !== provider),
        result: undefined,
      }));
    } catch (error) {
      if (!(error instanceof StoreCorruptError)) throw error;
      EncryptedSpeechKeyVault.onSettingsUnreadable?.();
    }
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const removed = await this.rows.update((items) => {
      const kept = items.filter((row) => row.user_id !== userId);
      return { items: kept, result: items.length - kept.length };
    });
    try {
      await this.clearListening(userId);
    } catch (error) {
      // The keys are already gone and getListening ignores a row with no key: finish the delete.
      if (!(error instanceof StoreCorruptError)) throw error;
      EncryptedSpeechKeyVault.onSettingsUnreadable?.();
    }
    return removed;
  }

  /**
   * The choice counts only while its key exists: otherwise the provider the person still owns,
   * else the default. Reading the keys here (not trusting the stored row) is what keeps a choice
   * from outliving its key, however saves and removals interleave.
   */
  async getListening(userId: string): Promise<ListeningProvider> {
    let chosen: ListeningProvider | undefined;
    try {
      chosen = (await this.settings.read()).find((r) => r.user_id === userId)?.listening;
    } catch (error) {
      if (!(error instanceof StoreCorruptError)) throw error;
      EncryptedSpeechKeyVault.onSettingsUnreadable?.();
    }
    const owned = new Set(
      (await this.rows.read()).filter((row) => row.user_id === userId).map((row) => row.provider),
    );
    if (chosen !== undefined && owned.has(chosen)) return chosen;
    if (owned.has('deepgram')) return 'deepgram';
    return owned.has('xai') ? 'xai' : 'deepgram';
  }

  setListening(userId: string, provider: ListeningProvider): Promise<void> {
    return this.settings.update((items) => ({
      items: [
        ...items.filter((row) => row.user_id !== userId),
        { user_id: userId, listening: provider },
      ],
      result: undefined,
    }));
  }

  private clearListening(userId: string): Promise<void> {
    return this.settings.update((items) => ({
      items: items.filter((row) => row.user_id !== userId),
      result: undefined,
    }));
  }
}
